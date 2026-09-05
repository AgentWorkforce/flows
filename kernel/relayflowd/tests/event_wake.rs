use relayflowd::{Engine, RunStatus};
use relayflowd_core::{EntryType, Event, RunSpec};
use serde_json::json;

#[test]
fn matching_event_wakes_once_with_fresh_context() {
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::new(directory.path());
    let value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../testdata/event-triggered-flow.spec.canonical.json"
    )))
    .unwrap();
    let spec = RunSpec::parse(&value).unwrap();
    let event = Event {
        event_type: "test.ping".into(),
        payload: json!({"message":"hello"}),
        key: None,
    };
    let first = engine
        .submit_event(spec.clone(), event.clone(), "test")
        .unwrap();
    assert!(first.matched && !first.deduped);
    assert_eq!(first.run.as_ref().unwrap().status, RunStatus::Parked);
    let entries = engine
        .journal_entries(&first.run.unwrap().run_id, 1, 100)
        .unwrap();
    assert!(
        entries
            .iter()
            .any(|entry| entry.entry_type == EntryType::EventReceived)
    );
    assert!(
        entries
            .iter()
            .any(|entry| entry.entry_type == EntryType::SubscriptionMatched)
    );
    let context = entries
        .iter()
        .find(|entry| entry.entry_type == EntryType::SubscriptionMatched)
        .unwrap();
    assert_eq!(
        context.payload["wake_context"]["triggering_event"]["payload"]["message"],
        "hello"
    );
    assert!(context.payload.get("resumed_session").is_none());
    let second = engine.submit_event(spec, event, "test").unwrap();
    assert!(second.matched && second.deduped);
    assert!(second.run.is_none());
}

/// #160. Two deliveries of ONE event, racing, must produce exactly one run.
///
/// This is the exactly-once invariant at its sharpest, and it failed before the
/// `boot_id` fix: `claim_event` repaired any claim with no matching `runs` row,
/// which is true both of a run that crashed and of a run that is mid-flight and
/// has not registered yet. The second delivery saw the first inside that window,
/// judged its claim abandoned, took it over and spawned a run of its own.
///
/// Topology matters here. An earlier version of this test used two `Engine`s
/// over one directory and failed with `database is locked` -- registry-open
/// contention, which is a different defect and would have passed the dedupe path
/// without ever exercising it. One shared `Engine` and two threads is what puts
/// two deliveries into the claim window at the same time.
#[test]
fn two_racing_deliveries_of_one_event_produce_exactly_one_run() {
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::new(directory.path());
    let value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../testdata/event-triggered-flow.spec.canonical.json"
    )))
    .unwrap();
    let spec = RunSpec::parse(&value).unwrap();
    let event = Event {
        event_type: "test.ping".into(),
        payload: json!({"message":"hello"}),
        key: None,
    };

    // Each racer builds its OWN Engine, because that is what production does:
    // the server constructs a fresh `Engine::with_runtime` inside
    // `handle_request`, so two concurrent `event.submit` calls never share one.
    // An earlier version of this test shared a single Engine and passed while
    // the fix was inert under the real topology -- the boot id was per-Engine,
    // so two production deliveries held different ids and the second treated
    // the first's live claim as wreckage. Sharing an Engine here hid exactly
    // the bug the test exists to catch.
    //
    // A barrier, not just two spawns, so both threads enter the claim window
    // together rather than whenever the scheduler reaches them.
    //
    // Be honest about what this test is worth. Against a deliberately broken
    // guard it caught the bug 3 times in 30 -- the winner usually registers
    // before any loser reads, and no amount of threads changes that because
    // SQLite serialises the writes. It exercises the real path and cannot
    // false-positive, which is why it is here, but it is NOT the gate.
    // `registry::tests` asserts the same rule deterministically.
    const RACERS: usize = 2;
    let gate = std::sync::Barrier::new(RACERS);
    let outcomes: Vec<_> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..RACERS)
            .map(|_| {
                let gate = &gate;
                let directory = directory.path();
                let spec = spec.clone();
                let event = event.clone();
                scope.spawn(move || {
                    let engine = Engine::new(directory);
                    gate.wait();
                    engine.submit_event(spec, event, "test").unwrap()
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });

    assert!(
        outcomes.iter().all(|outcome| outcome.matched),
        "both deliveries match the same trigger"
    );
    let spawned = outcomes.iter().filter(|o| !o.deduped).count();
    assert_eq!(
        spawned, 1,
        "exactly one racing delivery may start a run, got {spawned}"
    );
    assert_eq!(
        outcomes.iter().filter(|o| o.deduped).count(),
        RACERS - 1,
        "every losing delivery must be reported deduped, not dropped"
    );
    // A deduped outcome carries no run, and the winner's run must be real --
    // the pre-fix bug produced two runs, so counting outcomes alone could pass
    // while the registry held two.
    let winner = outcomes.iter().find(|o| !o.deduped).unwrap();
    let run_id = &winner.run.as_ref().unwrap().run_id;
    let received = engine
        .journal_entries(run_id, 1, 100)
        .unwrap()
        .into_iter()
        .filter(|entry| entry.entry_type == EntryType::EventReceived)
        .count();
    assert_eq!(
        received, 1,
        "the surviving run records the event exactly once"
    );
}

/// The wake context a resumed run dispatches must be the ORIGINAL one, read
/// back from the journal — not one recomputed at dispatch time.
///
/// RFC-0001 Appendix A pins an agent step's starting state. It does not name
/// the wake context explicitly, so treat this as the reading rather than a
/// settled contract: an agent that resumes should see the event that woke it,
/// as it was, rather than a value reconstructed later.
///
/// `drive.rs` gets this right today by scanning for the `SubscriptionMatched`
/// entry rather than rebuilding the value, but nothing held it there. The other
/// tests in this file cannot: they use `Engine::new` with no dispatcher, so
/// they assert journal contents and dedupe behaviour and observe NO dispatch at
/// all. A refactor that rebuilt the context at dispatch time would pass every
/// one of them.
///
/// Scope, stated so it is not mistaken for more: this pins journal-versus-
/// reconstruction across a resume. It does not exercise a spec that CHANGES
/// between the wake and the resume — the journal-stored spec is immutable here,
/// and cross-version stability would need its own test.
///
/// This is the half of gate 2's remaining wake-context gap that needs no design
/// decision: whatever the contract eventually guarantees is *present*, it must
/// be stable across a resume.
#[test]
fn a_resumed_run_dispatches_the_original_wake_context() {
    use std::sync::{Arc, Mutex};

    use relayflowd::worker::{DispatchOutcome, StepDispatch, StepDispatcher};
    use relayflowd_core::StepType;

    #[derive(Default)]
    struct CapturingDispatcher {
        contexts: Mutex<Vec<Option<serde_json::Value>>>,
    }

    impl StepDispatcher for CapturingDispatcher {
        fn executor(&self, _step_type: StepType) -> Option<String> {
            Some("wake-context-test".to_owned())
        }

        fn available(&self, _step_type: StepType) -> bool {
            true
        }

        fn dispatch(&self, dispatch: StepDispatch) -> anyhow::Result<DispatchOutcome> {
            self.contexts.lock().unwrap().push(dispatch.wake_context.clone());
            // Never complete it: the step stays open so a resume dispatches again.
            Ok(DispatchOutcome::NoWorker)
        }
    }

    struct SilentObserver;
    impl relayflowd::worker::JournalObserver for SilentObserver {
        fn appended(&self, _entry: &relayflowd_core::JournalEntry) {}
    }

    let directory = tempfile::tempdir().unwrap();
    let dispatcher = Arc::new(CapturingDispatcher::default());
    let value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../testdata/event-triggered-flow.spec.canonical.json"
    )))
    .unwrap();
    let spec = RunSpec::parse(&value).unwrap();
    let event = Event {
        event_type: "test.ping".into(),
        payload: json!({"message": "hello"}),
        key: None,
    };

    let run_id = {
        let engine = Engine::with_runtime(
            directory.path(),
            dispatcher.clone(),
            Arc::new(SilentObserver),
        );
        let first = engine.submit_event(spec, event, "test").unwrap();
        assert!(first.matched && !first.deduped);
        first.run.unwrap().run_id
    };

    // A fresh Engine over the same directory: the resume has no in-memory
    // knowledge of the event, so anything it dispatches came off disk.
    let engine = Engine::with_runtime(
        directory.path(),
        dispatcher.clone(),
        Arc::new(SilentObserver),
    );
    engine.resume(&run_id, None).unwrap();

    let contexts = dispatcher.contexts.lock().unwrap().clone();
    assert!(
        contexts.len() >= 2,
        "expected a dispatch on submit and again on resume, got {}",
        contexts.len()
    );
    let first = contexts.first().unwrap();
    assert!(first.is_some(), "the first dispatch must carry a wake context");
    assert_eq!(
        contexts.last().unwrap(),
        first,
        "a resumed run must dispatch the ORIGINAL wake context, not a recomputed one"
    );
    assert_eq!(
        first.as_ref().unwrap()["triggering_event"]["payload"]["message"],
        "hello",
        "and it must still describe the event that actually woke the run"
    );
}
