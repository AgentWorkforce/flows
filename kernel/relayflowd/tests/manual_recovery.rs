//! RFC-0001 Appendix A rule 4 at the engine boundary, for the death the
//! WORKER reports: a `manual` agent step whose worker completes with
//! `crashed` or `lease_expired` parks as `needs_human` instead of taking the
//! transport retry, stays parked across a reopen + resume, and is redispatched
//! only by a human answer. The second test tears the park between its two
//! journal appends and proves resume repairs it.

use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use relayflowd::{
    Engine, OutOfBandCompletion, RunStatus,
    worker::{DispatchOutcome, JournalObserver, StepDispatch, StepDispatcher},
};
use relayflowd_core::{
    Budget, CompletionReason, Disposition, EntryType, JournalEntry, Pins, RunSpec,
    StepCompletedPayload, StepSpec, StepType, WaitHumanPayload, WorkspacePin,
};
use serde_json::json;

fn pinned(revision_id: &str) -> Pins {
    Pins {
        workspace: vec![WorkspacePin {
            surface: "repo".to_owned(),
            revision_id: revision_id.to_owned(),
        }],
        streams: vec![],
    }
}

/// In-process agent worker: records every dispatch, pins `repo@rev-0` at
/// start, and can die exactly once right after the park completion is
/// durable — between the two appends a `manual` park is made of.
#[derive(Default)]
struct AgentWorker {
    dispatches: Mutex<Vec<StepDispatch>>,
    crash_after_park: bool,
    crashed: AtomicBool,
}

impl AgentWorker {
    fn crashing_after_park() -> Self {
        Self {
            crash_after_park: true,
            ..Self::default()
        }
    }

    fn dispatches(&self) -> Vec<StepDispatch> {
        self.dispatches.lock().unwrap().clone()
    }
}

impl JournalObserver for AgentWorker {
    fn appended(&self, entry: &JournalEntry) {
        if self.crash_after_park
            && entry.entry_type == EntryType::StepCompleted
            && entry.payload["disposition"] == "park"
            && !self.crashed.swap(true, Ordering::SeqCst)
        {
            panic!("injected crash between the park completion and its wait.human");
        }
    }
}

impl StepDispatcher for AgentWorker {
    fn executor(&self, _: StepType) -> Option<String> {
        Some("manual-recovery-test".to_owned())
    }

    fn available(&self, step_type: StepType) -> bool {
        step_type == StepType::Agent
    }

    fn starting_pins(&self, _: &StepSpec) -> anyhow::Result<Pins> {
        Ok(pinned("rev-0"))
    }

    fn dispatch(&self, dispatch: StepDispatch) -> anyhow::Result<DispatchOutcome> {
        self.dispatches.lock().unwrap().push(dispatch);
        Ok(DispatchOutcome::Dispatched)
    }
}

fn manual_spec(max_transport_retries: u32) -> RunSpec {
    RunSpec::parse(&json!({
        "name": "manual-recovery",
        "steps": [{
            "id": "edit",
            "type": "agent",
            "instruction": "edit the workspace",
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
        }]
    }))
    .unwrap()
}

/// What the SDK worker sends when its direct transport is lost: the failure
/// reason, the pins it was dispatched with, and bounded transport evidence.
fn transport_loss(dispatch: &StepDispatch, reason: CompletionReason) -> OutOfBandCompletion {
    OutOfBandCompletion {
        human_intervention: false,
        attempt: dispatch.attempt,
        idempotency_key: dispatch.idempotency_key.clone(),
        completion_reason: reason,
        output: json!({"exit_code": null, "stdout_tail": "", "stderr_tail": "killed"}),
        budget: Budget::default(),
        completed_by: "manual-recovery-test".to_owned(),
        started_pins: Some(dispatch.pins.clone()),
        end_pins: None,
        effects: vec![],
        trajectory_tail: Some(json!({"transport": {"cause": "signal_close"}})),
    }
}

fn entries(engine: &Engine, run_id: &str) -> Vec<JournalEntry> {
    engine.journal_entries(run_id, 1, usize::MAX).unwrap()
}

fn of_type(entries: &[JournalEntry], entry_type: EntryType) -> Vec<&JournalEntry> {
    entries
        .iter()
        .filter(|entry| entry.entry_type == entry_type)
        .collect()
}

fn parked_wait(engine: &Engine, run_id: &str) -> WaitHumanPayload {
    let all = entries(engine, run_id);
    let waits = of_type(&all, EntryType::WaitHuman);
    assert_eq!(waits.len(), 1, "exactly one wait.human: {waits:?}");
    assert_eq!(waits[0].step_id.as_deref(), Some("edit"));
    assert_eq!(waits[0].attempt, Some(1));
    let wait: WaitHumanPayload = serde_json::from_value(waits[0].payload.clone()).unwrap();
    // Rule 4: the diff is anchored on the journaled START pin.
    assert_eq!(wait.diff_ref.as_deref(), Some("repo@rev-0..current"));
    wait
}

fn answer_retry(engine: &Engine, run_id: &str, wait_id: &str) {
    let matched = engine
        .emit_event(
            run_id,
            wait_id,
            json!({"answer": "retry", "answeredBy": "khaliq"}),
        )
        .unwrap();
    assert_eq!(matched, 1, "the human answer must close the park's wait");
}

#[test]
fn manual_park_of_a_worker_reported_loss_survives_reopen_and_answers_to_a_human() {
    for (reason, max_transport_retries) in [
        (CompletionReason::Crashed, 1),
        (CompletionReason::LeaseExpired, 1),
        // No transport budget at all: `manual` still parks rather than
        // ending the step terminally, exactly as an abandoned lease does.
        (CompletionReason::Crashed, 0),
    ] {
        let case = format!("{reason:?} with max_transport_retries={max_transport_retries}");
        let dir = tempfile::tempdir().unwrap();
        let worker = Arc::new(AgentWorker::default());
        let engine = Engine::with_runtime(dir.path(), worker.clone(), worker.clone());
        let started = engine
            .start(manual_spec(max_transport_retries), "test", None)
            .unwrap();
        let run_id = started.run_id.clone();
        let first = worker.dispatches().remove(0);
        assert_eq!(first.attempt, 1);
        assert_eq!(first.pins, pinned("rev-0"));

        let outcome = engine
            .complete_out_of_band(&run_id, "edit", transport_loss(&first, reason))
            .unwrap();
        assert_eq!(outcome.status, RunStatus::Parked, "{case}");
        assert_eq!(
            worker.dispatches().len(),
            1,
            "{case}: a manual step must not be redispatched after a reported loss"
        );

        let all = entries(&engine, &run_id);
        assert_eq!(
            of_type(&all, EntryType::StepAttemptStarted).len(),
            1,
            "{case}"
        );
        let completions = of_type(&all, EntryType::StepCompleted);
        assert_eq!(completions.len(), 1, "{case}: {completions:?}");
        let completed: StepCompletedPayload =
            serde_json::from_value(completions[0].payload.clone()).unwrap();
        assert_eq!(completed.completion_reason, reason, "{case}");
        assert_eq!(completed.disposition, Disposition::Park, "{case}");
        assert_eq!(
            completed.trajectory_tail,
            Some(json!({"transport": {"cause": "signal_close"}})),
            "{case}: the worker's transport evidence rides the park"
        );
        let wait = parked_wait(&engine, &run_id);
        assert_eq!(engine.snapshot(&run_id).unwrap().status, RunStatus::Parked);

        // A fresh engine over the same data dir is a restarted daemon. Resume
        // must leave the park alone: no redispatch before a human resolves it.
        drop(engine);
        let reopened = Engine::with_runtime(dir.path(), worker.clone(), worker.clone());
        let resumed = reopened.resume(&run_id, None).unwrap();
        assert_eq!(resumed.status, RunStatus::Parked, "{case}");
        assert_eq!(
            worker.dispatches().len(),
            1,
            "{case}: resume redispatched a parked step"
        );
        assert_eq!(
            entries(&reopened, &run_id).len(),
            all.len(),
            "{case}: resume must not append to a cleanly parked run"
        );

        // Only the human's answer ends the park, and the replacement attempt
        // starts on the pinned revision (Appendix A rule 4, `manual`).
        answer_retry(&reopened, &run_id, &wait.wait_id);
        let dispatches = worker.dispatches();
        assert_eq!(dispatches.len(), 2, "{case}: the answer must redispatch");
        assert_eq!(dispatches[1].attempt, 2, "{case}");
        assert_eq!(dispatches[1].pins, pinned("rev-0"), "{case}");
        assert_eq!(
            dispatches[1].idempotency_key, first.idempotency_key,
            "{case}: the replacement keeps the idempotency key"
        );
    }
}

/// A park is two appends and each append is its own transaction. Die after
/// the first and the run is parked on a placeholder nobody can answer — unless
/// resume notices and journals the wait it never wrote.
#[test]
fn a_park_torn_between_its_two_appends_is_repaired_on_resume() {
    let dir = tempfile::tempdir().unwrap();
    let worker = Arc::new(AgentWorker::crashing_after_park());
    let engine = Engine::with_runtime(dir.path(), worker.clone(), worker.clone());
    let started = engine.start(manual_spec(1), "test", None).unwrap();
    let run_id = started.run_id.clone();
    let first = worker.dispatches().remove(0);

    let died = catch_unwind(AssertUnwindSafe(|| {
        engine.complete_out_of_band(
            &run_id,
            "edit",
            transport_loss(&first, CompletionReason::Crashed),
        )
    }));
    assert!(
        died.is_err(),
        "the injected crash must fire after the park append"
    );
    drop(engine);

    let torn = Engine::new(dir.path());
    let prefix = entries(&torn, &run_id);
    let completions = of_type(&prefix, EntryType::StepCompleted);
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0].payload["disposition"], "park");
    assert!(
        of_type(&prefix, EntryType::WaitHuman).is_empty(),
        "the crash landed before the wait.human: {prefix:?}"
    );
    assert_eq!(torn.snapshot(&run_id).unwrap().status, RunStatus::Parked);

    // Resume repairs the torn park: the wait is journaled once, from the
    // journaled start pins, and nothing is dispatched.
    let reopened = Engine::with_runtime(dir.path(), worker.clone(), worker.clone());
    assert_eq!(
        reopened.resume(&run_id, None).unwrap().status,
        RunStatus::Parked
    );
    let wait = parked_wait(&reopened, &run_id);
    assert_eq!(worker.dispatches().len(), 1, "repair must not redispatch");

    // Resuming again adds nothing: the repair is idempotent.
    assert_eq!(
        reopened.resume(&run_id, None).unwrap().status,
        RunStatus::Parked
    );
    assert_eq!(parked_wait(&reopened, &run_id).wait_id, wait.wait_id);

    // And the repaired wait is a real one: a human can end it.
    answer_retry(&reopened, &run_id, &wait.wait_id);
    let dispatches = worker.dispatches();
    assert_eq!(dispatches.len(), 2);
    assert_eq!(dispatches[1].attempt, 2);
    assert_eq!(dispatches[1].pins, pinned("rev-0"));
}
