use relayflowd::{Engine, trigger_watcher::poll_once};
use relayflowd_journal::SqliteJournal;
use serde_json::{Value, json};
use std::fs;

fn provision(path: &std::path::Path) {
    fs::create_dir_all(path.join("triggers")).unwrap();
    fs::create_dir_all(path.join("inbox/release")).unwrap();
    fs::write(
        path.join("triggers/release.json"),
        json!({
            "version": "0.1.0", "name": "release",
            "triggers": [{"id":"release", "executor":"release", "event_type":"release",
                "pattern":{"action":"released"}, "dedupe_key_template":"{{event.type}}"}],
            "steps": [{"id":"log", "type":"deterministic", "command":"printf accepted"}]
        })
        .to_string(),
    )
    .unwrap();
}

#[test]
fn journals_payload_and_filename_key_then_archives_and_dedupes_replay() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    provision(root);
    let payload = json!({"action":"released", "nested":{"ok":true}});
    let file = root.join("inbox/release/event-1.json");
    fs::write(&file, payload.to_string()).unwrap();
    let engine = Engine::new(root);
    let mut ids = Vec::new();
    let mut submit = |spec, event| {
        let receipt = engine.submit_webhook_event(spec, event, &|id| engine.resume(id, None))?;
        ids.push(receipt.run.as_ref().unwrap().run_id.clone());
        Ok(receipt)
    };
    assert!(poll_once(root, &mut submit).unwrap().is_empty());
    assert!(!file.exists());
    fs::rename(root.join("inbox-processed/release/event-1.json"), &file).unwrap();
    assert!(poll_once(root, &mut submit).unwrap().is_empty());
    assert_eq!(ids.len(), 2);
    assert_eq!(ids[0], ids[1]);
    let entries = SqliteJournal::open(root.join(format!("runs/{}.sqlite3", ids[0])))
        .unwrap()
        .scan_all()
        .unwrap();
    assert_eq!(
        entries
            .iter()
            .filter(|e| e.entry_type.as_str() == "run.spawned")
            .count(),
        1
    );
    assert_eq!(entries[0].payload["event"], payload);
    let received = entries
        .iter()
        .find(|e| e.entry_type.as_str() == "event.received")
        .unwrap();
    assert_eq!(received.payload["event_key"], "event-1.json");
}

#[test]
fn retains_bad_and_unregistered_events_while_consuming_filter_nonmatches() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    provision(root);
    fs::write(root.join("inbox/release/bad.json"), "{").unwrap();
    fs::write(
        root.join("inbox/release/ignored.json"),
        "{\"action\":\"ignored\"}",
    )
    .unwrap();
    fs::write(root.join("inbox/release/.pending.tmp"), "{").unwrap();
    fs::create_dir_all(root.join("inbox/unregistered")).unwrap();
    fs::write(root.join("inbox/unregistered/event.json"), "{}").unwrap();
    let engine = Engine::new(root);
    let errors = poll_once(root, &mut |spec, event| {
        engine.submit_webhook_event(spec, event, &|id| engine.resume(id, None))
    })
    .unwrap();
    assert_eq!(errors.len(), 2);
    assert!(root.join("inbox/release/bad.json").exists());
    assert!(root.join("inbox/release/.pending.tmp").exists());
    assert!(root.join("inbox/unregistered/event.json").exists());
    assert!(root.join("inbox-processed/release/ignored.json").exists());
    assert!(!root.join("runs").exists());
}

#[test]
fn failed_archive_retries_the_same_durable_run() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    provision(root);
    fs::write(
        root.join("inbox/release/event.json"),
        "{\"action\":\"released\"}",
    )
    .unwrap();
    // Force a failure after spawn, precisely at the acknowledgement boundary.
    fs::write(root.join("inbox-processed"), "blocked").unwrap();
    let engine = Engine::new(root);
    let mut receipts = Vec::<Value>::new();
    let mut submit = |spec, event| {
        let result = engine.submit_webhook_event(spec, event, &|id| engine.resume(id, None))?;
        receipts.push(serde_json::to_value(&result)?);
        Ok(result)
    };
    assert_eq!(poll_once(root, &mut submit).unwrap().len(), 1);
    fs::remove_file(root.join("inbox-processed")).unwrap();
    assert!(poll_once(root, &mut submit).unwrap().is_empty());
    assert_eq!(receipts[0]["run"]["run_id"], receipts[1]["run"]["run_id"]);
    assert_eq!(receipts[1]["deduped"], true);
}
