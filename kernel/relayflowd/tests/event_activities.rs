//! Crash and state-machine coverage for docs/EVENT-AWAIT.md acceptance cases.
//! These use the real SQLite journal and a simulated clock where ordering
//! matters; no mock bypasses recovery.

use relayflowd::Engine;
use relayflowd::engine::{PendingRange, SubscriptionWake};
use relayflowd_core::{Clock, EntryType, Journal, JournalEntry, RunSpec, SimClock, StreamAppendedPayload, SubscriptionAcknowledgedPayload, WaitHumanPayload};
use relayflowd_journal::SqliteJournal;
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
fn overflow_of_a_parked_next_returns_overflow_after_recovery() {
    let directory = tempfile::tempdir().unwrap();
    let clock = TestClock::new(0);
    let engine = Engine::with_clock(directory.path(), clock.clone());
    let run_id = parked_run(&engine);
    open(&engine, &run_id, 10_000);

    // This is the durable boundary of a parked next(). The fence/close then
    // races it just as a router overflow does while the body is asleep.
    let mut journal = SqliteJournal::open(directory.path().join("runs").join(format!("{run_id}.sqlite3"))).unwrap();
    journal.append(&JournalEntry::new(EntryType::WaitEvent, &run_id, None, None, 0, relayflowd_core::WaitEventPayload {
        wait_id: "pr-42/next/0".into(), event_key: "pr-42".into(), timeout_at_ms: Some(10_000),
        stream: Some("subscription/pr-42".into()), from_offset: Some(0), settle_ms: Some(0), idle_at_ms: Some(10), deadline_at_ms: Some(10_000),
    })).unwrap();
    drop(journal);
    engine.fence_subscription_overflow(&run_id, "pr-42").unwrap();

    let resumed = Engine::with_clock(directory.path(), clock);
    assert_eq!(resumed.claim_subscription_timeouts(&run_id).unwrap(), 1);
    assert_eq!(resumed.next_subscription(&run_id, "pr-42").unwrap(), SubscriptionWake::Overflow {
        retained: 0, bytes: 0, from: 0,
    });
}

#[test]
fn immediate_event_wakes_have_durable_distinct_wait_boundaries() {
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::with_clock(directory.path(), SimClock::new(0));
    let run_id = parked_run(&engine);
    open(&engine, &run_id, 10_000);

    for (delivery, number) in [("one", 1), ("two", 2)] {
        assert!(engine.append_subscription_frame(&run_id, "pr-42", delivery, json!({"type":"github.pull_request", "n": number})).unwrap());
        assert!(matches!(engine.next_subscription(&run_id, "pr-42").unwrap(), SubscriptionWake::Events { .. }));
    }

    let waits = engine.journal_entries(&run_id, 1, 100).unwrap().into_iter()
        .filter(|entry| entry.entry_type == EntryType::WaitEvent)
        .map(|entry| serde_json::from_value::<relayflowd_core::WaitEventPayload>(entry.payload).unwrap().wait_id)
        .collect::<Vec<_>>();
    assert_eq!(waits, vec!["pr-42/next/0", "pr-42/next/1"]);
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

#[test]
fn remaining_event_await_acceptance_cases_use_the_real_journal() {
    // Cases 1, 7, 8 and 11: the local router path buffers post-open frames,
    // filters self, and refuses a closed cursor.
    let directory = tempfile::tempdir().unwrap();
    let engine = Engine::with_clock(directory.path(), SimClock::new(0));
    let run_id = parked_run(&engine);
    open(&engine, &run_id, 100);
    assert_eq!(engine.append_local_subscription_event(&run_id, "github.pull_request", json!({"n": 1}), Some("busy"), Some("reviewer")).unwrap(), 1);
    assert!(matches!(engine.next_subscription(&run_id, "pr-42").unwrap(), SubscriptionWake::Events { offset: 1, .. }));
    assert!(engine.close_subscription(&run_id, "pr-42", relayflowd_core::SubscriptionCompletionReason::Closed).unwrap());
    assert_eq!(engine.append_local_subscription_event(&run_id, "github.pull_request", json!({}), Some("closed"), Some("reviewer")).unwrap(), 0);

    let self_run = parked_run(&engine);
    engine.open_subscription(&self_run, "self", vec!["github.pull_request".into()], None, 0, 10, 100, false).unwrap();
    assert_eq!(engine.append_local_subscription_event(&self_run, "github.pull_request", json!({}), Some("self"), Some("event-activity-test")).unwrap(), 0);

    // Cases 4 and 5: a settle burst yields one ordered wake; after that wake
    // idle is measured from the wake while deadline stays fixed.
    let directory = tempfile::tempdir().unwrap();
    let clock = TestClock::new(0);
    let engine = Engine::with_clock(directory.path(), clock.clone());
    let run_id = parked_run(&engine);
    engine.open_subscription(&run_id, "timed", vec!["github.pull_request".into()], None, 5, 10, 20, false).unwrap();
    for (at, n) in [(1, 1), (2, 2), (3, 3)] { clock.set(at); assert!(engine.append_subscription_frame(&run_id, "timed", &format!("d{n}"), json!({"type":"github.pull_request", "n":n})).unwrap()); }
    clock.set(8);
    assert!(matches!(engine.next_subscription(&run_id, "timed").unwrap(), SubscriptionWake::Events { offset: 3, .. }));
    clock.set(18);
    assert_eq!(engine.next_subscription(&run_id, "timed").unwrap(), SubscriptionWake::Idle);
    clock.set(20);
    assert!(matches!(engine.next_subscription(&run_id, "timed").unwrap(), SubscriptionWake::Deadline { .. }));

    // Case 3: a parked idle wait is recovered from the SQLite journal after
    // its instant passes while the owning engine is absent.
    let directory = tempfile::tempdir().unwrap();
    let clock = TestClock::new(0);
    let engine = Engine::with_clock(directory.path(), clock.clone());
    let run_id = parked_run(&engine);
    engine.open_subscription(&run_id, "idle-restart", vec!["github.pull_request".into()], None, 0, 10, 100, false).unwrap();
    let mut journal = SqliteJournal::open(directory.path().join("runs").join(format!("{run_id}.sqlite3"))).unwrap();
    journal.append(&JournalEntry::new(EntryType::WaitEvent, &run_id, None, None, 0, relayflowd_core::WaitEventPayload { wait_id: "idle-restart/next/0".into(), event_key: "idle-restart".into(), timeout_at_ms: Some(100), stream: Some("subscription/idle-restart".into()), from_offset: Some(0), settle_ms: Some(0), idle_at_ms: Some(10), deadline_at_ms: Some(100) })).unwrap();
    drop(journal); clock.set(10);
    assert_eq!(Engine::with_clock(directory.path(), clock).next_subscription(&run_id, "idle-restart").unwrap(), SubscriptionWake::Idle);

    // Case 10: the human timer is a journaled fact, claimed after restart.
    let directory = tempfile::tempdir().unwrap();
    let clock = TestClock::new(0);
    let engine = Engine::with_clock(directory.path(), clock.clone());
    let run_id = parked_run(&engine);
    let mut journal = SqliteJournal::open(directory.path().join("runs").join(format!("{run_id}.sqlite3"))).unwrap();
    journal.append(&JournalEntry::new(EntryType::WaitHuman, &run_id, None, None, 0, WaitHumanPayload { wait_id: "human".into(), prompt: "approve".into(), requested_of: "owner".into(), options: None, timeout_at_ms: Some(10), diff_ref: None })).unwrap();
    drop(journal); clock.set(10);
    assert_eq!(engine.claim_subscription_timeouts(&run_id).unwrap(), 1);

    // Cases 12 and 15: byte overflow is explicit; a normal wake is retained
    // once before a later fenced overflow closes the cursor.
    let run_id = parked_run(&engine);
    open(&engine, &run_id, 10_000);
    assert!(engine.append_subscription_frame(&run_id, "pr-42", "normal", json!({"type":"github.pull_request"})).unwrap());
    assert!(matches!(engine.next_subscription(&run_id, "pr-42").unwrap(), SubscriptionWake::Events { .. }));
    engine.fence_subscription_overflow(&run_id, "pr-42").unwrap();
    assert_eq!(engine.claim_subscription_timeouts(&run_id).unwrap(), 1);
    assert!(matches!(engine.next_subscription(&run_id, "pr-42").unwrap(), SubscriptionWake::Overflow { .. }));
    let bytes_run = parked_run(&engine);
    engine.open_subscription(&bytes_run, "bytes", vec!["github.pull_request".into()], None, 0, 10, 10_000, false).unwrap();
    assert!(!engine.append_subscription_frame(&bytes_run, "bytes", "too-big", json!("x".repeat(1_024 * 1_024))).unwrap());
    assert!(matches!(engine.next_subscription(&bytes_run, "bytes").unwrap(), SubscriptionWake::Overflow { retained: 0, bytes: 0, from: 0 }));
    let keeps_up = parked_run(&engine);
    engine.open_subscription(&keeps_up, "keeps-up", vec!["github.pull_request".into()], None, 0, 10, 10_000, false).unwrap();
    let mut journal = SqliteJournal::open(directory.path().join("runs").join(format!("{keeps_up}.sqlite3"))).unwrap();
    for offset in 0..1_001_u64 {
        journal.append(&JournalEntry::new(EntryType::StreamAppended, &keeps_up, None, None, 0, StreamAppendedPayload { stream: "subscription/keeps-up".into(), offset, producer: "event-router".into(), message: json!({"type":"github.pull_request"}), provider_delivery_id: Some(format!("kept-{offset}")) })).unwrap();
        journal.append(&JournalEntry::new(EntryType::SubscriptionAcknowledged, &keeps_up, None, None, 0, SubscriptionAcknowledgedPayload { subscription_id: "keeps-up".into(), wait_id: format!("wake-{offset}"), next_offset: Some(offset + 1) })).unwrap();
    }
    drop(journal);
    assert!(engine.append_subscription_frame(&keeps_up, "keeps-up", "kept-final", json!({"type":"github.pull_request"})).unwrap());
}
