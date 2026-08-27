//! Crash-injection gate (AGENTS.md rule 5): kill between and during steps,
//! resume, assert exactly-once effects.
//!
//! Three tiers, honestly labeled:
//!   1. `sigkill_...` — a REAL crash: the relayflowd process is SIGKILLed
//!      mid-run (after step 1's effect, during step 2's attempt), with no
//!      chance to flush or clean up. This is the gate.
//!   2. `completed_steps_...` — a controlled interruption at a step boundary
//!      (`--stop-after`), pinning the deterministic between-steps window that
//!      a racy kill cannot land on reliably.
//!   3. `an_attempt_left_running_...` — a journal-level simulation of a dead
//!      attempt, pinning the recovery state machine without any process.

use std::{
    fs,
    os::unix::process::CommandExt,
    path::Path,
    process::{Child, Command},
    time::{Duration, Instant},
};

use relayflowd::{Engine, RunOutcome};
use relayflowd_core::{
    Action, CompletionReason, EntryType, Journal, JournalEntry, RunSpawnedPayload, RunSpec,
    RunState, StepCompletedPayload, next_actions,
};
use relayflowd_journal::{Registry, SqliteJournal};
use serde_json::json;
use tempfile::tempdir;

fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn only_run_id(data_dir: &Path) -> String {
    let runs = data_dir.join("runs");
    let mut ids: Vec<String> = fs::read_dir(&runs)
        .unwrap()
        .filter_map(|entry| {
            let name = entry.unwrap().file_name().into_string().unwrap();
            name.strip_suffix(".sqlite3").map(str::to_owned)
        })
        .collect();
    assert_eq!(ids.len(), 1, "expected exactly one run journal");
    ids.pop().unwrap()
}

/// The real crash gate. `kill -9` lands while step `second`'s attempt is
/// running and after step `first`'s effect is durable, so one kill exercises
/// both invariants: the completed step replays as a memoized fact (its effect
/// happens exactly once) and the dead attempt is explained and replaced.
#[test]
fn sigkill_mid_run_preserves_completed_effects_and_replaces_the_dead_attempt() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path().join("data");
    let marker = directory.path().join("effects.txt");
    let attempts = directory.path().join("second-attempts.txt");
    let gate = directory.path().join("go");
    let spec_path = directory.path().join("run.json");
    let spec = json!({
        "name": "sigkill-crash-resume",
        "steps": [
            {
                "id": "first",
                "type": "deterministic",
                "command": ["/bin/sh", "-c",
                    format!("printf 'first\\n' >> '{}'", marker.to_string_lossy())]
            },
            {
                "id": "second",
                "type": "deterministic",
                "depends_on": ["first"],
                "command": ["/bin/sh", "-c", format!(
                    "printf 'started\\n' >> '{attempts}'; while [ ! -f '{gate}' ]; do sleep 0.05; done; printf 'second\\n' >> '{marker}'",
                    attempts = attempts.to_string_lossy(),
                    gate = gate.to_string_lossy(),
                    marker = marker.to_string_lossy(),
                )]
            }
        ]
    });
    fs::write(&spec_path, serde_json::to_vec(&spec).unwrap()).unwrap();

    // Run relayflowd in its own process group so the kill takes down the
    // kernel *and* the step's shell — the machine-crash shape, with no
    // orphaned child left to finish the effect on the dead run's behalf.
    let mut child: Child = Command::new(env!("CARGO_BIN_EXE_relayflowd"))
        .args(["--data-dir", data_dir.to_str().unwrap(), "run"])
        .arg(&spec_path)
        .process_group(0)
        .spawn()
        .unwrap();

    // Step 1's effect is durable and step 2's attempt has started (the journal
    // entry is appended before execution) — now the process dies for real.
    wait_until("second step's attempt to start", || attempts.exists());
    let group_killed = Command::new("/bin/kill")
        .args(["-9", &format!("-{}", child.id())]) // SIGKILL the whole group
        .status()
        .unwrap();
    assert!(group_killed.success());
    // exec_det spawns the step's shell as its own process-group leader (so a
    // timeout can kill the whole tree), which also detaches it from the group
    // killed above. A machine crash takes the step down too: find the shell
    // by its unique command line and SIGKILL its group as well, so no orphan
    // finishes the effect on the dead run's behalf.
    let step_shells = Command::new("pgrep")
        .args(["-f", gate.to_str().unwrap()])
        .output()
        .unwrap();
    for pid in String::from_utf8_lossy(&step_shells.stdout).split_whitespace() {
        let _ = Command::new("/bin/kill")
            .args(["-9", &format!("-{pid}")])
            .status();
    }
    child.wait().unwrap();
    assert_eq!(
        fs::read_to_string(&marker).unwrap(),
        "first\n",
        "step 2 must not have completed before the kill"
    );

    // Unblock step 2 and resume from the durable journal in a fresh engine.
    fs::write(&gate, b"").unwrap();
    let run_id = only_run_id(&data_dir);
    let outcome = Engine::new(&data_dir).resume(&run_id, None).unwrap();
    assert_eq!(outcome.status, relayflowd::RunStatus::Completed);

    // Exactly-once effects for the completed step: `first` ran once.
    // At-least-once execution for the dead attempt: `second` started twice.
    assert_eq!(fs::read_to_string(&marker).unwrap(), "first\nsecond\n");
    assert_eq!(fs::read_to_string(&attempts).unwrap(), "started\nstarted\n");

    let journal_path = data_dir.join("runs").join(format!("{run_id}.sqlite3"));
    let journal = SqliteJournal::open(journal_path).unwrap();
    let entries = journal
        .scan_segment(journal.current_segment().unwrap())
        .unwrap();
    let first_starts = entries
        .iter()
        .filter(|entry| {
            entry.entry_type == EntryType::StepAttemptStarted
                && entry.step_id.as_deref() == Some("first")
        })
        .count();
    assert_eq!(first_starts, 1, "memoized completed step was started again");
    let dead = entries
        .iter()
        .find(|entry| {
            entry.entry_type == EntryType::StepCompleted
                && entry.step_id.as_deref() == Some("second")
                && entry.attempt == Some(1)
        })
        .expect("the killed attempt must be explained in the journal");
    let payload: StepCompletedPayload = serde_json::from_value(dead.payload.clone()).unwrap();
    assert!(matches!(
        payload.completion_reason,
        CompletionReason::Crashed | CompletionReason::LeaseExpired
    ));
    assert!(entries.iter().any(|entry| {
        entry.entry_type == EntryType::StepAttemptStarted
            && entry.step_id.as_deref() == Some("second")
            && entry.attempt == Some(2)
    }));
}

/// Controlled interruption exactly at the step boundary (`--stop-after` exits
/// the process after step 1 completes, before step 2's attempt starts). Not a
/// crash — the SIGKILL test above is — but it pins the between-steps window
/// deterministically: a fresh process must inject `first` as a memoized fact.
#[test]
fn completed_steps_are_not_reexecuted_after_process_state_is_dropped() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path().join("data");
    let marker = directory.path().join("executions.txt");
    let spec_path = directory.path().join("run.json");
    let marker_text = marker.to_string_lossy();
    let spec = json!({
        "name": "crash-resume",
        "steps": [
            {
                "id": "first",
                "type": "deterministic",
                "command": ["/bin/sh", "-c", format!("printf 'first\\n' >> '{}'", marker_text)]
            },
            {
                "id": "second",
                "type": "deterministic",
                "depends_on": ["first"],
                "command": ["/bin/sh", "-c", format!("printf 'second\\n' >> '{}'", marker_text)]
            }
        ]
    });
    fs::write(&spec_path, serde_json::to_vec(&spec).unwrap()).unwrap();

    let first_process = Command::new(env!("CARGO_BIN_EXE_relayflowd"))
        .args(["--data-dir", data_dir.to_str().unwrap(), "run"])
        .arg(&spec_path)
        .args(["--stop-after", "1"])
        .output()
        .unwrap();
    assert!(first_process.status.success(), "{:?}", first_process);
    let interrupted: RunOutcome = serde_json::from_slice(&first_process.stdout).unwrap();
    assert_eq!(interrupted.status, relayflowd::RunStatus::Interrupted);
    assert_eq!(fs::read_to_string(&marker).unwrap(), "first\n");

    // The first relayflowd process is gone. A fresh process reconstructs state
    // from SQLite and must inject `first` as a memoized fact.
    let second_process = Command::new(env!("CARGO_BIN_EXE_relayflowd"))
        .args([
            "--data-dir",
            data_dir.to_str().unwrap(),
            "resume",
            &interrupted.run_id,
        ])
        .output()
        .unwrap();
    assert!(second_process.status.success(), "{:?}", second_process);
    let resumed: RunOutcome = serde_json::from_slice(&second_process.stdout).unwrap();
    assert_eq!(resumed.status, relayflowd::RunStatus::Completed);
    assert_eq!(fs::read_to_string(&marker).unwrap(), "first\nsecond\n");

    let journal_path = data_dir
        .join("runs")
        .join(format!("{}.sqlite3", interrupted.run_id));
    let journal = SqliteJournal::open(journal_path).unwrap();
    let entries = journal
        .scan_segment(journal.current_segment().unwrap())
        .unwrap();
    let first_starts = entries
        .iter()
        .filter(|entry| {
            entry.entry_type == EntryType::StepAttemptStarted
                && entry.step_id.as_deref() == Some("first")
        })
        .count();
    assert_eq!(first_starts, 1, "memoized completed step was started again");
}

/// Journal-level simulation (no process is killed here — the SIGKILL test
/// covers that): a hand-authored journal says attempt 1 is running while no
/// process holds it. Pins the recovery edge of the state machine in isolation.
#[test]
fn an_attempt_left_running_is_recorded_dead_and_replaced_on_resume() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path().join("data");
    let marker = directory.path().join("mid-attempt.txt");
    let run_id = "01KERNELCRASHRESUMETEST0000";
    let spec: RunSpec = RunSpec::parse(&json!({
        "steps": [{
            "id": "unfinished",
            "type": "deterministic",
            "command": ["/bin/sh", "-c", format!("printf 'finished\\n' >> '{}'", marker.to_string_lossy())]
        }]
    }))
    .unwrap();
    let run_path = data_dir.join("runs").join(format!("{run_id}.sqlite3"));
    let mut journal = SqliteJournal::create(&run_path, run_id, 1).unwrap();
    journal
        .append(&JournalEntry::new(
            EntryType::RunSpawned,
            run_id,
            None,
            None,
            1,
            RunSpawnedPayload {
                spec: serde_json::to_value(&spec).unwrap(),
                spec_hash: "test-hash".to_owned(),
                parent_run_id: None,
                journal_version: relayflowd_core::JOURNAL_VERSION,
                created_by: "crash-test".to_owned(),
            },
        ))
        .unwrap();
    let state = RunState::fold(run_id, spec, &journal.scan_segment(1).unwrap()).unwrap();
    let Action::Append(started) = &next_actions(&state, 2)[0] else {
        panic!("step start must be journaled before execution")
    };
    journal.append(started).unwrap();
    Registry::open(data_dir.join("relayflowd.sqlite3"))
        .unwrap()
        .register(run_id, &run_path)
        .unwrap();

    // Drop all in-memory state while the durable journal says attempt 1 is
    // running. A new engine process equivalent must explain and replace it.
    drop(journal);
    let outcome = Engine::new(&data_dir).resume(run_id, None).unwrap();
    assert_eq!(outcome.status, relayflowd::RunStatus::Completed);
    assert_eq!(fs::read_to_string(&marker).unwrap(), "finished\n");

    let journal = SqliteJournal::open(run_path).unwrap();
    let entries = journal.scan_segment(1).unwrap();
    let dead_attempt = entries
        .iter()
        .find(|entry| entry.entry_type == EntryType::StepCompleted && entry.attempt == Some(1));
    let payload: StepCompletedPayload =
        serde_json::from_value(dead_attempt.unwrap().payload.clone()).unwrap();
    assert!(matches!(
        payload.completion_reason,
        CompletionReason::Crashed | CompletionReason::LeaseExpired
    ));
    assert!(entries.iter().any(|entry| {
        entry.entry_type == EntryType::StepAttemptStarted && entry.attempt == Some(2)
    }));
}
