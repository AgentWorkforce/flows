use super::*;
use crate::{Clock, Journal, MemoryJournal, SimClock};

fn actor(step: &str) -> ChannelActor {
    ChannelActor {
        run_id: "run".into(),
        step_id: step.into(),
        attempt: 1,
        idempotency_key: step.into(),
    }
}

fn perform(
    state: &mut ChannelState,
    journal: &mut MemoryJournal,
    actor: &ChannelActor,
    command: ChannelCommand,
) -> Option<JournalEntry> {
    let clock = SimClock::new(42);
    let entry = state
        .decide(actor, "chat", command, clock.now_ms())
        .unwrap()?;
    if entry.seq != 0 {
        return Some(entry);
    }
    let entry = journal.append(&entry).unwrap();
    state.apply(&entry).unwrap();
    Some(entry)
}

#[test]
fn delivery_replay_and_independent_acknowledged_offsets() {
    let mut state = ChannelState::default();
    let mut journal = MemoryJournal::new("run");
    for id in ["one", "two"] {
        perform(
            &mut state,
            &mut journal,
            &actor("producer"),
            ChannelCommand::Append {
                message_id: id.into(),
                message: Value::String(id.into()),
            },
        );
    }
    let first = perform(
        &mut state,
        &mut journal,
        &actor("alice"),
        ChannelCommand::Receive,
    )
    .unwrap();
    let repeated = perform(
        &mut state,
        &mut journal,
        &actor("alice"),
        ChannelCommand::Receive,
    )
    .unwrap();
    assert_ne!(first.seq, repeated.seq);
    assert_eq!(first.payload, repeated.payload);
    assert_eq!(state.offset("chat", "alice"), 0);
    assert!(
        state
            .decide(
                &actor("bob"),
                "chat",
                ChannelCommand::Acknowledge {
                    delivery_seq: first.seq
                },
                42
            )
            .is_err()
    );
    perform(
        &mut state,
        &mut journal,
        &actor("alice"),
        ChannelCommand::Acknowledge {
            delivery_seq: repeated.seq,
        },
    );
    assert_eq!(state.offset("chat", "alice"), 1);
    let second = perform(
        &mut state,
        &mut journal,
        &actor("alice"),
        ChannelCommand::Receive,
    )
    .unwrap();
    assert_eq!(second.payload["message"], "two");
    let bob = perform(
        &mut state,
        &mut journal,
        &actor("bob"),
        ChannelCommand::Receive,
    )
    .unwrap();
    assert_eq!(bob.payload["message"], "one");
    assert_eq!(state.offset("chat", "bob"), 0);
    let replay = ChannelState::fold(&journal.scan_segment(1).unwrap()).unwrap();
    assert_eq!(state, replay);
    assert_eq!(
        replay.deliveries().map(|e| e.seq).collect::<Vec<_>>(),
        [first.seq, repeated.seq, second.seq, bob.seq]
    );
}

#[test]
fn send_retry_is_stable_and_conflicting_content_is_rejected() {
    let mut state = ChannelState::default();
    let mut journal = MemoryJournal::new("run");
    let send = || ChannelCommand::Append {
        message_id: "id".into(),
        message: Value::Null,
    };
    let first = perform(&mut state, &mut journal, &actor("alice"), send()).unwrap();
    let mut retry = actor("alice");
    retry.attempt = 2;
    assert_eq!(
        perform(&mut state, &mut journal, &retry, send()),
        Some(first)
    );
    assert!(
        state
            .decide(
                &retry,
                "chat",
                ChannelCommand::Append {
                    message_id: "id".into(),
                    message: Value::Bool(true)
                },
                42
            )
            .is_err()
    );
    // Message ids belong to a producer within one channel, not globally.
    let other = perform(&mut state, &mut journal, &actor("bob"), send()).unwrap();
    assert_eq!(other.payload["offset"], 2);
    assert_eq!(journal.scan_segment(1).unwrap().len(), 2);
}

#[test]
fn forged_deliveries_and_acknowledgements_fail_closed() {
    let mut state = ChannelState::default();
    let mut journal = MemoryJournal::new("run");
    assert!(
        perform(
            &mut state,
            &mut journal,
            &actor("alice"),
            ChannelCommand::Receive
        )
        .is_none()
    );
    perform(
        &mut state,
        &mut journal,
        &actor("alice"),
        ChannelCommand::Append {
            message_id: "id".into(),
            message: Value::Null,
        },
    );
    let delivery = perform(
        &mut state,
        &mut journal,
        &actor("alice"),
        ChannelCommand::Receive,
    )
    .unwrap();
    let snapshot = state.clone();
    let mut forged = delivery.clone();
    forged.seq += 1;
    for payload in [
        serde_json::json!({"channel":"chat", "consumer":"alice", "offset": 2, "message":null}),
        serde_json::json!({"channel":"chat", "consumer":"alice", "offset": 1, "message":"forged"}),
        serde_json::json!({"channel":"chat", "consumer":"bob", "offset": 1, "message":null}),
    ] {
        forged.payload = payload;
        assert!(state.apply(&forged).is_err());
        assert_eq!(state, snapshot);
    }
    for (channel, seq) in [("other", delivery.seq), ("chat", 999)] {
        assert!(
            state
                .decide(
                    &actor("alice"),
                    channel,
                    ChannelCommand::Acknowledge { delivery_seq: seq },
                    42
                )
                .is_err()
        );
        assert_eq!(state.offset("chat", "alice"), 0);
    }
    let acknowledgement = perform(
        &mut state,
        &mut journal,
        &actor("alice"),
        ChannelCommand::Acknowledge {
            delivery_seq: delivery.seq,
        },
    )
    .unwrap();
    assert_eq!(
        perform(
            &mut state,
            &mut journal,
            &actor("alice"),
            ChannelCommand::Acknowledge {
                delivery_seq: delivery.seq
            }
        ),
        Some(acknowledgement)
    );
    assert!(
        perform(
            &mut state,
            &mut journal,
            &actor("alice"),
            ChannelCommand::Receive
        )
        .is_none()
    );
}
