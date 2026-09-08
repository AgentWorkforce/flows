use relayflowd::{
    Engine,
    worker::{DispatchOutcome, JournalObserver, StepDispatch, StepDispatcher},
};
use relayflowd_core::{
    CompletionReason, EntryType, EpochSummaryPayload, Journal, JournalEntry, Pins, RoutingDecision,
    RunSpec, RunState, StepSpec, StepType, WorkspacePin,
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
use tempfile::tempdir;

#[derive(Default)]
struct FixedProvider {
    decisions: AtomicUsize,
    dispatched: Mutex<Vec<StepDispatch>>,
}
impl JournalObserver for FixedProvider {
    fn appended(&self, _: &JournalEntry) {}
}
impl StepDispatcher for FixedProvider {
    fn available(&self, _: StepType) -> bool {
        true
    }
    fn executor(&self, _: StepType) -> Option<String> {
        Some("cloud-worker".into())
    }
    fn starting_pins(&self, _: &StepSpec) -> anyhow::Result<Pins> {
        Ok(Pins {
            workspace: vec![WorkspacePin {
                surface: "/repo".into(),
                revision_id: "relayfile-revision-1".into(),
            }],
            streams: vec![],
        })
    }
    fn routing_decision(&self, _: &str, _: &StepSpec, _: u32) -> anyhow::Result<RoutingDecision> {
        assert_eq!(
            self.decisions.fetch_add(1, Ordering::SeqCst),
            0,
            "replay must not call the router again"
        );
        Ok(RoutingDecision {
            profile: "interactive".into(),
            provider: "test-cloud-adapter".into(),
            fallbacks_attempted: vec!["unavailable-pool".into()],
            workspace: Some("sandbox-for-run".into()),
        })
    }
    fn dispatch(&self, dispatch: StepDispatch) -> anyhow::Result<DispatchOutcome> {
        self.dispatched.lock().unwrap().push(dispatch);
        Ok(DispatchOutcome::Dispatched)
    }
}

#[test]
fn worker_retry_consumes_the_original_routing_fact() {
    let directory = tempdir().unwrap();
    let provider = Arc::new(FixedProvider::default());
    let engine = Engine::with_runtime(directory.path(), provider.clone(), provider.clone());
    let spec = RunSpec::parse(&json!({"steps":[{"id":"edit","type":"agent","instruction":"edit",
        "requirements":{"workspace":true,"execution":"interactive"},"surfaces":{"workspace":[{"surface":"/repo"}]}}]})).unwrap();
    let run = engine.start(spec.clone(), "test", None).unwrap();
    engine
        .abandon_out_of_band(&run.run_id, "edit", 1, CompletionReason::Crashed)
        .unwrap();
    let engine = Engine::with_runtime(directory.path(), provider.clone(), provider.clone());
    engine.resume(&run.run_id, None).unwrap();
    let dispatches = provider.dispatched.lock().unwrap();
    assert_eq!(dispatches.len(), 2);
    assert_eq!(dispatches[0].routing, dispatches[1].routing);
    assert_eq!(dispatches[0].pins, dispatches[1].pins);
    assert_eq!(dispatches[1].attempt, 2);
    assert_eq!(provider.decisions.load(Ordering::SeqCst), 1);
    let mut journal = SqliteJournal::open(
        directory
            .path()
            .join("runs")
            .join(format!("{}.sqlite3", run.run_id)),
    )
    .unwrap();
    let before = RunState::fold(&run.run_id, spec.clone(), &journal.scan_all().unwrap()).unwrap();
    let duplicate = JournalEntry::new(
        EntryType::StepRouted,
        &run.run_id,
        Some("edit".into()),
        None,
        10,
        &dispatches[0].routing,
    );
    assert!(
        journal.append(&duplicate).is_err(),
        "duplicate routing must fail in the append transaction"
    );
    let unknown = JournalEntry::new(
        EntryType::StepRouted,
        &run.run_id,
        Some("unknown".into()),
        None,
        10,
        &dispatches[0].routing,
    );
    assert!(
        journal.append(&unknown).is_err(),
        "an undeclared step cannot acquire a route"
    );
    let summary = EpochSummaryPayload {
        epoch: 0,
        prev_segment_id: 0,
        journal_version: 1,
        steps_done: BTreeMap::new(),
        steps_open: BTreeMap::new(),
        open_waits: BTreeMap::new(),
        stream_state: BTreeMap::new(),
        pinned_revisions: BTreeMap::new(),
        budget_spent: before.budget,
        memory: BTreeMap::new(),
        routing: BTreeMap::new(),
    };
    journal.rollover(summary, 20).unwrap();
    let after = RunState::fold(
        &run.run_id,
        spec,
        &journal
            .scan_segment(journal.current_segment().unwrap())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        before.routing, after.routing,
        "epoch automatically retains routing decisions"
    );
    assert!(
        journal.append(&duplicate).is_err(),
        "rollover must not permit a second choice"
    );
}

struct RejectRoutingWrites(std::path::PathBuf, Mutex<Option<String>>);
impl JournalObserver for RejectRoutingWrites {
    fn appended(&self, entry: &JournalEntry) {
        if entry.entry_type == EntryType::RunSpawned {
            *self.1.lock().unwrap() = Some(entry.run_id.clone());
            let connection = rusqlite::Connection::open(
                self.0
                    .join("runs")
                    .join(format!("{}.sqlite3", entry.run_id)),
            )
            .unwrap();
            connection.execute_batch("CREATE TRIGGER reject_route BEFORE INSERT ON entries WHEN NEW.entry_type = 'step.routed' BEGIN SELECT RAISE(ABORT, 'injected routing write failure'); END;").unwrap();
        }
    }
}

#[test]
fn a_failed_routing_append_never_starts_or_dispatches_work() {
    let directory = tempdir().unwrap();
    let provider = Arc::new(FixedProvider::default());
    let observer = Arc::new(RejectRoutingWrites(
        directory.path().into(),
        Mutex::new(None),
    ));
    let engine = Engine::with_runtime(directory.path(), provider.clone(), observer.clone());
    let spec =
        RunSpec::parse(&json!({"steps":[{"id":"edit","type":"agent","instruction":"edit"}]}))
            .unwrap();
    let error = engine.start(spec, "test", None).unwrap_err();
    assert!(format!("{error:#}").contains("injected routing write failure"));
    assert!(provider.dispatched.lock().unwrap().is_empty());
    let run_id = observer.1.lock().unwrap().clone().unwrap();
    let entries = engine.journal_entries(&run_id, 0, 100).unwrap();
    assert!(entries.iter().all(|e| !matches!(
        e.entry_type,
        EntryType::StepRouted | EntryType::StepAttemptStarted
    )));
}

struct CrashAfterRoute(Mutex<Option<String>>);
impl JournalObserver for CrashAfterRoute {
    fn appended(&self, entry: &JournalEntry) {
        if entry.entry_type == EntryType::StepRouted {
            *self.0.lock().unwrap() = Some(entry.run_id.clone());
            panic!("injected crash after durable routing, before attempt start");
        }
    }
}

#[test]
fn crash_between_routing_and_start_does_not_redecide() {
    let directory = tempdir().unwrap();
    let provider = Arc::new(FixedProvider::default());
    let observer = Arc::new(CrashAfterRoute(Mutex::new(None)));
    let engine = Engine::with_runtime(directory.path(), provider.clone(), observer.clone());
    let spec =
        RunSpec::parse(&json!({"steps":[{"id":"edit","type":"agent","instruction":"edit"}]}))
            .unwrap();
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || engine.start(spec, "test", None)
        ))
        .is_err()
    );
    let run_id = observer.0.lock().unwrap().clone().unwrap();
    let engine = Engine::with_runtime(directory.path(), provider.clone(), provider.clone());
    engine.resume(&run_id, None).unwrap();
    assert_eq!(provider.decisions.load(Ordering::SeqCst), 1);
    let dispatches = provider.dispatched.lock().unwrap();
    assert_eq!(dispatches.len(), 1);
    assert_eq!(dispatches[0].routing.provider, "test-cloud-adapter");
}
