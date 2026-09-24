//! A batch is elected at one instant and driven serially, so a start journaled
//! after a slow deterministic peer must be stamped when it is journaled: its
//! wall clock is its own, and its full lease — journaled and dispatched — is
//! still ahead of it.

use std::sync::{Arc, Mutex};

use relayflowd::worker::{DispatchOutcome, JournalObserver, StepDispatch, StepDispatcher};
use relayflowd::{Engine, RunStatus};
use relayflowd_core::{EntryType, JournalEntry, RunSpec, StepType};
use serde_json::json;
use tempfile::tempdir;

/// The kernel's default lease for a step that declares none.
const DEFAULT_LEASE_MS: i64 = 30_000;

#[derive(Default)]
struct Recorder {
    run_id: Mutex<Option<String>>,
    dispatches: Mutex<Vec<StepDispatch>>,
}

impl JournalObserver for Recorder {
    fn appended(&self, entry: &JournalEntry) {
        if entry.entry_type == EntryType::RunSpawned {
            *self.run_id.lock().unwrap() = Some(entry.run_id.clone());
        }
    }
}

impl StepDispatcher for Recorder {
    fn executor(&self, _step_type: StepType) -> Option<String> {
        Some("late-start-test".to_owned())
    }

    fn available(&self, step_type: StepType) -> bool {
        step_type == StepType::Llm
    }

    fn dispatch(&self, dispatch: StepDispatch) -> anyhow::Result<DispatchOutcome> {
        self.dispatches.lock().unwrap().push(dispatch);
        Ok(DispatchOutcome::Dispatched)
    }
}

fn entry_of(entries: &[JournalEntry], entry_type: EntryType, step_id: &str) -> JournalEntry {
    entries
        .iter()
        .find(|entry| entry.entry_type == entry_type && entry.step_id.as_deref() == Some(step_id))
        .cloned()
        .unwrap_or_else(|| panic!("no {entry_type:?} for {step_id}"))
}

#[test]
fn a_start_after_a_slow_deterministic_peer_is_stamped_when_journaled() {
    let spec = RunSpec::parse(&json!({
        "name": "late-start",
        "steps": [
            {"id": "slow", "type": "deterministic", "command": "sleep 0.4"},
            {"id": "quick", "type": "deterministic", "command": "true"}
        ]
    }))
    .unwrap();
    let directory = tempdir().unwrap();
    let engine = Engine::new(directory.path());
    let outcome = engine.start(spec, "test", None).unwrap();
    assert_eq!(outcome.status, RunStatus::Completed);
    let entries = engine
        .journal_entries(&outcome.run_id, 1, usize::MAX)
        .unwrap();

    let slow_done = entry_of(&entries, EntryType::StepCompleted, "slow");
    let quick_start = entry_of(&entries, EntryType::StepAttemptStarted, "quick");
    let quick_done = entry_of(&entries, EntryType::StepCompleted, "quick");
    // Ordering, not a wall-clock bound: the start is journaled after the peer
    // finished, so the step's own span cannot contain the peer's runtime.
    assert!(
        quick_start.at_ms >= slow_done.at_ms,
        "quick started at {} before slow completed at {}",
        quick_start.at_ms,
        slow_done.at_ms
    );
    assert_eq!(
        quick_done.payload["spend"]["wallclock_ms"].as_i64().unwrap(),
        quick_done.at_ms - quick_start.at_ms,
    );
    for step in ["slow", "quick"] {
        let start = entry_of(&entries, EntryType::StepAttemptStarted, step);
        assert_eq!(
            start.payload["lease_deadline_ms"].as_i64().unwrap() - start.at_ms,
            DEFAULT_LEASE_MS,
            "{step}'s lease must run from its own start"
        );
    }
}

#[test]
fn a_dispatch_after_a_slow_deterministic_peer_keeps_its_full_lease() {
    let spec = RunSpec::parse(&json!({
        "name": "late-dispatch",
        "steps": [
            {"id": "slow", "type": "deterministic", "command": "sleep 0.4"},
            {"id": "model", "type": "llm", "prompt": "p", "model": "stub"}
        ]
    }))
    .unwrap();
    let directory = tempdir().unwrap();
    let recorder = Arc::new(Recorder::default());
    let engine = Engine::with_runtime(directory.path(), recorder.clone(), recorder.clone());
    engine.start(spec, "test", None).unwrap();
    let run_id = recorder.run_id.lock().unwrap().clone().unwrap();
    let entries = engine.journal_entries(&run_id, 1, usize::MAX).unwrap();

    let slow_done = entry_of(&entries, EntryType::StepCompleted, "slow");
    let start = entry_of(&entries, EntryType::StepAttemptStarted, "model");
    let dispatch = recorder
        .dispatches
        .lock()
        .unwrap()
        .iter()
        .find(|dispatch| dispatch.step_id == "model")
        .cloned()
        .unwrap();
    assert!(start.at_ms >= slow_done.at_ms);
    assert_eq!(
        dispatch.lease_deadline_ms,
        start.payload["lease_deadline_ms"].as_i64().unwrap()
    );
    assert_eq!(dispatch.lease_deadline_ms - start.at_ms, DEFAULT_LEASE_MS);
}
