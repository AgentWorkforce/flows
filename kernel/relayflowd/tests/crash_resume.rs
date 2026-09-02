//! Gate-1 rung (a) crash injection against the real `relayflowd` binary.
//! Every recovery path invokes the binary's `resume` subcommand.

#[path = "crash_resume/agent.rs"]
mod agent;
#[path = "crash_resume/agent_support.rs"]
mod agent_support;
#[path = "crash_resume/concurrency.rs"]
mod concurrency;
#[path = "crash_resume/llm.rs"]
mod llm;
#[path = "crash_resume/llm_support.rs"]
mod llm_support;
#[path = "crash_resume/parallel_lifecycle.rs"]
mod parallel_lifecycle;
#[path = "crash_resume/pin_projection.rs"]
mod pin_projection;
#[path = "crash_resume/protocol_admission.rs"]
mod protocol_admission;
#[path = "crash_resume/support.rs"]
mod support;
#[path = "crash_resume/surface_identity.rs"]
mod surface_identity;
#[path = "crash_resume/worker_capacity.rs"]
mod worker_capacity;

use std::{
    fs, io::Write, os::unix::net::UnixStream, os::unix::process::CommandExt, process::Command,
};

use relayflowd::{RunOutcome, RunStatus};
use relayflowd_core::{
    CompletionReason, EntryType, RunCompletedPayload, RunCompletionReason, StepCompletedPayload,
};
use serde_json::{Value, json};

use support::{
    Fixture, assert_exact_journal, completed_step_count, journal_entries, kill_process_group,
    read_pid, resume_cli, spawn_run, wait_until,
};

#[test]
fn sigkill_sweep_covers_every_hello_step_boundary() {
    let cases = [
        ("before-first", Some("first"), false, 0),
        ("between-first-second", Some("second"), false, 1),
        ("between-second-third", Some("third"), false, 2),
        ("after-last-effect", None, true, 3),
    ];

    for (label, pause_before_step, pause_before_completion, completed_before_kill) in cases {
        let fixture = Fixture::hello(label);
        let mut child = spawn_run(&fixture, pause_before_step, pause_before_completion);
        wait_until(label, || {
            journal_entries(&fixture.data_dir).is_some_and(|entries| {
                entries
                    .iter()
                    .any(|entry| entry.entry_type == EntryType::RunSpawned)
                    && completed_step_count(&entries) == completed_before_kill
                    && !entries
                        .iter()
                        .any(|entry| entry.entry_type == EntryType::RunCompleted)
            })
        });

        kill_process_group(&mut child);
        assert_eq!(
            fs::read_to_string(&fixture.marker).unwrap_or_default(),
            ["first\n", "second\n", "third\n"]
                .into_iter()
                .take(completed_before_kill)
                .collect::<String>(),
            "{label}: effects before the kill must match the durable boundary"
        );

        resume_cli(&fixture.data_dir);
        assert_eq!(
            fs::read_to_string(&fixture.marker).unwrap(),
            "first\nsecond\nthird\n",
            "{label}: completed effects must not be replayed as code"
        );
        assert_exact_journal(&fixture.data_dir, &[1, 1, 1], None);
    }
}

#[test]
fn sigkill_mid_step_replaces_and_explains_the_dead_attempt() {
    let fixture = Fixture::blocking("mid-step");
    let mut child = spawn_run(&fixture, None, false);
    wait_until("the blocking step to start", || {
        fixture.attempts.exists() && fixture.step_pid.exists()
    });

    kill_process_group(&mut child);
    support::kill_group(read_pid(&fixture.step_pid));
    assert_eq!(fs::read_to_string(&fixture.marker).unwrap(), "first\n");

    fs::write(&fixture.gate, b"open").unwrap();
    resume_cli(&fixture.data_dir);
    assert_eq!(
        fs::read_to_string(&fixture.marker).unwrap(),
        "first\nsecond\nthird\n"
    );
    assert_eq!(
        fs::read_to_string(&fixture.attempts).unwrap(),
        "started\nstarted\n"
    );
    assert_exact_journal(&fixture.data_dir, &[1, 2, 1], Some(("second", 1)));
}

#[test]
fn sigkill_under_serve_resumes_the_socket_started_run() {
    let fixture = Fixture::blocking("serve");
    let mut server = Command::new(env!("CARGO_BIN_EXE_relayflowd"))
        .args(["--data-dir", fixture.data_dir.to_str().unwrap(), "serve"])
        .process_group(0)
        .spawn()
        .unwrap();
    let socket = fixture.data_dir.join("relayflowd.sock");
    wait_until("serve socket", || socket.exists());

    let spec: Value = serde_json::from_slice(&fs::read(&fixture.spec_path).unwrap()).unwrap();
    let mut connection = UnixStream::connect(&socket).unwrap();
    let request = json!({
        "id": "serve-crash",
        "verb": "run.start",
        "params": {"spec": spec}
    });
    serde_json::to_writer(&mut connection, &request).unwrap();
    connection.write_all(b"\n").unwrap();
    connection.flush().unwrap();
    wait_until("serve-started blocking step", || {
        fixture.attempts.exists() && fixture.step_pid.exists()
    });

    kill_process_group(&mut server);
    support::kill_group(read_pid(&fixture.step_pid));
    drop(connection);
    fs::write(&fixture.gate, b"open").unwrap();

    resume_cli(&fixture.data_dir);
    assert_eq!(
        fs::read_to_string(&fixture.marker).unwrap(),
        "first\nsecond\nthird\n"
    );
    assert_exact_journal(&fixture.data_dir, &[1, 2, 1], Some(("second", 1)));

    let dead = journal_entries(&fixture.data_dir)
        .unwrap()
        .into_iter()
        .find(|entry| {
            entry.entry_type == EntryType::StepCompleted
                && entry.step_id.as_deref() == Some("second")
                && entry.attempt == Some(1)
        })
        .expect("serve crash must leave an explained dead attempt");
    let payload: StepCompletedPayload = serde_json::from_value(dead.payload).unwrap();
    assert!(matches!(
        payload.completion_reason,
        CompletionReason::Crashed | CompletionReason::LeaseExpired
    ));
}

#[test]
fn sigkill_after_cancel_request_resumes_to_one_canceled_fact() {
    let fixture = Fixture::hello("cancel-request");
    let interrupted = Command::new(env!("CARGO_BIN_EXE_relayflowd"))
        .args(["--data-dir", fixture.data_dir.to_str().unwrap(), "run"])
        .arg(&fixture.spec_path)
        .args(["--stop-after", "1"])
        .output()
        .unwrap();
    assert!(
        interrupted.status.success(),
        "initial run failed: {interrupted:?}"
    );
    let run_id = support::only_run_id(&fixture.data_dir);

    let mut cancel = Command::new(env!("CARGO_BIN_EXE_relayflowd"))
        .args([
            "--data-dir",
            fixture.data_dir.to_str().unwrap(),
            "cancel",
            &run_id,
            "--pause-after-request",
        ])
        .process_group(0)
        .spawn()
        .unwrap();
    wait_until("durable cancel request", || {
        journal_entries(&fixture.data_dir).is_some_and(|entries| {
            entries
                .iter()
                .any(|entry| entry.entry_type == EntryType::RunCancelRequested)
        })
    });
    kill_process_group(&mut cancel);
    let before_resume = journal_entries(&fixture.data_dir).unwrap();
    assert_eq!(
        before_resume
            .iter()
            .filter(|entry| entry.entry_type == EntryType::RunCancelRequested)
            .count(),
        1
    );
    assert!(
        !before_resume
            .iter()
            .any(|entry| entry.entry_type == EntryType::RunCompleted)
    );

    let resumed = Command::new(env!("CARGO_BIN_EXE_relayflowd"))
        .args([
            "--data-dir",
            fixture.data_dir.to_str().unwrap(),
            "resume",
            &run_id,
        ])
        .output()
        .unwrap();
    let outcome: RunOutcome = serde_json::from_slice(&resumed.stdout).unwrap();
    assert_eq!(outcome.status, RunStatus::Failed);
    assert_eq!(
        outcome.completion_reason,
        Some(RunCompletionReason::Canceled)
    );

    let repeated = Command::new(env!("CARGO_BIN_EXE_relayflowd"))
        .args([
            "--data-dir",
            fixture.data_dir.to_str().unwrap(),
            "cancel",
            &run_id,
        ])
        .output()
        .unwrap();
    assert!(
        repeated.status.success(),
        "repeated cancel failed: {repeated:?}"
    );
    let entries = journal_entries(&fixture.data_dir).unwrap();
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.entry_type == EntryType::RunCancelRequested)
            .count(),
        1
    );
    let terminal = entries
        .iter()
        .filter(|entry| entry.entry_type == EntryType::RunCompleted)
        .map(|entry| serde_json::from_value::<RunCompletedPayload>(entry.payload.clone()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(terminal.len(), 1);
    assert_eq!(terminal[0].completion_reason, RunCompletionReason::Canceled);
    assert_eq!(fs::read_to_string(&fixture.marker).unwrap(), "first\n");
}
