//! Live-server scheduling races: per-run serialization of mutating verbs and
//! lease-aware resume. Both run against the real `relayflowd serve` binary
//! over the real socket.

use std::{
    sync::{Arc, Barrier},
    thread,
};

use relayflowd_core::{
    CompletionReason, EntryType, RunCompletedPayload, RunCompletionReason, StepCompletedPayload,
};
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

#[test]
fn cancel_closes_the_lease_and_rejects_a_late_completion() {
    let fixture = LlmFixture::new("cancel-late-completion", false);
    let _server = ServerGuard::start(&fixture);
    let mut worker = attached_worker(&fixture, "cancel-stub");
    let run_id = start_run(&fixture);
    let dispatch = worker.event("step.dispatch").unwrap();
    let mut control = ProtocolClient::connect(&fixture.data_dir.join("relayflowd.sock"));

    let canceled = control
        .request("run.cancel", json!({"run_id": run_id}))
        .unwrap();
    assert_eq!(canceled["completion_reason"], "canceled");
    let repeated = control
        .request("run.cancel", json!({"run_id": run_id}))
        .unwrap();
    assert_eq!(repeated, canceled);
    assert!(complete(&mut worker, &dispatch, json!({"answer": 4})).is_err());

    let entries = journal_entries(&fixture.data_dir).unwrap();
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.entry_type == EntryType::RunCancelRequested)
            .count(),
        1
    );
    let completions = model_completions(&fixture);
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0].completion_reason, CompletionReason::Canceled);
}

#[test]
fn cancel_and_completion_race_has_one_terminal_fact() {
    let fixture = LlmFixture::new("cancel-completion-race", false);
    let _server = ServerGuard::start(&fixture);
    let mut worker = attached_worker(&fixture, "race-stub");
    let run_id = start_run(&fixture);
    let dispatch = worker.event("step.dispatch").unwrap();
    let socket = fixture.data_dir.join("relayflowd.sock");
    let barrier = Arc::new(Barrier::new(2));

    let cancel_barrier = barrier.clone();
    let cancel_run = run_id.clone();
    let cancel = thread::spawn(move || {
        let mut control = ProtocolClient::connect(&socket);
        cancel_barrier.wait();
        control.request("run.cancel", json!({"run_id": cancel_run}))
    });
    let complete_barrier = barrier.clone();
    let completion = thread::spawn(move || {
        complete_barrier.wait();
        complete(&mut worker, &dispatch, json!({"answer": 4}))
    });
    let cancel = cancel.join().unwrap();
    let completion = completion.join().unwrap();

    let entries = journal_entries(&fixture.data_dir).unwrap();
    let terminal = entries
        .iter()
        .filter(|entry| entry.entry_type == EntryType::RunCompleted)
        .map(|entry| serde_json::from_value::<RunCompletedPayload>(entry.payload.clone()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(terminal.len(), 1);
    match terminal[0].completion_reason {
        RunCompletionReason::Canceled => {
            assert!(cancel.is_ok());
            assert!(completion.is_err());
        }
        RunCompletionReason::Success => {
            assert!(completion.is_ok());
            assert_eq!(cancel.unwrap()["completion_reason"], "success");
        }
        reason => panic!("unexpected race result: {reason:?}"),
    }
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
