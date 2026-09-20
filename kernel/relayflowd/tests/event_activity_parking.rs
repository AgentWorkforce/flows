use relayflowd::{
    Engine,
    engine::{StepStatus, SubscriptionPark, SubscriptionWaitPhase},
    worker::{DispatchOutcome, JournalObserver, StepDispatch, StepDispatcher},
};
use relayflowd_core::{EntryType, JournalEntry, RunSpec, SimClock, StepType};
use serde_json::json;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Worker(Mutex<Vec<StepDispatch>>);
impl JournalObserver for Worker {
    fn appended(&self, _: &JournalEntry) {}
}
impl StepDispatcher for Worker {
    fn executor(&self, _: StepType) -> Option<String> {
        Some("test".into())
    }
    fn available(&self, _: StepType) -> bool {
        true
    }
    fn dispatch(&self, dispatch: StepDispatch) -> anyhow::Result<DispatchOutcome> {
        self.0.lock().unwrap().push(dispatch);
        Ok(DispatchOutcome::Dispatched)
    }
}

fn spec() -> RunSpec {
    RunSpec::parse(&json!({"steps":[{"id":"body","type":"llm","prompt":"body"}]})).unwrap()
}

#[test]
fn parked_attempt_survives_restart_and_only_a_ready_subscription_redispatches_it() {
    check_parking(false);
}

#[test]
fn activation_and_delivery_racing_the_lease_handoff_are_not_lost() {
    check_parking(true);
}

fn check_parking(race: bool) {
    let directory = tempfile::tempdir().unwrap();
    let worker = Arc::new(Worker::default());
    let engine = Engine::with_runtime(directory.path(), worker.clone(), worker.clone());
    let id = engine.start(spec(), "test", None).unwrap().run_id;
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
    let dispatch = worker.0.lock().unwrap()[0].clone();
    let park = SubscriptionPark {
        subscription_id: "events".into(),
        phase: SubscriptionWaitPhase::Activation,
    };
    let before = engine.journal_entries(&id, 1, 500).unwrap().len();
    assert!(
        engine
            .park_subscription_step(&id, "body", dispatch.attempt, "wrong-key", park.clone())
            .is_err()
    );
    assert_eq!(engine.journal_entries(&id, 1, 500).unwrap().len(), before);
    if race {
        engine
            .activate_subscription(&id, "events", 0, json!({"generation":1}))
            .unwrap();
    }
    engine
        .park_subscription_step(
            &id,
            "body",
            dispatch.attempt,
            &dispatch.idempotency_key,
            park,
        )
        .unwrap();
    assert_eq!(
        engine.snapshot(&id).unwrap().steps["body"].state,
        StepStatus::Waiting
    );
    assert_eq!(
        engine.snapshot(&id).unwrap().steps["body"].lease_deadline_ms,
        None
    );
    drop(engine);
    let engine = Engine::with_runtime(directory.path(), worker.clone(), worker.clone());
    if !race {
        for _ in 0..10 {
            engine.resume(&id, None).unwrap();
        }
        assert_eq!(worker.0.lock().unwrap().len(), 1);
        engine
            .activate_subscription(&id, "events", 0, json!({"generation":1}))
            .unwrap();
    }
    engine.resume(&id, None).unwrap();
    assert_eq!(worker.0.lock().unwrap().len(), 2);
    engine
        .next_subscription_outcome(&id, "events", None)
        .unwrap();
    if race {
        engine
            .append_subscription_frame(&id, "events", "first", json!({"payload":1}))
            .unwrap();
        engine.claim_subscription_timeouts(&id).unwrap();
    }
    let dispatch = worker.0.lock().unwrap()[1].clone();
    engine
        .park_subscription_step(
            &id,
            "body",
            dispatch.attempt,
            &dispatch.idempotency_key,
            SubscriptionPark {
                subscription_id: "events".into(),
                phase: SubscriptionWaitPhase::EventWait,
            },
        )
        .unwrap();
    if !race {
        engine
            .append_subscription_frame(&id, "events", "first", json!({"payload":1}))
            .unwrap();
    }
    engine.resume(&id, None).unwrap();
    assert_eq!(worker.0.lock().unwrap().len(), 3);
    assert!(
        !engine
            .journal_entries(&id, 1, 500)
            .unwrap()
            .iter()
            .any(|entry| entry.entry_type == EntryType::StepCompleted
                && entry.payload["completionReason"] == "crashed")
    );
}

#[test]
fn replay_keeps_each_acknowledged_batch_addressable_by_body_call_ordinal() {
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::with_clock(directory.path(), SimClock::new(0));
    let id = engine.start(spec(), "test", None).unwrap().run_id;
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
        .append_subscription_frame(&id, "events", "first", json!({"payload":1}))
        .unwrap();
    let first = engine
        .next_subscription_outcome(&id, "events", None)
        .unwrap();
    engine
        .next_subscription_outcome(&id, "events", first.1.as_deref())
        .unwrap();
    engine
        .append_subscription_frame(&id, "events", "second", json!({"payload":2}))
        .unwrap();
    engine
        .next_subscription_outcome(&id, "events", None)
        .unwrap();
    let first_replayed = engine
        .replay_subscription_wake(&id, "events", 0)
        .unwrap()
        .unwrap();
    assert_eq!(first_replayed.1, first.1);
    assert_eq!(
        serde_json::to_value(first_replayed.0).unwrap()["events"],
        json!([{"payload":1}])
    );
    assert_eq!(
        serde_json::to_value(
            engine
                .replay_subscription_wake(&id, "events", 1)
                .unwrap()
                .unwrap()
                .0
        )
        .unwrap()["events"],
        json!([{"payload":2}])
    );
    assert!(engine.replay_subscription_wake(&id, "events", 99).is_err());
}
