use relayflowd::Engine;
use relayflowd_core::{
    EntryType, Journal, JournalEntry, RunSpec, SimClock, WaitCompletedPayload, WaitCompletionReason,
};
use relayflowd_journal::SqliteJournal;
use serde_json::{Value, json};

fn fixture() -> (tempfile::TempDir, Engine<SimClock>, String) {
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::with_clock(directory.path(), SimClock::new(0));
    let spec =
        RunSpec::parse(&json!({"steps":[{"id":"body","type":"llm","prompt":"body"}]})).unwrap();
    let id = engine.start(spec, "test", None).unwrap().run_id;
    engine
        .open_subscription(
            &id,
            "events",
            vec!["test".into()],
            None,
            0,
            60_000,
            3_600_000,
            false,
        )
        .unwrap();
    engine
        .activate_subscription(&id, "events", 0, json!({"generation":1}))
        .unwrap();
    engine
        .next_subscription_outcome(&id, "events", None)
        .unwrap();
    (directory, engine, id)
}

fn completion(directory: &std::path::Path, id: &str, result: Value) {
    let mut journal =
        SqliteJournal::open(directory.join("runs").join(format!("{id}.sqlite3"))).unwrap();
    journal
        .append(&JournalEntry::new(
            EntryType::WaitCompleted,
            id,
            None,
            None,
            0,
            WaitCompletedPayload {
                wait_id: "events/next/0".into(),
                completion_reason: WaitCompletionReason::Timeout,
                result,
            },
        ))
        .unwrap();
}

#[test]
fn malformed_deadline_range_is_an_error_while_null_is_an_empty_range() {
    for pending in [json!("corrupt"), Value::Null] {
        let (directory, engine, id) = fixture();
        completion(
            directory.path(),
            &id,
            json!({"timeout":"deadline","pending":pending}),
        );
        let replay = engine.replay_subscription_wake(&id, "events", 0);
        if pending.is_null() {
            assert!(replay.is_ok());
        } else {
            assert!(replay.unwrap_err().to_string().contains("pending range"));
        }
    }
}

#[test]
fn a_completed_event_range_cannot_replay_with_missing_frames() {
    let (directory, engine, id) = fixture();
    completion(
        directory.path(),
        &id,
        json!({"from_offset":0,"next_offset":1}),
    );
    assert!(
        engine
            .replay_subscription_wake(&id, "events", 0)
            .unwrap_err()
            .to_string()
            .contains("missing journaled frames")
    );
}

#[test]
fn malformed_stream_frames_fail_replay_and_future_append() {
    let (directory, engine, id) = fixture();
    engine
        .append_subscription_frame(&id, "events", "first", json!({"payload":1}))
        .unwrap();
    completion(
        directory.path(),
        &id,
        json!({"from_offset":0,"next_offset":1}),
    );
    // The writer refuses malformed frames. Simulate damaged stored bytes to
    // prove readers fail closed too, instead of silently skipping that row.
    let connection =
        rusqlite::Connection::open(directory.path().join("runs").join(format!("{id}.sqlite3")))
            .unwrap();
    connection
        .execute(
            "UPDATE entries SET payload = ?1 WHERE entry_type = 'stream.appended'",
            [json!({"stream":"subscription/events","offset":"corrupt"}).to_string()],
        )
        .unwrap();
    drop(connection);
    assert!(
        engine
            .replay_subscription_wake(&id, "events", 0)
            .unwrap_err()
            .to_string()
            .contains("decode stream.appended")
    );
    assert!(
        engine
            .append_subscription_frame(&id, "events", "next", json!({"payload":1}))
            .is_err()
    );
}
