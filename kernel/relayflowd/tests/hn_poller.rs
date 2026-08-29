use relayflowd::{Engine, HnPoller};
use relayflowd_core::{EntryType, RunSpec};

fn hn_monitor_spec() -> RunSpec {
    let value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../testdata/hn-monitor.spec.canonical.json"
    )))
    .unwrap();
    RunSpec::parse(&value).unwrap()
}

#[test]
fn recorded_top_stories_are_submitted_with_limit_and_deduped() {
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::new(directory.path());
    let poller = HnPoller::new(2);
    let payload = "[41380628, 41378954, 41370000]";

    let first = poller
        .poll_payload(&engine, hn_monitor_spec(), "hn-poller", payload)
        .unwrap();
    assert_eq!(first.len(), 2);
    assert!(first
        .iter()
        .all(|outcome| outcome.matched && !outcome.deduped));

    let entries = engine
        .journal_entries(&first[0].run.as_ref().unwrap().run_id, 1, 100)
        .unwrap();
    let received = entries
        .iter()
        .find(|entry| entry.entry_type == EntryType::EventReceived)
        .unwrap();
    assert_eq!(received.payload["event"]["type"], "hn.story_posted");
    assert_eq!(received.payload["event"]["payload"]["id"], 41380628);
    assert_eq!(received.payload["event"]["payload"]["type"], "story");

    let second = poller
        .poll_payload(&engine, hn_monitor_spec(), "hn-poller", payload)
        .unwrap();
    assert_eq!(second.len(), 2);
    assert!(second
        .iter()
        .all(|outcome| outcome.matched && outcome.deduped));
    assert!(second.iter().all(|outcome| outcome.run.is_none()));
}

#[test]
fn malformed_top_stories_payload_fails_closed() {
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::new(directory.path());

    let error = HnPoller::default()
        .poll_payload(&engine, hn_monitor_spec(), "hn-poller", "not JSON")
        .unwrap_err();

    assert!(error.to_string().contains("parse HN top stories response"));
}
