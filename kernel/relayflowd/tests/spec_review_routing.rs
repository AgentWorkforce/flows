use relayflowd::worker::{DispatchOutcome, StepDispatch, StepDispatcher};
use relayflowd_core::{EntryType, Journal, JournalEntry, RunSpec, RunState, StepType};
use relayflowd_journal::SqliteJournal;
use serde_json::{Value, json};
use tempfile::tempdir;

fn spec() -> RunSpec {
    RunSpec::parse(&json!({"steps":[{"id":"s","type":"deterministic","command":"true"}]})).unwrap()
}
fn route() -> Value {
    json!({"profile":"batch","provider":"local","fallbacks_attempted":[]})
}
fn journal(path: &std::path::Path) -> SqliteJournal {
    let mut journal = SqliteJournal::create(path, "run", 0).unwrap();
    journal.append(&JournalEntry::new(EntryType::RunSpawned, "run", None, None, 0,
        json!({"spec":spec(),"spec_hash":"test","parent_run_id":null,"journal_version":1,"created_by":"test"}))).unwrap();
    journal
}
#[test]
fn attempt_scoped_route_is_rejected_at_append_and_replay() {
    let directory = tempdir().unwrap();
    let mut journal = journal(&directory.path().join("run.sqlite3"));
    let entry = JournalEntry::new(
        EntryType::StepRouted,
        "run",
        Some("s".into()),
        Some(1),
        1,
        route(),
    );
    let before = journal.scan_all().unwrap();
    let expected = "routing decision must not specify an attempt";
    assert!(
        journal
            .append(&entry)
            .unwrap_err()
            .to_string()
            .contains(expected)
    );
    assert_eq!(journal.scan_all().unwrap(), before);
    assert!(
        RunState::fold("run", spec(), &[entry])
            .unwrap_err()
            .to_string()
            .contains(expected)
    );
}
#[test]
fn malformed_epoch_routes_are_rejected_before_commit() {
    for routing in [
        json!({"unknown":route()}),
        json!({"s":{"profile":"","provider":"local","fallbacks_attempted":[]}}),
    ] {
        let directory = tempdir().unwrap();
        let mut journal = journal(&directory.path().join("run.sqlite3"));
        let before = journal.scan_all().unwrap();
        let entry = JournalEntry::new(
            EntryType::EpochSummary,
            "run",
            None,
            None,
            1,
            json!({"epoch":2,"prev_segment_id":1,"journal_version":1,"budget_spent":{},"routing":routing}),
        );
        assert!(
            journal.append(&entry).is_err(),
            "malformed routing summary was committed"
        );
        assert_eq!(journal.scan_all().unwrap(), before);
    }
}
#[test]
fn epoch_cannot_drop_or_replace_a_durable_route() {
    for routing in [
        json!({}),
        json!({"s":{"profile":"batch","provider":"other","fallbacks_attempted":[]}}),
    ] {
        let directory = tempdir().unwrap();
        let mut journal = journal(&directory.path().join("run.sqlite3"));
        journal
            .append(&JournalEntry::new(
                EntryType::StepRouted,
                "run",
                Some("s".into()),
                None,
                1,
                route(),
            ))
            .unwrap();
        let before = journal.scan_all().unwrap();
        let entry = JournalEntry::new(
            EntryType::EpochSummary,
            "run",
            None,
            None,
            2,
            json!({"epoch":2,"prev_segment_id":1,"journal_version":1,"budget_spent":{},"routing":routing}),
        );
        assert!(
            journal.append(&entry).is_err(),
            "epoch rewrote a durable route"
        );
        assert_eq!(journal.scan_all().unwrap(), before);
    }
}
struct LocalWorker;
impl StepDispatcher for LocalWorker {
    fn executor(&self, _: StepType) -> Option<String> {
        Some("local".into())
    }
    fn available(&self, _: StepType) -> bool {
        true
    }
    fn dispatch(&self, _: StepDispatch) -> anyhow::Result<DispatchOutcome> {
        unreachable!()
    }
}
#[test]
fn workspace_pin_peels_tags_and_refuses_non_commit_objects() {
    use std::process::Command;
    let directory = tempdir().unwrap();
    let git = |args: &[&str]| {
        let output = Command::new("git")
            .args(args)
            .current_dir(directory.path())
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    };
    git(&["init", "-q"]);
    git(&[
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-qm",
        "base",
    ]);
    let commit = git(&["rev-parse", "HEAD"]);
    git(&[
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "tag",
        "-a",
        "base",
        "-m",
        "base",
    ]);
    let tag = git(&["rev-parse", "refs/tags/base"]);
    std::fs::write(directory.path().join(".git/HEAD"), format!("{tag}\n")).unwrap();
    let surface = directory
        .path()
        .canonicalize()
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    let spec = RunSpec::parse(&json!({"steps":[{"id":"a","type":"agent","instruction":"edit","surfaces":{"workspace":[{"surface":surface}]}}]})).unwrap();
    assert_eq!(
        LocalWorker.starting_pins(&spec.steps[0]).unwrap().workspace[0].revision_id,
        commit
    );
    let tree = git(&["rev-parse", "HEAD^{tree}"]);
    std::fs::write(directory.path().join(".git/HEAD"), format!("{tree}\n")).unwrap();
    assert!(LocalWorker.starting_pins(&spec.steps[0]).is_err());
}
