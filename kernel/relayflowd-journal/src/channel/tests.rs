use std::sync::{Arc, Barrier};

use super::*;
use relayflowd_core::{
    Budget, EpochSummaryPayload, JOURNAL_VERSION, Journal, RunCompletedPayload,
    RunCompletionReason, channel::ChannelError,
};
use serde_json::json;
use tempfile::tempdir;

fn actor() -> ChannelActor {
    ChannelActor {
        run_id: "run".into(),
        step_id: "agent".into(),
        attempt: 1,
        idempotency_key: "stable".into(),
    }
}

fn seed(path: &std::path::Path) -> SqliteJournal {
    let mut journal = SqliteJournal::create(path, "run", 0).unwrap();
    journal.append(&JournalEntry::new(EntryType::RunSpawned, "run", None, None, 0, RunSpawnedPayload {
        spec: json!({"name":"channels", "steps":[{"id":"agent", "type":"agent", "instruction":"coordinate", "surfaces":{"workspace":[{"surface":"repo"}],"streams":[{"stream":"chat"}]}}]}),
        spec_hash: "fixture".into(), parent_run_id: None, journal_version: JOURNAL_VERSION, created_by: "test".into()
    })).unwrap();
    journal.append(&JournalEntry::new(EntryType::StepAttemptStarted, "run", Some("agent".into()), Some(1), 0, json!({
        "step_type":"agent", "idempotency_key":"stable", "lease_id":"lease", "lease_deadline_ms":100000,
        "executor":"worker", "recovery_mode":"reset", "pins":{"workspace":[{"surface":"repo", "revision_id":"clean"}],"streams":[{"stream":"chat","read_offset":0}]}, "max_iterations":2
    }))).unwrap();
    journal
}

fn send(id: &str) -> ChannelCommand {
    ChannelCommand::Append {
        message_id: id.into(),
        message: json!({"id":id}),
    }
}

fn perform(journal: &mut SqliteJournal, command: ChannelCommand) -> Option<JournalEntry> {
    journal
        .channel_command(&actor(), "chat", command, 42)
        .unwrap()
        .0
}

#[test]
fn failed_channel_writes_never_expose_delivery_or_advance_acknowledged_offset() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("run.sqlite3");
    let mut journal = seed(&path);
    for kind in [
        "channel.appended",
        "channel.delivered",
        "channel.acknowledged",
    ] {
        let command = match kind {
            "channel.appended" => send("one"),
            "channel.delivered" => ChannelCommand::Receive,
            _ => {
                let delivered = perform(&mut journal, ChannelCommand::Receive).unwrap();
                ChannelCommand::Acknowledge {
                    delivery_seq: delivered.seq,
                }
            }
        };
        let before = journal.scan_all().unwrap();
        journal.connection.execute_batch(&format!("CREATE TRIGGER fail_channel BEFORE INSERT ON entries WHEN NEW.entry_type = '{kind}' BEGIN SELECT RAISE(ABORT, 'injected channel write failure'); END;")).unwrap();
        let error = journal
            .channel_command(&actor(), "chat", command.clone(), 42)
            .unwrap_err();
        assert!(
            error.to_string().contains("injected channel write failure"),
            "{error}"
        );
        drop(journal);
        journal = SqliteJournal::open(&path).unwrap();
        assert_eq!(journal.scan_all().unwrap(), before);
        assert_eq!(
            ChannelState::fold(&before).unwrap().offset("chat", "agent"),
            0
        );
        journal
            .connection
            .execute_batch("DROP TRIGGER fail_channel")
            .unwrap();
        perform(&mut journal, command).unwrap();
    }
    drop(journal);
    let mut journal = SqliteJournal::open(&path).unwrap();
    assert_eq!(
        ChannelState::fold(&journal.scan_all().unwrap())
            .unwrap()
            .offset("chat", "agent"),
        1
    );
    assert!(perform(&mut journal, ChannelCommand::Receive).is_none());
}

#[test]
fn independent_connections_serialize_send_receive_and_acknowledgement() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("run.sqlite3");
    let mut journal = seed(&path);
    let race = |command: ChannelCommand| {
        let barrier = Arc::new(Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let path = path.clone();
                let barrier = barrier.clone();
                let command = command.clone();
                std::thread::spawn(move || {
                    let mut journal = SqliteJournal::open(path).unwrap();
                    barrier.wait();
                    perform(&mut journal, command).unwrap()
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect::<Vec<_>>()
    };
    let sends = race(send("same"));
    assert!(sends.iter().all(|entry| entry == &sends[0]));
    let deliveries = race(ChannelCommand::Receive);
    assert!(deliveries.iter().all(|entry| entry.payload["offset"] == 1));
    assert_eq!(
        deliveries
            .iter()
            .map(|e| e.seq)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        8
    );
    let acks = race(ChannelCommand::Acknowledge {
        delivery_seq: deliveries[0].seq,
    });
    assert!(acks.iter().all(|entry| entry == &acks[0]));
    assert!(perform(&mut journal, ChannelCommand::Receive).is_none());
    assert_eq!(
        journal
            .scan_all()
            .unwrap()
            .iter()
            .filter(|e| e.entry_type == EntryType::ChannelAcknowledged)
            .count(),
        1
    );
}

#[test]
fn channels_cross_segment_boundaries_and_terminal_runs_reject_mutations() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("run.sqlite3");
    let mut journal = seed(&path);
    let appended = perform(&mut journal, send("one")).unwrap();
    let delivered = perform(&mut journal, ChannelCommand::Receive).unwrap();
    let summary: EpochSummaryPayload = serde_json::from_value(
        json!({"epoch":0,"prev_segment_id":0,"journal_version":JOURNAL_VERSION, "steps_open":{"agent":{"attempt":1,"state":"running","idempotency_key":"stable","lease_deadline_ms":100000}}}),
    )
    .unwrap();
    journal.rollover(summary, 43).unwrap();
    drop(journal);
    let mut journal = SqliteJournal::open(&path).unwrap();
    assert_eq!(perform(&mut journal, send("one")), Some(appended));
    let repeated = perform(&mut journal, ChannelCommand::Receive).unwrap();
    assert_eq!(repeated.payload, delivered.payload);
    assert_eq!(repeated.segment_id, 2);
    perform(
        &mut journal,
        ChannelCommand::Acknowledge {
            delivery_seq: delivered.seq,
        },
    );
    assert!(perform(&mut journal, ChannelCommand::Receive).is_none());
    let entries = journal.scan_all().unwrap();
    let replay = ChannelState::fold(&entries).unwrap();
    assert_eq!(replay.offset("chat", "agent"), 1);
    assert_eq!(
        replay.deliveries().cloned().collect::<Vec<_>>(),
        [delivered, repeated]
    );
    journal
        .append(&JournalEntry::new(
            EntryType::RunCompleted,
            "run",
            None,
            None,
            44,
            RunCompletedPayload {
                completion_reason: RunCompletionReason::Success,
                failed_step_id: None,
                budget_total: Budget::default(),
            },
        ))
        .unwrap();
    for command in [
        send("one"),
        ChannelCommand::Receive,
        ChannelCommand::Acknowledge { delivery_seq: 4 },
    ] {
        assert!(matches!(
            journal.channel_command(&actor(), "chat", command, 45),
            Err(JournalStoreError::RunTerminal(_))
        ));
    }
}

#[test]
fn stale_attempts_and_raw_forged_acknowledgements_cannot_change_offsets() {
    let dir = tempdir().unwrap();
    let mut journal = seed(&dir.path().join("run.sqlite3"));
    perform(&mut journal, send("one"));
    let delivery = perform(&mut journal, ChannelCommand::Receive).unwrap();
    let before = journal.scan_all().unwrap();
    for field in ["attempt", "idempotency_key", "step_id", "run_id"] {
        let mut invalid = serde_json::to_value(actor()).unwrap();
        invalid[field] = if field == "attempt" {
            json!(2)
        } else {
            json!("other")
        };
        let invalid: ChannelActor = serde_json::from_value(invalid).unwrap();
        assert!(matches!(
            journal.channel_command(&invalid, "chat", ChannelCommand::Receive, 42),
            Err(JournalStoreError::Channel(ChannelError::Invalid(_)))
        ));
    }
    let forged = JournalEntry::new(
        EntryType::ChannelAcknowledged,
        "run",
        Some("agent".into()),
        Some(1),
        42,
        json!({"channel":"chat", "consumer":"agent", "offset":2, "delivery_seq":delivery.seq}),
    );
    assert!(journal.append(&forged).is_err());
    assert_eq!(journal.scan_all().unwrap(), before);
    assert_eq!(
        ChannelState::fold(&before).unwrap().offset("chat", "agent"),
        0
    );
}
