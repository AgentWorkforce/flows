//! Crash and state-machine coverage for docs/EVENT-AWAIT.md acceptance cases.
//! These use the real SQLite journal and a simulated clock where ordering
//! matters; no mock bypasses recovery.

use relayflowd::Engine;
use relayflowd::engine::{PendingRange, SubscriptionWake};
use relayflowd_core::{Clock, EntryType, RunSpec, SimClock};
use serde_json::json;
use std::sync::{Arc, atomic::{AtomicI64, Ordering}};

#[derive(Clone)]
struct TestClock(Arc<AtomicI64>);
impl TestClock {
    fn new(now: i64) -> Self { Self(Arc::new(AtomicI64::new(now))) }
    fn set(&self, now: i64) { self.0.store(now, Ordering::SeqCst); }
}
impl Clock for TestClock { fn now_ms(&self) -> i64 { self.0.load(Ordering::SeqCst) } }

fn parked_run<C: relayflowd_core::Clock>(engine: &Engine<C>) -> String {
    let spec = RunSpec::parse(&serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"), "/../../testdata/hello-agent.spec.canonical.json"
    ))).unwrap()).unwrap();
    engine.start(spec, "event-activity-test", Some(0)).unwrap().run_id
}

fn open<C: relayflowd_core::Clock>(engine: &Engine<C>, run_id: &str, deadline_ms: i64) {
    engine.open_subscription(
        run_id, "pr-42", vec!["github.pull_request".to_owned()], None,
        0, 10, deadline_ms, false,
    ).unwrap();
}

#[test]
fn accepted_append_is_buffered_deduplicated_and_survives_a_restart_before_next() {
    let directory = tempfile::tempdir().unwrap();
    let clock = SimClock::new(100);
    let engine = Engine::with_clock(directory.path(), clock);
    let run_id = parked_run(&engine);
    open(&engine, &run_id, 1_000);

    assert!(engine.append_subscription_frame(&run_id, "pr-42", "delivery-1", json!({"type":"github.pull_request", "n": 1})).unwrap());
    assert!(!engine.append_subscription_frame(&run_id, "pr-42", "delivery-1", json!({"type":"github.pull_request", "n": 1})).unwrap());

    // Fresh Engine + same journal is the crash boundary after stream.appended
    // and before an activity wait can complete.
    let resumed = Engine::with_clock(directory.path(), SimClock::new(100));
    assert_eq!(resumed.next_subscription(&run_id, "pr-42").unwrap(), SubscriptionWake::Events {
        events: vec![json!({"type":"github.pull_request", "n": 1})], offset: 1,
    });
    let entries = resumed.journal_entries(&run_id, 1, 100).unwrap();
    assert_eq!(entries.iter().filter(|entry| entry.entry_type == EntryType::StreamAppended).count(), 1);
}

#[test]
fn idle_wait_is_durable_and_fires_without_an_event() {
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::new(directory.path());
    let run_id = parked_run(&engine);
    engine.open_subscription(&run_id, "quiet", vec!["github.pull_request".to_owned()], None, 0, 1, 100, false).unwrap();
    assert_eq!(engine.next_subscription(&run_id, "quiet").unwrap(), SubscriptionWake::Idle);
    assert!(engine.journal_entries(&run_id, 1, 100).unwrap().iter().any(|entry| entry.entry_type == EntryType::WaitCompleted));
}

#[test]
fn exact_deadline_tie_wins_and_reports_unread_range() {
    let directory = tempfile::tempdir().unwrap();
    let clock = TestClock::new(0);
    let engine = Engine::with_clock(directory.path(), clock.clone());
    let run_id = parked_run(&engine);
    open(&engine, &run_id, 10);
    clock.set(10);
    assert!(engine.append_subscription_frame(&run_id, "pr-42", "at-deadline", json!({"type":"github.pull_request"})).unwrap());
    assert_eq!(engine.next_subscription(&run_id, "pr-42").unwrap(), SubscriptionWake::Deadline {
        pending: Some(PendingRange { from: 0, to: 1 }),
    });
}

#[test]
fn overflow_closes_before_the_1001st_unread_frame_and_recovery_never_reopens_it() {
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::with_clock(directory.path(), SimClock::new(0));
    let run_id = parked_run(&engine);
    open(&engine, &run_id, 10_000);
    for number in 0..1_000 {
        assert!(engine.append_subscription_frame(&run_id, "pr-42", &format!("delivery-{number}"), json!({"type":"github.pull_request", "n": number})).unwrap());
    }
    // Simulate SIGKILL after the router's durable fence and before its close
    // command reaches this local journal sequencer.
    engine.fence_subscription_overflow(&run_id, "pr-42").unwrap();
    assert!(!engine.append_subscription_frame(&run_id, "pr-42", "would-exceed", json!({"type":"github.pull_request", "n": 1_000})).unwrap());
    assert_eq!(engine.journal_entries(&run_id, 1, 2_000).unwrap().iter().filter(|entry| entry.entry_type == EntryType::SubscriptionOverflowFenced).count(), 1);

    let resumed = Engine::with_clock(directory.path(), SimClock::new(0));
    assert_eq!(resumed.claim_subscription_timeouts(&run_id).unwrap(), 1);
    assert!(matches!(resumed.next_subscription(&run_id, "pr-42").unwrap(), SubscriptionWake::Overflow { retained: 1_000, bytes, from: 0 } if bytes > 0));
    let entries = resumed.journal_entries(&run_id, 1, 2_000).unwrap();
    assert_eq!(entries.iter().filter(|entry| entry.entry_type == EntryType::StreamAppended).count(), 1_000);
    assert_eq!(entries.iter().filter(|entry| entry.entry_type == EntryType::SubscriptionClosed).count(), 1);
}

#[test]
fn cancel_closes_an_open_activity_before_the_terminal_run_record() {
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::with_clock(directory.path(), SimClock::new(0));
    let run_id = parked_run(&engine);
    open(&engine, &run_id, 1_000);
    engine.cancel(&run_id, "event-activity-test").unwrap();
    let entries = engine.journal_entries(&run_id, 1, 100).unwrap();
    let close = entries.iter().position(|entry| entry.entry_type == EntryType::SubscriptionClosed).unwrap();
    let terminal = entries.iter().position(|entry| entry.entry_type == EntryType::RunCompleted).unwrap();
    assert!(close < terminal, "activity close must be durable before terminal run completion");
}
