use relayflowd::{
    Engine, RunStatus,
    memory::{FixedMemoryProvider, MemoryPack, MemoryProvider},
    worker::{DispatchOutcome, JournalObserver, StepDispatch, StepDispatcher},
};
use relayflowd_core::{
    Budget, EntryType, EpochSummaryPayload, Journal, JournalEntry, MemorySpec, RunSpec, RunState,
    StepOpenSummary, StepType,
};
use relayflowd_journal::SqliteJournal;
use serde_json::json;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

struct OnceProvider(AtomicUsize);
impl MemoryProvider for OnceProvider {
    fn name(&self) -> &str {
        "once"
    }
    fn provide(&self, run: &str, step: &str, request: &MemorySpec) -> anyhow::Result<MemoryPack> {
        assert_eq!(
            self.0.fetch_add(1, Ordering::SeqCst),
            0,
            "epoch resume must reuse its pack"
        );
        FixedMemoryProvider.provide(run, step, request)
    }
}

#[test]
fn epoch_carries_pack_and_exact_charge_and_refuses_duplicate_injection() {
    let dir = tempfile::tempdir().unwrap();
    let provider = Arc::new(OnceProvider(AtomicUsize::new(0)));
    let runtime = Arc::new(Runtime::default());
    let engine = Engine::with_runtime(dir.path(), runtime.clone(), runtime.clone())
        .with_memory_provider(provider.clone());
    let spec = RunSpec::parse(&json!({"steps":[{"id":"s", "type":"llm", "prompt":"context", "model":"stub", "max_iterations":2, "memory":{"scope":"script", "query":"lessons", "budget":{}}}]})).unwrap();
    let run = engine.start(spec.clone(), "test", None).unwrap();
    let first = runtime.0.lock().unwrap()[0].clone();
    let mut journal = SqliteJournal::open(
        dir.path()
            .join("runs")
            .join(format!("{}.sqlite3", run.run_id)),
    )
    .unwrap();
    let entries = journal.scan_all().unwrap();
    let memory = entries
        .iter()
        .find(|e| e.entry_type == EntryType::MemoryInjected)
        .unwrap()
        .clone();
    let mut summary = EpochSummaryPayload {
        epoch: 0,
        prev_segment_id: 0,
        journal_version: relayflowd_core::JOURNAL_VERSION,
        steps_done: BTreeMap::new(),
        steps_open: BTreeMap::from([(
            "s".into(),
            StepOpenSummary {
                attempt: 1,
                state: "running".into(),
                lease_deadline_ms: Some(first.lease_deadline_ms),
                wake_at_ms: None,
                idempotency_key: Some(first.idempotency_key.clone()),
            },
        )]),
        open_waits: BTreeMap::new(),
        stream_state: BTreeMap::new(),
        pinned_revisions: BTreeMap::new(),
        budget_spent: Budget::default(),
        memory: BTreeMap::new(),
        routing: BTreeMap::new(),
    };
    assert!(
        journal
            .rollover(summary.clone(), 100)
            .unwrap_err()
            .0
            .contains("preserve recorded memory spend")
    );
    assert_eq!(
        journal.scan_all().unwrap(),
        entries,
        "failed rollover is atomic"
    );
    summary.budget_spent = engine.snapshot(&run.run_id).unwrap().budget;
    let rolled = journal.rollover(summary, 100).unwrap();
    let state = RunState::fold(&run.run_id, spec.clone(), &rolled[1..]).unwrap();
    assert_eq!(
        serde_json::to_value(state.steps["s"].memory.as_ref().unwrap()).unwrap(),
        memory.payload
    );
    assert_eq!(state.budget, engine.snapshot(&run.run_id).unwrap().budget);
    let full = journal.scan_all().unwrap();
    let mut duplicate = memory.clone();
    duplicate.segment_id = 0;
    assert!(
        journal
            .append(&duplicate)
            .unwrap_err()
            .0
            .contains("cannot inject memory twice")
    );
    assert_eq!(
        journal.scan_all().unwrap(),
        full,
        "duplicate injection cannot commit"
    );
    let replay = RunState::fold(&run.run_id, spec, &full).unwrap();
    assert_eq!(replay.budget, state.budget);
    assert_eq!(replay.steps["s"].memory, state.steps["s"].memory);
    assert_eq!(
        engine.resume(&run.run_id, None).unwrap().status,
        RunStatus::Parked
    );
    let second = runtime.0.lock().unwrap()[1].clone();
    assert_eq!(second.attempt, 2);
    assert_eq!(second.memory, first.memory);
    assert_eq!(provider.0.load(Ordering::SeqCst), 1);
    assert_eq!(engine.snapshot(&run.run_id).unwrap().budget, state.budget);
}

#[derive(Default)]
struct Runtime(Mutex<Vec<StepDispatch>>);
impl JournalObserver for Runtime {
    fn appended(&self, _: &JournalEntry) {}
}
impl StepDispatcher for Runtime {
    fn executor(&self, _: StepType) -> Option<String> {
        Some("test".into())
    }
    fn available(&self, _: StepType) -> bool {
        true
    }
    fn dispatch(&self, dispatch: StepDispatch) -> anyhow::Result<DispatchOutcome> {
        self.0.lock().unwrap().push(dispatch);
        Ok(DispatchOutcome::Dispatched)
    }
}
