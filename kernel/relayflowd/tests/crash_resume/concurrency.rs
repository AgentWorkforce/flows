//! Live-server scheduling races: per-run serialization of mutating verbs and
//! lease-aware resume. Both run against the real `relayflowd serve` binary
//! over the real socket.

use std::{
    sync::{Arc, Barrier},
    thread,
};

use relayflowd_core::{CompletionReason, EntryType, StepCompletedPayload};
use serde_json::json;

use super::{
    llm_support::{LlmFixture, ProtocolClient, ServerGuard, attached_worker, complete, start_run},
    support::journal_entries,
};

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
