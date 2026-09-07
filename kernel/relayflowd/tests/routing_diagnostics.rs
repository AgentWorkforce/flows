use relayflowd_core::{EntryType, Journal, JournalEntry, RunSpec, RunState};
use relayflowd_journal::SqliteJournal;
use serde_json::{Value, json};
use tempfile::tempdir;

fn spec() -> RunSpec {
    RunSpec::parse(&json!({"steps":[{"id":"s","type":"deterministic","command":"true"}]})).unwrap()
}

fn route() -> Value {
    json!({"profile":"batch","provider":"local","workspace":"/repo","fallbacks_attempted":["pool-a"]})
}

fn routed(payload: Value) -> JournalEntry {
    JournalEntry::new(
        EntryType::StepRouted,
        "run",
        Some("s".into()),
        None,
        1,
        payload,
    )
}

fn journal(path: &std::path::Path) -> SqliteJournal {
    let mut journal = SqliteJournal::create(path, "run", 0).unwrap();
    journal.append(&JournalEntry::new(EntryType::RunSpawned, "run", None, None, 0,
        json!({"spec":spec(),"spec_hash":"test","parent_run_id":null,"journal_version":1,"created_by":"test"}))).unwrap();
    journal
}

#[test]
fn malformed_routes_name_the_same_field_at_append_replay_and_epoch_replay() {
    for (field, value, detail) in [
        ("profile", json!("  "), "profile must not be blank"),
        ("provider", json!("\t"), "provider must not be blank"),
        ("workspace", json!(""), "workspace must not be blank"),
        (
            "fallbacks_attempted",
            json!(["pool-a", " "]),
            "fallbacks_attempted[1] must not be blank",
        ),
    ] {
        let directory = tempdir().unwrap();
        let mut journal = journal(&directory.path().join("run.sqlite3"));
        let mut payload = route();
        payload[field] = value;
        let entry = routed(payload.clone());
        let expected = format!("invalid routing decision for step s: {detail}");
        let before = journal.scan_all().unwrap();
        assert!(
            journal
                .append(&entry)
                .unwrap_err()
                .to_string()
                .contains(&expected)
        );
        assert_eq!(
            journal.scan_all().unwrap(),
            before,
            "invalid append must roll back"
        );
        assert_eq!(
            RunState::fold("run", spec(), &[entry])
                .unwrap_err()
                .to_string(),
            expected
        );
        let epoch = JournalEntry::new(
            EntryType::EpochSummary,
            "run",
            None,
            None,
            2,
            json!({"epoch":2,"prev_segment_id":1,"journal_version":1,"budget_spent":{},"routing":{"s":payload}}),
        );
        assert_eq!(
            RunState::fold("run", spec(), &[epoch])
                .unwrap_err()
                .to_string(),
            expected
        );
    }
}

#[test]
fn duplicate_routes_have_a_distinct_diagnostic_and_leave_the_original_fact_intact() {
    let directory = tempdir().unwrap();
    let mut journal = journal(&directory.path().join("run.sqlite3"));
    let entry = routed(route());
    journal.append(&entry).unwrap();
    let before = journal.scan_all().unwrap();
    let expected = "invalid routing decision for step s: routing decision already recorded";
    assert!(
        journal
            .append(&entry)
            .unwrap_err()
            .to_string()
            .contains(expected)
    );
    assert_eq!(journal.scan_all().unwrap(), before);
    assert_eq!(
        RunState::fold("run", spec(), &[entry.clone(), entry])
            .unwrap_err()
            .to_string(),
        expected
    );
    assert_eq!(
        RunState::fold("run", spec(), &before).unwrap().routing["s"].provider,
        "local"
    );
}
