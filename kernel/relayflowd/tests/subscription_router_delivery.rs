use relayflowd::Engine;
use relayflowd_core::{EntryType, RunSpec, SimClock, SubscriptionCompletionReason};
use serde_json::json;

#[test]
fn targeted_ingress_is_fenced_deduplicated_and_isolated_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::with_clock(dir.path(), SimClock::new(100));
    let spec =
        RunSpec::parse(&json!({"steps":[{"id":"body","type":"llm","prompt":"body"}]})).unwrap();
    let id = engine.start(spec, "router-test", Some(0)).unwrap().run_id;
    let receipt = json!({"binding_id":"one","generation":7});
    let frame = json!({"type":"github","payload":{"action":"opened"}});
    for subscription in ["one", "two"] {
        engine
            .open_subscription(
                &id,
                subscription,
                vec!["github".into()],
                None,
                0,
                100,
                1000,
                false,
            )
            .unwrap();
    }
    assert!(
        engine
            .deliver_subscription_frame(&id, "one", &receipt, "event-1", frame.clone())
            .is_err()
    );
    engine
        .activate_subscription(&id, "one", 42, receipt.clone())
        .unwrap();
    engine
        .activate_subscription(&id, "two", 42, json!({"binding_id":"two","generation":7}))
        .unwrap();
    let before = engine.journal_entries(&id, 1, 500).unwrap().len();
    assert!(
        engine
            .activate_subscription(&id, "one", 42, json!({"binding_id":"one","generation":8}))
            .is_err()
    );
    assert!(
        engine
            .activate_subscription(&id, "one", 43, receipt.clone())
            .is_err()
    );
    assert!(
        engine
            .deliver_subscription_frame(
                &id,
                "one",
                &json!({"binding_id":"one","generation":8}),
                "event-1",
                frame.clone()
            )
            .is_err()
    );
    assert_eq!(engine.journal_entries(&id, 1, 500).unwrap().len(), before);
    assert!(
        engine
            .deliver_subscription_frame(&id, "one", &receipt, "event-1", frame.clone())
            .unwrap()
    );
    drop(engine);

    let restored = Engine::with_clock(dir.path(), SimClock::new(110));
    restored
        .activate_subscription(&id, "one", 42, receipt.clone())
        .unwrap();
    assert!(
        !restored
            .deliver_subscription_frame(&id, "one", &receipt, "event-1", frame.clone())
            .unwrap()
    );
    let entries = restored.journal_entries(&id, 1, 500).unwrap();
    let appends: Vec<_> = entries
        .iter()
        .filter(|e| e.entry_type == EntryType::StreamAppended)
        .collect();
    assert_eq!(appends.len(), 1);
    assert_eq!(appends[0].payload["stream"], "subscription/one");
    assert_eq!(appends[0].payload["provider_delivery_id"], "event-1");
    assert_eq!(appends[0].payload["message"], frame);
    restored
        .close_subscription(&id, "one", SubscriptionCompletionReason::Closed)
        .unwrap();
    let before = restored.journal_entries(&id, 1, 500).unwrap().len();
    assert!(
        restored
            .deliver_subscription_frame(&id, "one", &receipt, "event-2", frame)
            .is_err()
    );
    assert_eq!(restored.journal_entries(&id, 1, 500).unwrap().len(), before);
}

#[test]
fn router_snapshots_keep_absolute_timers_and_overflow_fence_across_restart() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::with_clock(dir.path(), SimClock::new(100));
    let spec =
        RunSpec::parse(&json!({"steps":[{"id":"body","type":"llm","prompt":"body"}]})).unwrap();
    let id = engine.start(spec, "router-test", Some(0)).unwrap().run_id;
    let receipt = json!({"generation":7});
    engine
        .open_subscription(
            &id,
            "one",
            vec!["github".into()],
            None,
            20,
            100,
            1000,
            false,
        )
        .unwrap();
    assert_eq!(
        engine.inspect_subscriptions(&id).unwrap()[0]["state"],
        "prepared"
    );
    engine
        .activate_subscription(&id, "one", 42, receipt.clone())
        .unwrap();
    engine.next_subscription_outcome(&id, "one", None).unwrap();
    let before = engine.inspect_subscriptions(&id).unwrap();
    assert_eq!(before[0]["idleAtMs"], 200);
    assert_eq!(before[0]["deadlineAtMs"], 1100);
    assert_eq!(before[0]["settleMs"], 20);
    assert_eq!(before[0]["ingressOffset"], 42);
    drop(engine);
    let restored = Engine::with_clock(dir.path(), SimClock::new(150));
    restored
        .next_subscription_outcome(&id, "one", None)
        .unwrap();
    assert_eq!(restored.inspect_subscriptions(&id).unwrap(), before);
    let frame = json!({"type":"github","payload":{"id":1}});
    restored
        .deliver_subscription_frame(&id, "one", &receipt, "event-1", frame.clone())
        .unwrap();
    let snapshot = restored.inspect_subscriptions(&id).unwrap();
    assert_eq!(snapshot[0]["unreadFrames"], 1);
    assert_eq!(
        snapshot[0]["unreadBytes"],
        serde_json::to_vec(&frame).unwrap().len()
    );
    assert!(
        restored
            .fence_router_subscription_overflow(&id, "one", &json!({"generation":8}))
            .is_err()
    );
    restored
        .fence_router_subscription_overflow(&id, "one", &receipt)
        .unwrap();
    drop(restored);
    let recovered = Engine::with_clock(dir.path(), SimClock::new(160));
    recovered
        .fence_router_subscription_overflow(&id, "one", &receipt)
        .unwrap();
    let snapshots = recovered.inspect_subscriptions(&id).unwrap();
    assert_eq!(snapshots[0]["state"], "closed");
    assert_eq!(snapshots[0]["completionReason"], "overflow");
    assert!(matches!(
        recovered
            .next_subscription_outcome(&id, "one", None)
            .unwrap()
            .0,
        relayflowd::engine::SubscriptionNext::Wake(
            relayflowd::engine::SubscriptionWake::Overflow { retained: 1, .. }
        )
    ));
    assert!(
        recovered
            .deliver_subscription_frame(&id, "one", &receipt, "event-2", frame)
            .is_err()
    );
    let entries = recovered.journal_entries(&id, 1, 500).unwrap();
    assert_eq!(
        entries
            .iter()
            .filter(|e| e.entry_type == EntryType::SubscriptionOverflowFenced)
            .count(),
        1
    );
    assert_eq!(
        entries
            .iter()
            .filter(|e| e.entry_type == EntryType::SubscriptionClosed)
            .count(),
        1
    );
}

/// An overflow close is two appends — `subscription.overflow_fenced`, then
/// `subscription.closed` — and each append is its own transaction. Die
/// between them and the fence stands alone. The kernel must then refuse
/// ingress, complete the close exactly once whichever way it is next asked
/// (a Cloud fence retry or a plain resume), and hand the body `Overflow`.
/// `Engine::fence_subscription_overflow` writes only the fence, which is the
/// torn state without needing a crash injection.
#[test]
fn a_fence_torn_from_its_close_refuses_ingress_and_is_completed_once_on_retry_or_resume() {
    let spec =
        || RunSpec::parse(&json!({"steps":[{"id":"body","type":"llm","prompt":"body"}]})).unwrap();
    let receipt = json!({"generation": 7});
    let frame = json!({"type":"github","payload":{"n":1}});
    let count = |engine: &Engine<SimClock>, id: &str, entry_type: EntryType| {
        engine
            .journal_entries(id, 1, 500)
            .unwrap()
            .iter()
            .filter(|entry| entry.entry_type == entry_type)
            .count()
    };
    let torn = |dir: &std::path::Path| {
        let engine = Engine::with_clock(dir, SimClock::new(100));
        let id = engine.start(spec(), "router-test", Some(0)).unwrap().run_id;
        engine
            .open_subscription(&id, "one", vec!["github".into()], None, 0, 100, 1000, false)
            .unwrap();
        engine
            .activate_subscription(&id, "one", 0, receipt.clone())
            .unwrap();
        // The body is parked on its first `next()`: a durable wait.event exists.
        assert!(matches!(
            engine
                .next_subscription_outcome(&id, "one", None)
                .unwrap()
                .0,
            relayflowd::engine::SubscriptionNext::Suspended { .. }
        ));
        assert!(
            engine
                .deliver_subscription_frame(&id, "one", &receipt, "event-1", frame.clone())
                .unwrap()
        );
        engine.fence_subscription_overflow(&id, "one").unwrap();
        assert_eq!(
            count(&engine, &id, EntryType::SubscriptionOverflowFenced),
            1
        );
        assert_eq!(count(&engine, &id, EntryType::SubscriptionClosed), 0);
        // Ingress is refused on the fence alone, and the refusal appends nothing.
        let before = engine.journal_entries(&id, 1, 500).unwrap().len();
        let refused = engine
            .deliver_subscription_frame(&id, "one", &receipt, "event-2", frame.clone())
            .unwrap_err();
        assert_eq!(refused.to_string(), "subscription_closed");
        assert_eq!(engine.journal_entries(&id, 1, 500).unwrap().len(), before);
        id
    };

    // Path 1: the cell died after the fence; Cloud retries the fence.
    let dir = tempfile::tempdir().unwrap();
    let id = torn(dir.path());
    let restored = Engine::with_clock(dir.path(), SimClock::new(120));
    restored
        .fence_router_subscription_overflow(&id, "one", &receipt)
        .unwrap();
    assert_eq!(
        count(&restored, &id, EntryType::SubscriptionOverflowFenced),
        1
    );
    assert_eq!(count(&restored, &id, EntryType::SubscriptionClosed), 1);
    let snapshot = restored.inspect_subscriptions(&id).unwrap();
    assert_eq!(snapshot[0]["state"], "closed");
    assert_eq!(snapshot[0]["completionReason"], "overflow");
    assert!(matches!(
        restored
            .next_subscription_outcome(&id, "one", None)
            .unwrap()
            .0,
        relayflowd::engine::SubscriptionNext::Wake(
            relayflowd::engine::SubscriptionWake::Overflow {
                retained: 1,
                from: 0,
                ..
            }
        )
    ));
    // A second retry adds nothing.
    restored
        .fence_router_subscription_overflow(&id, "one", &receipt)
        .unwrap();
    assert_eq!(count(&restored, &id, EntryType::SubscriptionClosed), 1);
    assert!(
        restored
            .deliver_subscription_frame(&id, "one", &receipt, "event-3", frame.clone())
            .is_err()
    );

    // Path 2: nobody retries the fence; a plain resume completes the close
    // and settles the parked wait with the overflow wake.
    let dir = tempfile::tempdir().unwrap();
    let id = torn(dir.path());
    let resumed = Engine::with_clock(dir.path(), SimClock::new(130));
    assert_eq!(
        resumed.resume(&id, None).unwrap().status,
        relayflowd::RunStatus::Parked
    );
    assert_eq!(
        count(&resumed, &id, EntryType::SubscriptionOverflowFenced),
        1
    );
    assert_eq!(count(&resumed, &id, EntryType::SubscriptionClosed), 1);
    let settled = resumed
        .journal_entries(&id, 1, 500)
        .unwrap()
        .into_iter()
        .filter(|entry| entry.entry_type == EntryType::WaitCompleted)
        .collect::<Vec<_>>();
    assert_eq!(settled.len(), 1, "{settled:?}");
    assert_eq!(settled[0].payload["result"]["wake"], "overflow");
    assert!(matches!(
        resumed
            .next_subscription_outcome(&id, "one", None)
            .unwrap()
            .0,
        relayflowd::engine::SubscriptionNext::Wake(
            relayflowd::engine::SubscriptionWake::Overflow { retained: 1, .. }
        )
    ));
    assert!(
        resumed
            .deliver_subscription_frame(&id, "one", &receipt, "event-4", frame)
            .is_err()
    );
}
