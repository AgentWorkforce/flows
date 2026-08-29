use relayflowd::{Engine, RunStatus};
use relayflowd_core::{EntryType, Event, RunSpec};
use serde_json::json;

#[test]
fn hn_story_event_wakes_monitor_once_with_story_context() {
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::new(directory.path());
    let value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../testdata/hn-monitor.spec.canonical.json"
    )))
    .unwrap();
    let spec = RunSpec::parse(&value).unwrap();
    let event = Event {
        event_type: "hn.story_posted".into(),
        payload: json!({
            "id": 41380628,
            "type": "story",
            "by": "pg",
            "time": 1724932800,
            "title": "Agents that automate software maintenance",
            "url": "https://example.com/agent-automation",
            "score": 187,
            "descendants": 64
        }),
        key: None,
    };

    let first = engine
        .submit_event(spec.clone(), event.clone(), "hn-webhook")
        .unwrap();
    assert!(first.matched && !first.deduped);
    assert_eq!(first.subscription_id.as_deref(), Some("hn-story-posted"));
    let run = first.run.unwrap();
    assert_eq!(run.status, RunStatus::Parked);

    let entries = engine.journal_entries(&run.run_id, 1, 100).unwrap();
    assert!(entries.iter().any(|entry| entry.entry_type == EntryType::EventReceived));
    let matched = entries
        .iter()
        .find(|entry| entry.entry_type == EntryType::SubscriptionMatched)
        .unwrap();
    assert_eq!(matched.payload["subscription_id"], "hn-story-posted");
    assert_eq!(
        matched.payload["wake_context"]["triggering_event"]["payload"]["title"],
        "Agents that automate software maintenance"
    );
    assert_eq!(
        matched.payload["wake_context"]["triggering_event"]["payload"]["score"],
        187
    );

    let duplicate = engine.submit_event(spec, event, "hn-webhook").unwrap();
    assert!(duplicate.matched && duplicate.deduped);
    assert!(duplicate.run.is_none());
}
