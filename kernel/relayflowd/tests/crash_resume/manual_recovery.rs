//! Appendix A rule 4 against the real daemon: a `manual` agent step whose
//! attached WORKER reports its own transport loss through `step.complete`
//! parks as `needs_human`, is not redispatched — before or after the daemon
//! itself is killed and resumed — and is redispatched by a human answer on the
//! pinned revision. The kernel-noticed death (`abandonment_actions`) already
//! parked; this pins the worker-reported one to the same behaviour.

use std::time::Duration;

use relayflowd_core::{CompletionReason, Disposition, EntryType, StepCompletedPayload};
use serde_json::{Value, json};

use super::{
    llm_support::{LlmFixture, ProtocolClient, ServerGuard, spawn_resume},
    support::journal_entries,
};

fn manual_spec(max_transport_retries: u32) -> Value {
    json!({"steps": [{
        "id": "edit",
        "type": "agent",
        "instruction": "edit",
        "recovery_mode": "manual",
        "max_iterations": 2,
        "retry": {
            "initial_backoff_ms": 0,
            "max_backoff_ms": 0,
            "multiplier": 1,
            "jitter_percent": 0,
            "max_transport_retries": max_transport_retries
        },
        "surfaces": {"workspace": [{"surface": "repo"}]}
    }]})
}

fn attached_agent(fixture: &LlmFixture, id: &str) -> ProtocolClient {
    let mut worker = ProtocolClient::connect(&fixture.socket());
    worker
        .request(
            "worker.attach",
            json!({
                "worker_id": id,
                "step_types": ["agent"],
                "pins": {"workspace": [{"surface": "repo", "revision_id": "rev-0"}]}
            }),
        )
        .unwrap();
    worker
}

/// The shape the SDK worker sends when its direct transport is lost.
fn report_transport_loss(worker: &mut ProtocolClient, dispatch: &Value, reason: &str) -> Value {
    worker
        .request(
            "step.complete",
            json!({
                "run_id": dispatch["run_id"],
                "step_id": dispatch["step_id"],
                "attempt": dispatch["attempt"],
                "idempotency_key": dispatch["idempotency_key"],
                "completionReason": reason,
                "output": {"exit_code": null, "stdout_tail": "", "stderr_tail": "killed"},
                "started_pins": dispatch["pins"],
                "trajectory_tail": {"transport": {"cause": "signal_close"}}
            }),
        )
        .unwrap()
}

/// Probe for silence: no `step.dispatch` reaches this worker within the
/// window (same shape as `parallel_lifecycle.rs`).
fn assert_no_dispatch(worker: &mut ProtocolClient, what: &str) {
    worker.override_read_timeout(Some(Duration::from_millis(200)));
    assert!(
        worker.event("step.dispatch").is_err(),
        "{what}: a parked manual step must not be redispatched"
    );
    worker.override_read_timeout(None);
}

fn run_snapshot(fixture: &LlmFixture, run_id: &Value) -> Value {
    ProtocolClient::connect(&fixture.socket())
        .request("run.get", json!({"run_id": run_id}))
        .unwrap()
}

#[test]
fn manual_recovery_parks_a_worker_reported_loss_across_daemon_restart_until_a_human_answers() {
    for (reason, max_transport_retries, expected) in [
        ("crashed", 1, CompletionReason::Crashed),
        ("lease_expired", 1, CompletionReason::LeaseExpired),
        // No transport budget: still a park, never a terminal `step_done`.
        ("crashed", 0, CompletionReason::Crashed),
    ] {
        let case = format!("{reason} with max_transport_retries={max_transport_retries}");
        let fixture = LlmFixture::parallel(&format!("manual-{reason}-{max_transport_retries}"));
        let mut server = ServerGuard::start(&fixture);
        let mut worker = attached_agent(&fixture, "manual-agent");
        let started = ProtocolClient::connect(&fixture.socket())
            .request(
                "run.start",
                json!({"spec": manual_spec(max_transport_retries)}),
            )
            .unwrap();
        let run_id = started["run_id"].clone();
        let first = worker.event("step.dispatch").unwrap();
        assert_eq!(first["attempt"], 1, "{case}");
        assert_eq!(
            first["pins"]["workspace"][0]["revision_id"], "rev-0",
            "{case}"
        );

        let parked = report_transport_loss(&mut worker, &first, reason);
        assert_eq!(parked["status"], "parked", "{case}: {parked}");
        assert_no_dispatch(&mut worker, &case);

        let entries = journal_entries(&fixture.data_dir).unwrap();
        let starts = entries
            .iter()
            .filter(|entry| entry.entry_type == EntryType::StepAttemptStarted)
            .count();
        assert_eq!(starts, 1, "{case}: exactly one attempt was started");
        let completed = entries
            .iter()
            .find(|entry| entry.entry_type == EntryType::StepCompleted)
            .unwrap_or_else(|| panic!("{case}: the reported loss is journaled"));
        let payload: StepCompletedPayload =
            serde_json::from_value(completed.payload.clone()).unwrap();
        assert_eq!(payload.completion_reason, expected, "{case}");
        assert_eq!(payload.disposition, Disposition::Park, "{case}");
        let wait = entries
            .iter()
            .find(|entry| entry.entry_type == EntryType::WaitHuman)
            .unwrap_or_else(|| panic!("{case}: the park journals a wait.human"));
        assert_eq!(wait.step_id.as_deref(), Some("edit"), "{case}");
        assert_eq!(wait.attempt, Some(1), "{case}");
        assert_eq!(wait.payload["diff_ref"], "repo@rev-0..current", "{case}");
        let wait_id = wait.payload["wait_id"].as_str().unwrap().to_owned();
        let snapshot = run_snapshot(&fixture, &run_id);
        assert_eq!(snapshot["status"], "parked", "{case}");
        assert_eq!(snapshot["steps"]["edit"]["state"], "needs_human", "{case}");
        let journaled = entries.len();

        // Kill the daemon with the run parked, restart, resume: the park must
        // hold — no redispatch to the replacement worker and no new entries.
        server.kill();
        drop(worker);
        let _restarted = ServerGuard::start(&fixture);
        let mut replacement = attached_agent(&fixture, "manual-agent-after-restart");
        let resume = spawn_resume(&fixture, run_id.as_str().unwrap())
            .wait_with_output()
            .unwrap();
        assert!(resume.status.success(), "{case}: resume failed: {resume:?}");
        let outcome: Value = serde_json::from_slice(&resume.stdout).unwrap();
        assert_eq!(outcome["status"], "parked", "{case}: {outcome}");
        assert_no_dispatch(&mut replacement, &format!("{case} after restart"));
        assert_eq!(
            journal_entries(&fixture.data_dir).unwrap().len(),
            journaled,
            "{case}: resume must not append to a cleanly parked run"
        );
        assert_eq!(
            run_snapshot(&fixture, &run_id)["steps"]["edit"]["state"],
            "needs_human",
            "{case}"
        );

        // The human's answer, and only that, ends the park; the replacement
        // attempt starts on the pinned revision under the same effect key.
        let answered = ProtocolClient::connect(&fixture.socket())
            .request(
                "event.emit",
                json!({
                    "run_id": run_id,
                    "event_key": wait_id,
                    "payload": {"answer": "retry", "answeredBy": "khaliq"}
                }),
            )
            .unwrap();
        assert_eq!(answered["matched"], 1, "{case}: {answered}");
        let second = replacement.event("step.dispatch").unwrap();
        assert_eq!(second["attempt"], 2, "{case}");
        assert_eq!(
            second["pins"]["workspace"][0]["revision_id"], "rev-0",
            "{case}"
        );
        assert_eq!(
            second["idempotency_key"], first["idempotency_key"],
            "{case}"
        );
    }
}
