use relayflowd::{Engine, HnPoller};
use relayflowd_core::{EntryType, RunSpec};

const RECORDED_TOP_STORIES: &str = "[41380628, 41378954, 41379517]";

fn hn_monitor_spec() -> RunSpec {
    let value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../testdata/hn-monitor.spec.canonical.json"
    )))
    .unwrap();
    RunSpec::parse(&value).unwrap()
}

#[test]
fn recorded_top_stories_are_submitted_and_deduped() {
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::new(directory.path());
    let poller = HnPoller::new(hn_monitor_spec()).with_story_limit(2);
    let fetch = |url: &str| {
        assert_eq!(url, "https://hacker-news.firebaseio.com/v0/topstories.json");
        Ok(RECORDED_TOP_STORIES.to_owned())
    };

    let first = poller.poll_once_with(&engine, "hn-poller", fetch).unwrap();
    assert_eq!(first.len(), 2);
    assert!(
        first
            .iter()
            .all(|outcome| outcome.matched && !outcome.deduped)
    );

    let first_run = first[0].run.as_ref().unwrap();
    let received = engine
        .journal_entries(&first_run.run_id, 1, 100)
        .unwrap()
        .into_iter()
        .find(|entry| entry.entry_type == EntryType::EventReceived)
        .unwrap();
    assert_eq!(received.payload["event"]["type"], "hn.story_posted");
    assert_eq!(received.payload["event"]["payload"]["id"], 41380628);
    assert_eq!(received.payload["event"]["payload"]["type"], "story");

    let second = poller
        .poll_once_with(
            &engine,
            "hn-poller",
            |_| Ok(RECORDED_TOP_STORIES.to_owned()),
        )
        .unwrap();
    assert_eq!(second.len(), 2);
    assert!(
        second
            .iter()
            .all(|outcome| outcome.matched && outcome.deduped)
    );
    assert!(second.iter().all(|outcome| outcome.run.is_none()));
}
