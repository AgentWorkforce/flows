use relayflowd::{DriveOptions, Engine};
use relayflowd_core::{EntryType, RunSpec};
use relayflowd_journal::SqliteJournal;
use serde_json::json;

fn spec() -> RunSpec {
    RunSpec::parse(&json!({"name":"memo","steps":[
        {"id":"source","type":"deterministic","command":"printf old","verification":{"json_schema":{"type":"object","properties":{"stdout_tail":{"type":"string"}}}}},
        {"id":"sink","type":"deterministic","command":"printf '%s' \"$FLOWS_INPUT\"","depends_on":["source"],"input":{"message":{"step":"source","path":["stdout_tail"]}}}
    ]})).unwrap()
}
fn entries(root: &std::path::Path, run: &str) -> Vec<relayflowd_core::JournalEntry> {
    SqliteJournal::open_read_only(root.join("runs").join(format!("{run}.sqlite3")))
        .unwrap()
        .scan_all()
        .unwrap()
}
#[test]
fn reused_prefix_survives_restart_without_source_and_never_mutates_prior() {
    let root = tempfile::tempdir().unwrap();
    let engine = Engine::new(root.path());
    let prior = engine.start(spec(), "test", None).unwrap();
    let before = entries(root.path(), &prior.run_id);
    let second = engine
        .start_with_reuse(
            spec(),
            "test",
            DriveOptions {
                stop_after: Some(1),
                ..Default::default()
            },
            Some(&prior.run_id),
        )
        .unwrap();
    assert_eq!(entries(root.path(), &prior.run_id), before);
    std::fs::remove_file(
        root.path()
            .join("runs")
            .join(format!("{}.sqlite3", prior.run_id)),
    )
    .unwrap();
    let completed = Engine::new(root.path())
        .resume(&second.run_id, None)
        .unwrap();
    assert_eq!(completed.completed_steps, 2);
    let journal = entries(root.path(), &second.run_id);
    assert_eq!(
        journal
            .iter()
            .filter(|e| e.payload.get("reused_from").is_some())
            .count(),
        2
    );
    assert!(
        !journal
            .iter()
            .any(|e| e.entry_type == EntryType::StepAttemptStarted)
    );
}
#[test]
fn actual_changed_input_invalidates_consumer_even_with_identical_consumer_spec() {
    let root = tempfile::tempdir().unwrap();
    let engine = Engine::new(root.path());
    let prior = engine.start(spec(), "test", None).unwrap();
    let mut changed = serde_json::to_value(spec()).unwrap();
    changed["steps"][0]["command"] = json!("printf new");
    let run = engine
        .start_with_reuse(
            RunSpec::parse(&changed).unwrap(),
            "test",
            Default::default(),
            Some(&prior.run_id),
        )
        .unwrap();
    let completed = entries(root.path(), &run.run_id)
        .into_iter()
        .filter(|e| e.entry_type == EntryType::StepCompleted)
        .collect::<Vec<_>>();
    assert_eq!(completed.len(), 2);
    assert!(
        completed
            .iter()
            .all(|e| e.payload.get("reused_from").is_none())
    );
    assert_eq!(
        completed[1].payload["output"]["stdout_tail"],
        "{\"message\":\"new\"}"
    );
}
#[test]
fn refuses_missing_wrong_flow_and_unreadable_journal_before_creating_run() {
    let root = tempfile::tempdir().unwrap();
    let engine = Engine::new(root.path());
    let prior = engine.start(spec(), "test", None).unwrap();
    for (id, name, code) in [
        ("missing", "memo", "reuse_run_not_found"),
        ("../escape", "memo", "reuse_run_not_found"),
        (&prior.run_id, "other", "reuse_spec_mismatch"),
    ] {
        let mut requested = spec();
        requested.name = Some(name.into());
        let error = engine
            .start_with_reuse(requested, "test", Default::default(), Some(id))
            .unwrap_err();
        assert_eq!(
            error
                .downcast_ref::<relayflowd::engine::ReuseError>()
                .unwrap()
                .code,
            code
        );
    }
    std::fs::write(root.path().join("runs/broken.sqlite3"), "corrupt").unwrap();
    let error = engine
        .start_with_reuse(spec(), "test", Default::default(), Some("broken"))
        .unwrap_err();
    assert_eq!(
        error
            .downcast_ref::<relayflowd::engine::ReuseError>()
            .unwrap()
            .code,
        "reuse_journal_read_failed"
    );
    assert_eq!(
        std::fs::read_dir(root.path().join("runs"))
            .unwrap()
            .filter(|e| e
                .as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|s| s == "sqlite3"))
            .count(),
        2
    );
}
