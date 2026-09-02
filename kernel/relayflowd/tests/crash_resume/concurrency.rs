//! Live-server scheduling races: per-run serialization of mutating verbs and
//! lease-aware resume. Both run against the real `relayflowd serve` binary
//! over the real socket.

use std::{
    sync::{Arc, Barrier},
    thread,
    time::Duration,
};

use relayflowd_core::{CompletionReason, EntryType, StepCompletedPayload};
use relayflowd_journal::Registry;
use serde_json::json;

use super::{
    llm_support::{
        LlmFixture, ProtocolClient, ServerGuard, attached_worker, complete, spawn_resume, start_run,
    },
    support::journal_entries,
};

#[test]
fn run_start_dispatches_every_independent_lane_before_any_completion() {
    let fixture = LlmFixture::parallel("socket-fan-out");
    let _server = ServerGuard::start(&fixture);
    let mut worker = attached_worker(&fixture, "parallel-stub");
    let run_id = start_run(&fixture);

    worker.set_read_timeout(Some(Duration::from_secs(1)));
    let first = worker.event("step.dispatch").unwrap();
    let second = worker
        .event("step.dispatch")
        .expect("both independent lanes must dispatch before either completes");
    worker.set_read_timeout(None);
    assert_eq!(first["step_id"], "lane-b");
    assert_eq!(second["step_id"], "lane-a");

    let original_deadline = second["lease_deadline_ms"].as_i64().unwrap();
    let heartbeat = worker
        .request(
            "step.heartbeat",
            json!({
                "run_id": run_id,
                "step_id": first["step_id"],
                "attempt": first["attempt"],
                "lease_id": first["lease_id"]
            }),
        )
        .unwrap();
    let renewed_deadline = heartbeat["lease_deadline_ms"].as_i64().unwrap();
    assert!(renewed_deadline >= original_deadline);
    let registry = Registry::open(fixture.data_dir.join("relayflowd.sqlite3")).unwrap();
    assert_eq!(
        registry.lookup(&run_id).unwrap().unwrap().next_wake_at_ms,
        Some(original_deadline),
        "one lane's heartbeat must not hide its sibling's earlier deadline"
    );

    // A live resume sees both leases held and must neither abandon nor
    // redispatch either attempt.
    let mut control = ProtocolClient::connect(&fixture.data_dir.join("relayflowd.sock"));
    let resumed = control
        .request("run.resume", json!({"run_id": run_id}))
        .unwrap();
    assert_eq!(resumed["status"], "parked");
    let starts = journal_entries(&fixture.data_dir)
        .unwrap()
        .into_iter()
        .filter(|entry| entry.entry_type == EntryType::StepAttemptStarted)
        .count();
    assert_eq!(starts, 2, "live resume must preserve both original leases");

    // Independent completions may arrive in reverse authored order. Once the
    // earlier sibling finishes, the registry follows the remaining renewal.
    let parked = complete(&mut worker, &second, json!({"answer": "a"})).unwrap();
    assert_eq!(parked["status"], "parked");
    assert_eq!(
        registry.lookup(&run_id).unwrap().unwrap().next_wake_at_ms,
        Some(renewed_deadline)
    );
    let completed = complete(&mut worker, &first, json!({"answer": "b"})).unwrap();
    assert_eq!(completed["status"], "completed");
}

#[test]
fn server_restart_recovers_every_parallel_lease_without_duplicate_success() {
    let fixture = LlmFixture::parallel("socket-crash-resume");
    let mut server = ServerGuard::start(&fixture);
    let mut first_worker = attached_worker(&fixture, "before-crash");
    let run_id = start_run(&fixture);
    let first_attempts = [
        first_worker.event("step.dispatch").unwrap(),
        first_worker.event("step.dispatch").unwrap(),
    ];
    server.kill();
    drop(first_worker);

    let _restarted = ServerGuard::start(&fixture);
    let mut replacement = attached_worker(&fixture, "after-crash");
    let resume = spawn_resume(&fixture, &run_id);
    let replacements = [
        replacement.event("step.dispatch").unwrap(),
        replacement.event("step.dispatch").unwrap(),
    ];
    assert_eq!(replacements[0]["attempt"], 2);
    assert_eq!(replacements[1]["attempt"], 2);

    for original in &first_attempts {
        let replacement_dispatch = replacements
            .iter()
            .find(|dispatch| dispatch["step_id"] == original["step_id"])
            .unwrap();
        assert_eq!(
            replacement_dispatch["idempotency_key"], original["idempotency_key"],
            "a resumed lane keeps its exactly-once effect key"
        );
    }

    complete(&mut replacement, &replacements[0], json!({"answer": "b"})).unwrap();
    complete(&mut replacement, &replacements[1], json!({"answer": "a"})).unwrap();
    let output = resume.wait_with_output().unwrap();
    assert!(output.status.success(), "resume failed: {output:?}");

    let entries = journal_entries(&fixture.data_dir).unwrap();
    for step_id in ["lane-b", "lane-a"] {
        let completions = entries
            .iter()
            .filter(|entry| {
                entry.entry_type == EntryType::StepCompleted
                    && entry.step_id.as_deref() == Some(step_id)
            })
            .map(|entry| {
                serde_json::from_value::<StepCompletedPayload>(entry.payload.clone()).unwrap()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            completions
                .iter()
                .filter(|payload| payload.completion_reason == CompletionReason::Success)
                .count(),
            1,
            "each lane succeeds exactly once"
        );
        assert!(completions.iter().any(|payload| matches!(
            payload.completion_reason,
            CompletionReason::Crashed | CompletionReason::LeaseExpired
        )));
    }
}

/// Finding 1: two concurrent `run.resume` calls for the same runnable run must
/// not both see the step Runnable — the scheduling decision is serialized per
/// run, so exactly one attempt is journaled and dispatched.
#[test]
fn concurrent_resumes_lease_exactly_one_attempt() {
    let fixture = LlmFixture::new("concurrent-resume", false);
    let _server = ServerGuard::start(&fixture);
    // Parked with the llm step runnable: no worker was attached at start.
    let run_id = start_run(&fixture);
    let mut worker = attached_worker(&fixture, "race-stub");

    let socket = fixture.data_dir.join("relayflowd.sock");
    let barrier = Arc::new(Barrier::new(2));
    let resumes = (0..2)
        .map(|_| {
            let socket = socket.clone();
            let run_id = run_id.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                let mut client = ProtocolClient::connect(&socket);
                barrier.wait();
                client
                    .request("run.resume", json!({"run_id": run_id}))
                    .unwrap()
            })
        })
        .collect::<Vec<_>>();
    for resume in resumes {
        resume.join().unwrap();
    }

    let dispatch = worker.event("step.dispatch").unwrap();
    assert_eq!(dispatch["attempt"], 1);
    let done = complete(&mut worker, &dispatch, json!({"answer": 4})).unwrap();
    assert_eq!(done["status"], "completed");

    let entries = journal_entries(&fixture.data_dir).unwrap();
    let attempt_starts = entries
        .iter()
        .filter(|entry| {
            entry.entry_type == EntryType::StepAttemptStarted
                && entry.step_id.as_deref() == Some("model")
        })
        .count();
    assert_eq!(
        attempt_starts, 1,
        "concurrent resumes must journal exactly one attempt start"
    );
    let completions = model_completions(&fixture);
    assert_eq!(
        completions.len(),
        1,
        "exactly one execution of the llm step"
    );
    assert_eq!(completions[0].completion_reason, CompletionReason::Success);
}

/// Finding 2: a live `run.resume` must not presume a mid-lease, heartbeating
/// attempt dead. The attempt is left running — no crashed completion, no
/// duplicate dispatch — and its worker's completion still lands.
#[test]
fn live_resume_leaves_an_active_lease_running() {
    let fixture = LlmFixture::new("live-resume-lease", false);
    let _server = ServerGuard::start(&fixture);
    let mut worker = attached_worker(&fixture, "steady-stub");
    let run_id = start_run(&fixture);
    let first = worker.event("step.dispatch").unwrap();
    assert_eq!(first["attempt"], 1);
    let heartbeat = worker
        .request(
            "step.heartbeat",
            json!({
                "run_id": run_id,
                "step_id": "model",
                "attempt": 1,
                "lease_id": first["lease_id"]
            }),
        )
        .unwrap();
    assert!(heartbeat["lease_deadline_ms"].as_i64().unwrap() > 0);

    let mut control = ProtocolClient::connect(&fixture.data_dir.join("relayflowd.sock"));
    let resumed = control
        .request("run.resume", json!({"run_id": run_id}))
        .unwrap();
    assert_eq!(resumed["status"], "parked");

    let entries = journal_entries(&fixture.data_dir).unwrap();
    assert!(
        model_completions(&fixture).is_empty(),
        "a mid-lease attempt must not be marked crashed by a live resume"
    );
    let attempt_starts = entries
        .iter()
        .filter(|entry| {
            entry.entry_type == EntryType::StepAttemptStarted
                && entry.step_id.as_deref() == Some("model")
        })
        .count();
    assert_eq!(
        attempt_starts, 1,
        "no duplicate dispatch of the leased step"
    );

    // The lease survived: the original worker's completion finishes the run.
    let done = complete(&mut worker, &first, json!({"answer": 4})).unwrap();
    assert_eq!(done["status"], "completed");
}

fn model_completions(fixture: &LlmFixture) -> Vec<StepCompletedPayload> {
    journal_entries(&fixture.data_dir)
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| {
            entry.entry_type == EntryType::StepCompleted
                && entry.step_id.as_deref() == Some("model")
        })
        .map(|entry| serde_json::from_value(entry.payload).unwrap())
        .collect()
}
