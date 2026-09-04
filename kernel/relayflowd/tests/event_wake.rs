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

/// A claim must survive the process that made it.
///
/// The existing duplicate case submits twice through ONE `Engine`, so it proves
/// the in-process short-circuit and nothing about durability. The claim lives in
/// the registry database, and the failure this guards is a redelivery arriving
/// after a daemon restart — exactly when a webhook source retries because it
/// never saw an ack. If the claim were held in memory, that redelivery would
/// spawn a second run for one logical event.
///
/// Dropping the first `Engine` and opening a second over the same data
/// directory is the restart: same on-disk state, no shared process state.
#[test]
fn a_claim_survives_a_restart_so_redelivery_still_dedupes() {
    let directory = tempfile::tempdir().unwrap();
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

    let first_run_id = {
        let engine = Engine::new(directory.path());
        let first = engine
            .submit_event(spec.clone(), event.clone(), "test")
            .unwrap();
        assert!(first.matched && !first.deduped, "first delivery must run");
        first.run.unwrap().run_id
    };

    // The restart: previous engine dropped, new one over the same directory.
    let engine = Engine::new(directory.path());
    let redelivered = engine
        .submit_event(spec, event, "test")
        .unwrap();
    assert!(
        redelivered.matched && redelivered.deduped,
        "a redelivery after restart must be deduped, not re-run"
    );
    assert!(
        redelivered.run.is_none(),
        "a redelivery after restart must not spawn a second run"
    );

    // And the original run is still the only one: the claim did not merely
    // suppress the response, it kept the journal single.
    let entries = engine.journal_entries(&first_run_id, 1, 100).unwrap();
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.entry_type == EntryType::EventReceived)
            .count(),
        1,
        "exactly one event.received survives the restart"
    );
}
