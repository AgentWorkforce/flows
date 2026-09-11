use std::{
    collections::BTreeSet,
    fs,
    os::unix::process::CommandExt,
    panic::{AssertUnwindSafe, catch_unwind},
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use relayflowd::worker::{DispatchOutcome, JournalObserver, StepDispatch, StepDispatcher};
use relayflowd::{DriveOptions, Engine, OutOfBandCompletion, RunStatus};
use relayflowd_core::{
    Budget, CompletionReason, EntryType, JournalEntry, RunSpec, StepCompletedPayload, StepType,
};
use serde_json::json;
use tempfile::tempdir;

#[derive(Default)]
struct StartCrashObserver {
    crash_step: Option<&'static str>,
    crashed: AtomicBool,
    run_id: Mutex<Option<String>>,
}

impl StartCrashObserver {
    fn crashing_at(step_id: &'static str) -> Self {
        Self {
            crash_step: Some(step_id),
            ..Self::default()
        }
    }

    fn run_id(&self) -> String {
        self.run_id.lock().unwrap().clone().unwrap()
    }
}

impl JournalObserver for StartCrashObserver {
    fn appended(&self, entry: &JournalEntry) {
        if entry.entry_type == EntryType::RunSpawned {
            *self.run_id.lock().unwrap() = Some(entry.run_id.clone());
        }
        if entry.entry_type == EntryType::StepAttemptStarted
            && entry.step_id.as_deref() == self.crash_step
            && !self.crashed.swap(true, Ordering::SeqCst)
        {
            panic!("injected crash after durable start append");
        }
    }
}

#[derive(Default)]
struct RecordingDispatcher {
    crash_step: Option<&'static str>,
    mismatch_step: Option<&'static str>,
    no_worker_step: Option<&'static str>,
    crash_fired: AtomicBool,
    agent_available: bool,
    calls: Mutex<Vec<StepDispatch>>,
    effects: Mutex<BTreeSet<(String, String)>>,
}

impl RecordingDispatcher {
    fn llm() -> Self {
        Self::default()
    }

    fn crashing_at(step_id: &'static str) -> Self {
        Self {
            crash_step: Some(step_id),
            ..Self::default()
        }
    }

    fn mismatching(step_id: &'static str) -> Self {
        Self {
            mismatch_step: Some(step_id),
            ..Self::default()
        }
    }

    fn detaching_at(step_id: &'static str) -> Self {
        Self {
            no_worker_step: Some(step_id),
            ..Self::default()
        }
    }

    fn transient_mixed_failure() -> Self {
        Self {
            no_worker_step: Some("lane-b"),
            mismatch_step: Some("lane-a"),
            ..Self::default()
        }
    }

    fn calls(&self) -> Vec<StepDispatch> {
        self.calls.lock().unwrap().clone()
    }
}

impl StepDispatcher for RecordingDispatcher {
    fn executor(&self, _step_type: StepType) -> Option<String> {
        Some("parallel-driver-test".to_owned())
    }

    fn available(&self, step_type: StepType) -> bool {
        step_type == StepType::Llm || (step_type == StepType::Agent && self.agent_available)
    }

    fn dispatch(&self, dispatch: StepDispatch) -> anyhow::Result<DispatchOutcome> {
        self.calls.lock().unwrap().push(dispatch.clone());
        if dispatch.attempt == 1 && self.no_worker_step == Some(dispatch.step_id.as_str()) {
            return Ok(DispatchOutcome::NoWorker);
        }
        if dispatch.attempt == 1 && self.mismatch_step == Some(dispatch.step_id.as_str()) {
            return Ok(DispatchOutcome::PinMismatch {
                detail: "injected replacement pin mismatch".to_owned(),
            });
        }
        self.effects
            .lock()
            .unwrap()
            .insert((dispatch.step_id.clone(), dispatch.idempotency_key.clone()));
        if self.crash_step == Some(dispatch.step_id.as_str())
            && !self.crash_fired.swap(true, Ordering::SeqCst)
        {
            panic!("injected crash after worker handoff");
        }
        Ok(DispatchOutcome::Dispatched)
    }
}

fn parallel_llm_spec() -> RunSpec {
    RunSpec::parse(&json!({
        "name": "parallel-driver",
        "steps": [
            {
                "id": "lane-b",
                "type": "llm",
                "prompt": "b",
                "model": "stub",
                "max_iterations": 2,
                "retry": {"initial_backoff_ms": 0, "max_backoff_ms": 0, "multiplier": 1, "jitter_percent": 0}
            },
            {
                "id": "lane-a",
                "type": "llm",
                "prompt": "a",
                "model": "stub",
                "max_iterations": 2,
                "retry": {"initial_backoff_ms": 0, "max_backoff_ms": 0, "multiplier": 1, "jitter_percent": 0}
            }
        ]
    }))
    .unwrap()
}

fn complete(engine: &Engine, run_id: &str, dispatch: &StepDispatch) -> RunStatus {
    engine
        .complete_out_of_band(
            run_id,
            &dispatch.step_id,
            OutOfBandCompletion {
                human_intervention: false,
                attempt: dispatch.attempt,
                idempotency_key: dispatch.idempotency_key.clone(),
                completion_reason: CompletionReason::Success,
                output: json!({"answer": dispatch.step_id}),
                budget: Budget::default(),
                completed_by: "parallel-driver-test".to_owned(),
                started_pins: None,
                end_pins: None,
                effects: Vec::new(),
                trajectory_tail: None,
            },
        )
        .unwrap()
        .status
}

#[test]
fn crash_boundaries_resume_the_real_driver_with_one_effect_per_lane() {
    enum Boundary {
        FirstStart,
        FirstDispatch,
        AllStarts,
    }

    for boundary in [
        Boundary::FirstStart,
        Boundary::FirstDispatch,
        Boundary::AllStarts,
    ] {
        let directory = tempdir().unwrap();
        let observer = Arc::new(match boundary {
            Boundary::FirstStart => StartCrashObserver::crashing_at("lane-b"),
            Boundary::AllStarts => StartCrashObserver::crashing_at("lane-a"),
            Boundary::FirstDispatch => StartCrashObserver::default(),
        });
        let dispatcher = Arc::new(match boundary {
            Boundary::FirstDispatch => RecordingDispatcher::crashing_at("lane-b"),
            _ => RecordingDispatcher::llm(),
        });
        let engine = Engine::with_runtime(directory.path(), dispatcher.clone(), observer.clone());

        let crashed = catch_unwind(AssertUnwindSafe(|| {
            engine.start(parallel_llm_spec(), "test", None)
        }));
        assert!(crashed.is_err(), "the selected driver boundary must crash");
        let run_id = observer.run_id();

        let resumed = engine.resume(&run_id, None).unwrap();
        assert_eq!(resumed.status, RunStatus::Parked);
        let calls = dispatcher.calls();
        let active = ["lane-a", "lane-b"].map(|step_id| {
            calls
                .iter()
                .filter(|dispatch| dispatch.step_id == step_id)
                .max_by_key(|dispatch| dispatch.attempt)
                .unwrap()
                .clone()
        });

        // Complete in reverse authored order; the barrier is the journaled
        // state, not the order in which independent workers return.
        assert_eq!(complete(&engine, &run_id, &active[0]), RunStatus::Parked);
        assert_eq!(complete(&engine, &run_id, &active[1]), RunStatus::Completed);

        let effects = dispatcher.effects.lock().unwrap();
        assert_eq!(effects.len(), 2, "one deduplicated effect per lane");
        for step_id in ["lane-b", "lane-a"] {
            assert_eq!(
                effects.iter().filter(|(step, _)| step == step_id).count(),
                1,
                "{step_id} must keep one effect identity across recovery"
            );
            let keys = calls
                .iter()
                .filter(|dispatch| dispatch.step_id == step_id)
                .map(|dispatch| dispatch.idempotency_key.as_str())
                .collect::<BTreeSet<_>>();
            assert_eq!(keys.len(), 1, "{step_id} idempotency key changed");
        }
        drop(effects);

        let entries = engine.journal_entries(&run_id, 1, usize::MAX).unwrap();
        for step_id in ["lane-b", "lane-a"] {
            let successes = entries
                .iter()
                .filter(|entry| {
                    entry.entry_type == EntryType::StepCompleted
                        && entry.step_id.as_deref() == Some(step_id)
                })
                .filter(|entry| {
                    serde_json::from_value::<StepCompletedPayload>(entry.payload.clone())
                        .unwrap()
                        .completion_reason
                        == CompletionReason::Success
                })
                .count();
            assert_eq!(successes, 1, "{step_id} must succeed exactly once");
        }
    }
}

#[test]
fn backpressured_or_mismatched_lane_does_not_drop_a_later_dispatch() {
    let mixed_spec = RunSpec::parse(&json!({
        "name": "mixed-backpressure",
        "steps": [
            {
                "id": "agent-unavailable",
                "type": "agent",
                "instruction": "edit",
                "recovery_mode": "inspect",
                "surfaces": {"workspace": [], "streams": [], "external": []}
            },
            {"id": "llm-ready", "type": "llm", "prompt": "ready", "model": "stub"}
        ]
    }))
    .unwrap();
    let directory = tempdir().unwrap();
    let dispatcher = Arc::new(RecordingDispatcher::llm());
    let observer = Arc::new(StartCrashObserver::default());
    let engine = Engine::with_runtime(directory.path(), dispatcher.clone(), observer.clone());
    assert_eq!(
        engine.start(mixed_spec, "test", None).unwrap().status,
        RunStatus::Parked
    );
    assert_eq!(
        dispatcher
            .calls()
            .iter()
            .map(|dispatch| dispatch.step_id.as_str())
            .collect::<Vec<_>>(),
        ["llm-ready"]
    );
    let entries = engine
        .journal_entries(&observer.run_id(), 1, usize::MAX)
        .unwrap();
    assert!(!entries.iter().any(|entry| {
        entry.entry_type == EntryType::StepAttemptStarted
            && entry.step_id.as_deref() == Some("agent-unavailable")
    }));

    let directory = tempdir().unwrap();
    let dispatcher = Arc::new(RecordingDispatcher::mismatching("lane-b"));
    let observer = Arc::new(StartCrashObserver::default());
    let engine = Engine::with_runtime(directory.path(), dispatcher.clone(), observer);
    engine.start(parallel_llm_spec(), "test", None).unwrap();
    assert_eq!(
        dispatcher
            .calls()
            .iter()
            .map(|dispatch| dispatch.step_id.as_str())
            .collect::<Vec<_>>(),
        ["lane-b", "lane-a"],
        "a mismatched first lane must not discard the later dispatch"
    );

    let directory = tempdir().unwrap();
    let dispatcher = Arc::new(RecordingDispatcher::detaching_at("lane-b"));
    let observer = Arc::new(StartCrashObserver::default());
    let engine = Engine::with_runtime(directory.path(), dispatcher.clone(), observer.clone());
    engine.start(parallel_llm_spec(), "test", None).unwrap();
    assert_eq!(
        dispatcher
            .calls()
            .iter()
            .map(|dispatch| dispatch.step_id.as_str())
            .collect::<Vec<_>>(),
        ["lane-b", "lane-a"],
        "a detach race on the first lane must not discard the later dispatch"
    );
    let entries = engine
        .journal_entries(&observer.run_id(), 1, usize::MAX)
        .unwrap();
    assert!(entries.iter().any(|entry| {
        entry.entry_type == EntryType::StepCompleted
            && entry.step_id.as_deref() == Some("lane-b")
            && serde_json::from_value::<StepCompletedPayload>(entry.payload.clone())
                .unwrap()
                .completion_reason
                == CompletionReason::Crashed
    }));

    let directory = tempdir().unwrap();
    let dispatcher = Arc::new(RecordingDispatcher::transient_mixed_failure());
    let observer = Arc::new(StartCrashObserver::default());
    let engine = Engine::with_runtime(directory.path(), dispatcher.clone(), observer);
    assert_eq!(
        engine
            .start(parallel_llm_spec(), "test", None)
            .unwrap()
            .status,
        RunStatus::Parked
    );
    assert_eq!(
        dispatcher
            .calls()
            .iter()
            .map(|dispatch| (dispatch.step_id.as_str(), dispatch.attempt))
            .collect::<Vec<_>>(),
        [("lane-b", 1), ("lane-a", 1), ("lane-b", 2), ("lane-a", 2)],
        "a compatible replacement must receive due retries without an external resume"
    );
}

#[test]
fn stop_after_one_holds_for_an_independent_deterministic_batch() {
    let spec = RunSpec::parse(&json!({
        "name": "deterministic-stop",
        "steps": [
            {"id": "first", "type": "deterministic", "command": "true"},
            {"id": "second", "type": "deterministic", "command": "true"}
        ]
    }))
    .unwrap();
    let directory = tempdir().unwrap();
    let engine = Engine::new(directory.path());
    let outcome = engine
        .start_with_options(
            spec,
            "test",
            DriveOptions {
                stop_after: Some(1),
                ..DriveOptions::default()
            },
        )
        .unwrap();
    assert_eq!(outcome.status, RunStatus::Interrupted);
    assert_eq!(outcome.completed_steps, 1);
    let entries = engine
        .journal_entries(&outcome.run_id, 1, usize::MAX)
        .unwrap();
    assert!(!entries.iter().any(|entry| {
        entry.entry_type == EntryType::StepAttemptStarted
            && entry.step_id.as_deref() == Some("second")
    }));
}

#[test]
fn pause_before_second_independent_step_holds_the_driver_boundary() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path().join("data");
    let marker = directory.path().join("effects.txt");
    let spec_path = directory.path().join("parallel.json");
    let spec = json!({
        "name": "deterministic-pause",
        "steps": [
            {
                "id": "first",
                "type": "deterministic",
                "command": ["/bin/sh", "-c", format!("printf 'first\\n' >> '{}'", marker.display())]
            },
            {
                "id": "second",
                "type": "deterministic",
                "command": ["/bin/sh", "-c", format!("printf 'second\\n' >> '{}'", marker.display())]
            }
        ]
    });
    fs::write(&spec_path, serde_json::to_vec(&spec).unwrap()).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_relayflowd"))
        .args([
            "--data-dir",
            data_dir.to_str().unwrap(),
            "run",
            spec_path.to_str().unwrap(),
            "--pause-before-step",
            "second",
        ])
        .process_group(0)
        .spawn()
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(15);
    while fs::read_to_string(&marker).unwrap_or_default() != "first\n" {
        assert!(
            Instant::now() < deadline,
            "driver never reached second lane"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let run_id = fs::read_dir(data_dir.join("runs"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
        .file_stem()
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    let entries = Engine::new(&data_dir)
        .journal_entries(&run_id, 1, usize::MAX)
        .unwrap();
    assert!(!entries.iter().any(|entry| {
        entry.entry_type == EntryType::StepAttemptStarted
            && entry.step_id.as_deref() == Some("second")
    }));

    // SAFETY: kill(2) with a negative process-group id does not access memory.
    assert_eq!(
        unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) },
        0
    );
    assert!(!child.wait().unwrap().success());
    assert_eq!(
        Engine::new(&data_dir).resume(&run_id, None).unwrap().status,
        RunStatus::Completed
    );
    assert_eq!(fs::read_to_string(marker).unwrap(), "first\nsecond\n");
}
