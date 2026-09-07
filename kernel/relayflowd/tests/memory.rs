use relayflowd::{
    Engine, RunStatus,
    memory::{MemoryPack, MemoryProvider},
    worker::{DispatchOutcome, JournalObserver, StepDispatch, StepDispatcher},
};
use relayflowd_core::{
    Budget, CompletionReason, EntryType, JournalEntry, MemorySpec, RunSpec, RunState,
    StepCompletedPayload, StepType,
};
use serde_json::json;
use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

struct Provider {
    calls: AtomicUsize,
    fail: bool,
    name: &'static str,
}
impl Provider {
    fn new() -> Self {
        Self {
            calls: AtomicUsize::new(0),
            fail: false,
            name: "test",
        }
    }
}
impl MemoryProvider for Provider {
    fn name(&self) -> &str {
        self.name
    }
    fn provide(&self, _: &str, _: &str, _: &MemorySpec) -> anyhow::Result<MemoryPack> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        anyhow::ensure!(!self.fail, "provider must be unavailable during replay");
        Ok(MemoryPack {
            pack: json!({"call": call, "text": "recorded context"}),
            budget: Budget {
                tokens_in: 7,
                tokens_out: 0,
                dollars: "0.002".into(),
            },
        })
    }
}

#[derive(Default)]
struct Runtime {
    crash_on_injection: bool,
    run_id: Mutex<Option<String>>,
    dispatches: Mutex<Vec<StepDispatch>>,
    released: AtomicUsize,
}
impl JournalObserver for Runtime {
    fn appended(&self, entry: &JournalEntry) {
        if entry.entry_type == EntryType::RunSpawned {
            *self.run_id.lock().unwrap() = Some(entry.run_id.clone());
        }
        if self.crash_on_injection && entry.entry_type == EntryType::MemoryInjected {
            panic!("crash after committed injection, before execution");
        }
    }
}
impl StepDispatcher for Runtime {
    fn executor(&self, _: StepType) -> Option<String> {
        Some("test".into())
    }
    fn available(&self, _: StepType) -> bool {
        true
    }
    fn release_dispatch_reservation(&self, _: &str, _: &str, _: u32) {
        self.released.fetch_add(1, Ordering::SeqCst);
    }
    fn dispatch(&self, dispatch: StepDispatch) -> anyhow::Result<DispatchOutcome> {
        self.dispatches.lock().unwrap().push(dispatch);
        Ok(DispatchOutcome::Dispatched)
    }
}
fn spec(kind: &str, cap: u64) -> RunSpec {
    let mut step = json!({"id":"consume", "type":kind, "memory":{"scope":"script","query":"lessons","budget":{"max_tokens_in":cap,"max_dollars":"0.002"}}});
    if kind == "deterministic" {
        step["command"] = json!("printf '%s' \"$RELAYFLOW_MEMORY\"");
    } else {
        step["prompt"] = json!("read context");
        step["model"] = json!("stub");
    }
    RunSpec::parse(&json!({"steps":[step]})).unwrap()
}
fn engine(dir: &std::path::Path, runtime: Arc<Runtime>, provider: Arc<Provider>) -> Engine {
    Engine::with_runtime(dir, runtime.clone(), runtime).with_memory_provider(provider)
}

#[test]
fn replay_and_resume_need_no_provider_and_script_receives_recorded_pack() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = Arc::new(Runtime {
        crash_on_injection: true,
        ..Runtime::default()
    });
    let provider = Arc::new(Provider::new());
    let before = engine(dir.path(), runtime.clone(), provider.clone());
    assert!(
        catch_unwind(AssertUnwindSafe(|| before.start(
            spec("deterministic", 7),
            "test",
            None
        )))
        .is_err()
    );
    let run_id = runtime.run_id.lock().unwrap().clone().unwrap();
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    let entries = before.journal_entries(&run_id, 0, 1000).unwrap();
    let replay = RunState::fold(&run_id, spec("deterministic", 7), &entries).unwrap();
    let injected = replay.steps["consume"].memory.clone().unwrap();
    assert_eq!(injected.pack, json!({"call":0,"text":"recorded context"}));
    assert_eq!(replay.budget, injected.budget);

    let unavailable = Arc::new(Provider {
        fail: true,
        ..Provider::new()
    });
    let after = engine(
        dir.path(),
        Arc::new(Runtime::default()),
        unavailable.clone(),
    );
    assert_eq!(
        after.resume(&run_id, None).unwrap().status,
        RunStatus::Completed
    );
    assert_eq!(after.snapshot(&run_id).unwrap().budget, injected.budget);
    let entries = after.journal_entries(&run_id, 0, 1000).unwrap();
    assert_eq!(
        entries
            .iter()
            .filter(|e| e.entry_type == EntryType::MemoryInjected)
            .count(),
        1
    );
    let completion: StepCompletedPayload = serde_json::from_value(
        entries
            .iter()
            .rev()
            .find(|e| e.entry_type == EntryType::StepCompleted)
            .unwrap()
            .payload
            .clone(),
    )
    .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(
            completion.output["stdout_tail"].as_str().unwrap()
        )
        .unwrap(),
        injected.pack
    );
    assert_eq!(unavailable.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn llm_dispatch_receives_same_pack_after_resume_without_provider() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = Arc::new(Runtime::default());
    let provider = Arc::new(Provider::new());
    let before = engine(dir.path(), runtime.clone(), provider.clone());
    let run = before.start(spec("llm", 7), "test", None).unwrap();
    let first = runtime.dispatches.lock().unwrap()[0].clone();
    let unavailable = Arc::new(Provider {
        fail: true,
        ..Provider::new()
    });
    let after = engine(dir.path(), runtime.clone(), unavailable.clone());
    after.resume(&run.run_id, None).unwrap();
    let second = runtime.dispatches.lock().unwrap()[1].clone();
    assert_eq!(second.attempt, 2);
    assert_eq!(second.memory, first.memory);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert_eq!(unavailable.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        after.snapshot(&run.run_id).unwrap().budget,
        first.memory.unwrap().budget
    );
}

#[test]
fn over_budget_and_provider_errors_fail_without_dispatch_or_charge() {
    for (cap, fail, reason) in [
        (6, false, CompletionReason::BudgetExceeded),
        (7, true, CompletionReason::WorkerError),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Arc::new(Runtime::default());
        let provider = Arc::new(Provider {
            fail,
            ..Provider::new()
        });
        let engine = engine(dir.path(), runtime.clone(), provider);
        let run = engine.start(spec("llm", cap), "test", None).unwrap();
        assert_eq!(run.status, RunStatus::Failed);
        assert!(runtime.dispatches.lock().unwrap().is_empty());
        assert_eq!(runtime.released.load(Ordering::SeqCst), 1);
        assert_eq!(
            engine.snapshot(&run.run_id).unwrap().budget,
            Budget::default()
        );
        let entries = engine.journal_entries(&run.run_id, 0, 1000).unwrap();
        assert!(
            entries
                .iter()
                .all(|e| e.entry_type != EntryType::MemoryInjected)
        );
        let completion: StepCompletedPayload = serde_json::from_value(
            entries
                .iter()
                .find(|e| e.entry_type == EntryType::StepCompleted)
                .unwrap()
                .payload
                .clone(),
        )
        .unwrap();
        assert_eq!(completion.completion_reason, reason);
    }
}

#[test]
fn rejected_journal_fact_releases_reservation_and_never_dispatches() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = Arc::new(Runtime::default());
    let provider = Arc::new(Provider {
        name: "",
        ..Provider::new()
    });
    let engine = engine(dir.path(), runtime.clone(), provider);
    let error = engine.start(spec("llm", 7), "test", None).unwrap_err();
    assert!(format!("{error:#}").contains("name its provider"));
    assert!(runtime.dispatches.lock().unwrap().is_empty());
    assert_eq!(runtime.released.load(Ordering::SeqCst), 1);
    let run_id = runtime.run_id.lock().unwrap().clone().unwrap();
    assert_eq!(engine.snapshot(&run_id).unwrap().budget, Budget::default());
    assert!(
        engine
            .journal_entries(&run_id, 0, 1000)
            .unwrap()
            .iter()
            .all(|e| e.entry_type != EntryType::MemoryInjected)
    );
}

#[test]
fn semantic_retry_reuses_memory_without_a_second_charge() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("first-attempt");
    let mut value = serde_json::to_value(spec("deterministic", 7)).unwrap();
    value["steps"][0]["max_iterations"] = json!(2);
    value["steps"][0]["retry"] =
        json!({"initial_backoff_ms":0,"max_backoff_ms":0,"multiplier":1,"jitter_percent":0});
    value["steps"][0]["command"] = json!(format!(
        "if test -f '{}'; then printf '%s' \"$RELAYFLOW_MEMORY\"; else touch '{}'; exit 1; fi",
        marker.display(),
        marker.display()
    ));
    let provider = Arc::new(Provider::new());
    let engine = Engine::new(dir.path()).with_memory_provider(provider.clone());
    let run = engine
        .start(RunSpec::parse(&value).unwrap(), "test", None)
        .unwrap();
    assert_eq!(run.status, RunStatus::Completed);
    let entries = engine.journal_entries(&run.run_id, 0, 1000).unwrap();
    assert_eq!(
        entries
            .iter()
            .filter(|e| e.entry_type == EntryType::StepAttemptStarted)
            .count(),
        2
    );
    assert_eq!(
        entries
            .iter()
            .filter(|e| e.entry_type == EntryType::MemoryInjected)
            .count(),
        1
    );
    let last: StepCompletedPayload = serde_json::from_value(
        entries
            .iter()
            .rev()
            .find(|e| e.entry_type == EntryType::StepCompleted)
            .unwrap()
            .payload
            .clone(),
    )
    .unwrap();
    let pack: serde_json::Value =
        serde_json::from_str(last.output["stdout_tail"].as_str().unwrap()).unwrap();
    assert_eq!(pack, json!({"call":0,"text":"recorded context"}));
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        engine.snapshot(&run.run_id).unwrap().budget,
        Budget {
            tokens_in: 7,
            tokens_out: 0,
            dollars: "0.002".into()
        }
    );
}
