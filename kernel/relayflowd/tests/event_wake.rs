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
