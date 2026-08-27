use std::{fs, os::unix::process::CommandExt, process::Command};

use relayflowd::{RunOutcome, RunStatus};
use relayflowd_core::{
    AttemptStartedPayload, Budget, CompletionReason, Disposition, EntryType, RunCompletedPayload,
    StepCompletedPayload,
};
use serde_json::json;

use super::{
    llm_support::{
        LlmFixture, ProtocolClient, ServerGuard, attached_worker, complete, spawn_resume, start_run,
    },
    support::{journal_entries, kill_group, only_run_id, read_pid, resume_cli, wait_until},
};

#[test]
fn serve_plumbs_watch_events_and_replayable_stream_verbs() {
    let fixture = LlmFixture::new("protocol-verbs", false);
    let _server = ServerGuard::start(&fixture);
    let run_id = start_run(&fixture);
    let socket = fixture.data_dir.join("relayflowd.sock");
    let mut watcher = ProtocolClient::connect(&socket);
    watcher
        .request("run.watch", json!({"run_id": run_id}))
        .unwrap();
    assert_eq!(watcher.event("entry").unwrap()["entry_type"], "run.spawned");

    let mut client = ProtocolClient::connect(&socket);
    let first = client
        .request(
            "stream.append",
            json!({"run_id": run_id, "stream": "results", "message": {"n": 1}}),
        )
        .unwrap();
    let second = client
        .request(
            "stream.append",
            json!({"run_id": run_id, "stream": "results", "message": {"n": 2}}),
        )
        .unwrap();
    assert_eq!(
        (first["offset"].as_u64(), second["offset"].as_u64()),
        (Some(0), Some(1))
    );
    let read = client
        .request(
            "stream.read",
            json!({"run_id": run_id, "stream": "results", "from_offset": 0, "limit": 10}),
        )
        .unwrap();
    assert_eq!(read["messages"], json!([{"n": 1}, {"n": 2}]));
    assert_eq!(read["next_offset"], 2);
    let emitted = client
        .request(
            "event.emit",
            json!({"run_id": run_id, "event_key": "nothing-waits", "payload": {}}),
        )
        .unwrap();
    assert_eq!(emitted["matched"], 0);
    loop {
        if watcher.event("entry").unwrap()["entry_type"] == "stream.appended" {
            break;
        }
    }
    assert!(client.request("unknown.verb", json!({})).is_err());
}

#[test]
fn sigkill_sweep_covers_before_and_between_the_rung_b_steps() {
    for (label, pause_before, durable_before_kill) in [
        ("before-first", "first", 0),
        ("between-first-llm", "model", 1),
    ] {
        let fixture = LlmFixture::new(label, false);
        let mut run = Command::new(env!("CARGO_BIN_EXE_relayflowd"))
            .args([
                "--data-dir",
                fixture.data_dir.to_str().unwrap(),
                "run",
                fixture.spec_path.to_str().unwrap(),
                "--pause-before-step",
                pause_before,
            ])
            .process_group(0)
            .spawn()
            .unwrap();
        wait_until(label, || {
            journal_entries(&fixture.data_dir).is_some_and(|entries| {
                entries
                    .iter()
                    .filter(|entry| {
                        entry.entry_type == EntryType::StepCompleted
                            && serde_json::from_value::<StepCompletedPayload>(entry.payload.clone())
                                .is_ok_and(|payload| {
                                    payload.completion_reason == CompletionReason::Success
                                })
                    })
                    .count()
                    == durable_before_kill
            })
        });
        kill_group(run.id());
        let _ = run.wait();

        let _server = ServerGuard::start(&fixture);
        let mut worker = attached_worker(&fixture, "boundary-stub");
        let run_id = only_run_id(&fixture.data_dir);
        let resume = spawn_resume(&fixture, &run_id);
        let dispatch = worker.event("step.dispatch").unwrap();
        complete(&mut worker, &dispatch, json!({"answer": 4})).unwrap();
        let output = resume.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{label}: resume failed: {output:?}"
        );
        assert_eq!(
            fs::read_to_string(&fixture.marker).unwrap(),
            "first\nfinish\n",
            "{label}: completed deterministic effects are memoized"
        );
        assert_eq!(
            llm_completions(&fixture)
                .iter()
                .filter(|payload| payload.completion_reason == CompletionReason::Success)
                .count(),
            1,
            "{label}: the stub generates the llm output exactly once"
        );
        assert_run_budget(
            &fixture,
            Budget {
                tokens_in: 11,
                tokens_out: 4,
                dollars: "0.002".to_owned(),
            },
        );
    }
}

#[test]
fn failing_llm_verification_schedules_a_durable_retry_and_succeeds() {
    let fixture = LlmFixture::new("verify-retry", false);
    let _server = ServerGuard::start(&fixture);
    let mut worker = attached_worker(&fixture, "stub");
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
    let parked = complete(&mut worker, &first, json!({"wrong": 4})).unwrap();
    assert_eq!(parked["status"], "parked");
    let second = worker.event("step.dispatch").unwrap();
    assert_eq!(second["attempt"], 2);
    let done = complete(&mut worker, &second, json!({"answer": 4})).unwrap();
    assert_eq!(done["status"], "completed");

    let completions = llm_completions(&fixture);
    assert_eq!(
        completions[0].completion_reason,
        CompletionReason::VerificationFailed
    );
    assert_eq!(completions[0].disposition, Disposition::Retry);
    assert_eq!(completions[1].completion_reason, CompletionReason::Success);
    assert_eq!(
        fs::read_to_string(&fixture.marker).unwrap(),
        "first\nfinish\n"
    );
    assert_run_budget(
        &fixture,
        Budget {
            tokens_in: 22,
            tokens_out: 8,
            dollars: "0.004".to_owned(),
        },
    );
}

#[test]
fn llm_verification_exhaustion_is_a_declared_failure_kind() {
    let fixture = LlmFixture::new("verify-exhausted", false);
    let _server = ServerGuard::start(&fixture);
    let mut worker = attached_worker(&fixture, "stub");
    start_run(&fixture);
    let first = worker.event("step.dispatch").unwrap();
    complete(&mut worker, &first, json!({"wrong": 1})).unwrap();
    let second = worker.event("step.dispatch").unwrap();
    let failed = complete(&mut worker, &second, json!({"still_wrong": 2})).unwrap();
    assert_eq!(failed["status"], "failed");
    let completions = llm_completions(&fixture);
    assert_eq!(
        completions[1].completion_reason,
        CompletionReason::RetriesExhausted
    );
    assert_eq!(completions[1].disposition, Disposition::StepDone);
}

#[test]
fn worker_killed_while_holding_a_lease_is_explained_and_released_on_cli_resume() {
    let fixture = LlmFixture::new("dead-worker", false);
    let _server = ServerGuard::start(&fixture);
    let mut dead_worker = attached_worker(&fixture, "dead-stub");
    let run_id = start_run(&fixture);
    let first = dead_worker.event("step.dispatch").unwrap();
    assert_eq!(first["attempt"], 1);
    let started = journal_entries(&fixture.data_dir)
        .unwrap()
        .into_iter()
        .find(|entry| {
            entry.entry_type == EntryType::StepAttemptStarted
                && entry.step_id.as_deref() == Some("model")
        })
        .unwrap();
    let started: AttemptStartedPayload = serde_json::from_value(started.payload).unwrap();
    assert_eq!(started.executor, "dead-stub");
    drop(dead_worker);
    wait_until("dead llm attempt journal entry", || {
        llm_completions(&fixture)
            .iter()
            .any(|payload| payload.completion_reason == CompletionReason::Crashed)
    });

    let mut replacement = attached_worker(&fixture, "replacement-stub");
    let child = spawn_resume(&fixture, &run_id);
    let second = replacement.event("step.dispatch").unwrap();
    assert_eq!(second["attempt"], 2);
    complete(&mut replacement, &second, json!({"answer": 4})).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "resume failed: {output:?}");
    let outcome: RunOutcome = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(outcome.status, RunStatus::Completed);
    assert_eq!(
        fs::read_to_string(&fixture.marker).unwrap(),
        "first\nfinish\n"
    );
    assert_run_budget(
        &fixture,
        Budget {
            tokens_in: 11,
            tokens_out: 4,
            dollars: "0.002".to_owned(),
        },
    );
}

#[test]
fn sigkill_under_serve_mid_llm_releases_the_lease_and_finishes_via_cli_resume() {
    let fixture = LlmFixture::new("serve-mid-llm", false);
    let mut server = ServerGuard::start(&fixture);
    let mut dead_worker = attached_worker(&fixture, "dead-with-server");
    let run_id = start_run(&fixture);
    let first = dead_worker.event("step.dispatch").unwrap();
    assert_eq!(first["attempt"], 1);
    server.kill();
    drop(dead_worker);

    let _restarted = ServerGuard::start(&fixture);
    let mut replacement = attached_worker(&fixture, "after-restart");
    let child = spawn_resume(&fixture, &run_id);
    let second = replacement.event("step.dispatch").unwrap();
    assert_eq!(second["attempt"], 2);
    complete(&mut replacement, &second, json!({"answer": 4})).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "resume failed: {output:?}");
    assert!(llm_completions(&fixture).iter().any(|payload| matches!(
        payload.completion_reason,
        CompletionReason::Crashed | CompletionReason::LeaseExpired
    )));
    assert_run_budget(
        &fixture,
        Budget {
            tokens_in: 11,
            tokens_out: 4,
            dollars: "0.002".to_owned(),
        },
    );
}

#[test]
fn completed_llm_output_is_memoized_when_serve_dies_during_the_next_step() {
    let fixture = LlmFixture::new("memoized", true);
    let mut server = ServerGuard::start(&fixture);
    let mut worker = attached_worker(&fixture, "one-generation");
    start_run(&fixture);
    let dispatch = worker.event("step.dispatch").unwrap();
    let completion =
        std::thread::spawn(move || complete(&mut worker, &dispatch, json!({"answer": 4})));
    wait_until("finish step to hold after llm completion", || {
        fixture.step_pid.exists()
    });
    server.kill();
    kill_group(read_pid(&fixture.step_pid));
    let _ = completion.join().unwrap();

    fs::write(&fixture.gate, b"open").unwrap();
    let outcome = resume_cli(&fixture.data_dir);
    assert_eq!(outcome.status, RunStatus::Completed);
    assert_eq!(
        fs::read_to_string(&fixture.marker).unwrap(),
        "first\nfinish\n"
    );
    let llm = llm_completions(&fixture)
        .into_iter()
        .filter(|payload| payload.completion_reason == CompletionReason::Success)
        .collect::<Vec<_>>();
    assert_eq!(
        llm.len(),
        1,
        "the completed llm output must be replayed, not regenerated"
    );
    assert_run_budget(
        &fixture,
        Budget {
            tokens_in: 11,
            tokens_out: 4,
            dollars: "0.002".to_owned(),
        },
    );
}

#[test]
fn sigkill_after_the_final_rung_b_effect_resumes_without_redispatching_llm() {
    let fixture = LlmFixture::new("after-final", false);
    let mut server = ServerGuard::start(&fixture);
    let mut worker = attached_worker(&fixture, "final-boundary-stub");
    start_run(&fixture);
    let dispatch = worker.event("step.dispatch").unwrap();
    let done = complete(&mut worker, &dispatch, json!({"answer": 4})).unwrap();
    assert_eq!(done["status"], "completed");
    server.kill();

    let outcome = resume_cli(&fixture.data_dir);
    assert_eq!(outcome.status, RunStatus::Completed);
    assert_eq!(
        fs::read_to_string(&fixture.marker).unwrap(),
        "first\nfinish\n"
    );
    assert_eq!(
        llm_completions(&fixture)
            .iter()
            .filter(|payload| payload.completion_reason == CompletionReason::Success)
            .count(),
        1,
        "resume after the final effect must not redispatch the llm step"
    );
    assert_run_budget(
        &fixture,
        Budget {
            tokens_in: 11,
            tokens_out: 4,
            dollars: "0.002".to_owned(),
        },
    );
}

fn llm_completions(fixture: &LlmFixture) -> Vec<StepCompletedPayload> {
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

fn assert_run_budget(fixture: &LlmFixture, expected: Budget) {
    let entries = journal_entries(&fixture.data_dir).unwrap();
    let completed = entries
        .iter()
        .find(|entry| entry.entry_type == EntryType::RunCompleted)
        .expect("run completed exactly once");
    let payload: RunCompletedPayload = serde_json::from_value(completed.payload.clone()).unwrap();
    assert_eq!(payload.budget_total, expected);
    let run_id = only_run_id(&fixture.data_dir);
    assert!(!run_id.is_empty());
}
