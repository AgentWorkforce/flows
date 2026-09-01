//! End-to-end wire test for the trigger-plane liveness sweep.
//!
//! Proves that `engine::submit_event` writes to the subscription liveness
//! table so that `Registry::detect_stale` + `Registry::latch_stale` — the
//! same calls the background sweep task in `server::liveness` makes via
//! `sweep_pass` — will see the row and flag it stale once its budget
//! elapses. This is the "flow that has fired then stopped is silently
//! zero" gap RFC-0001 gate 2 forbids, wired end-to-end. The
//! never-fired-at-all case is a separate follow-up documented at the
//! top of server/liveness.rs.

use std::rc::Rc;

use relayflowd::Engine;
use relayflowd_core::{Clock, Event, RunSpec, SimClock};
use relayflowd_journal::Registry;
use serde_json::json;

/// A shared handle to a `SimClock` so the test can advance time between
/// `submit_event` calls while the Engine keeps its own reference to the
/// same clock. Local to this test because the kernel's own tests either
/// use `WallClock` or hold the `SimClock` inside a single scope.
#[derive(Clone)]
struct SharedSimClock(Rc<SimClock>);

impl SharedSimClock {
    fn new(now_ms: i64) -> Self {
        Self(Rc::new(SimClock::new(now_ms)))
    }
    fn set(&self, now_ms: i64) {
        self.0.set(now_ms);
    }
}

impl Clock for SharedSimClock {
    fn now_ms(&self) -> i64 {
        self.0.now_ms()
    }
}

fn tick_flow_spec() -> RunSpec {
    // Same shape used elsewhere in kernel tests — a minimal event-triggered
    // flow with one wait step. `stale_after_ms: 30_000` overrides the
    // engine's default so this test does not depend on the default staying
    // at its current value.
    let value = json!({
        "name": "liveness-test-flow",
        "version": "0.1.0",
        "triggers": [{
            "id": "tick-sub",
            "executor": "agent-worker",
            "event_type": "test.tick",
            "pattern": {},
            "dedupe_key_template": "{{event.type}}:{{payload.n}}",
            "stale_after_ms": 30_000
        }],
        "steps": [{
            "id": "log-event",
            "type": "agent",
            "instruction": "Log the triggering event payload from the wake context.",
            "depends_on": [],
            "max_iterations": 1,
            "recovery_mode": "reset",
            "retry": {
                "initial_backoff_ms": 100,
                "jitter_percent": 20,
                "max_backoff_ms": 60000,
                "multiplier": 2
            },
            "verification": {}
        }]
    });
    RunSpec::parse(&value).expect("liveness-test-flow spec should parse")
}

fn tick_event(n: u64) -> Event {
    Event {
        event_type: "test.tick".into(),
        payload: json!({"n": n}),
        key: None,
    }
}

#[test]
fn submit_event_upserts_subscription_row_and_sweep_flags_it_stale_after_budget() {
    let directory = tempfile::tempdir().unwrap();
    let clock = SharedSimClock::new(1_000_000);
    let engine = Engine::with_clock(directory.path(), clock.clone());
    let spec = tick_flow_spec();

    // Arrival — this must record the liveness row.
    let first = engine
        .submit_event(spec.clone(), tick_event(1), "liveness-test")
        .expect("submit_event should succeed on first arrival");
    assert!(first.matched, "trigger should match test.tick");
    assert!(!first.deduped, "first arrival is not a duplicate");

    // Open the registry from the same data_dir and query the sweep directly.
    // Before the budget elapses, the sweep must return nothing.
    let registry = Registry::open(directory.path().join("relayflowd.sqlite3")).unwrap();

    let healthy = registry
        .detect_stale("sweep-early", "liveness-test-worker", 1_020_000)
        .unwrap();
    assert!(
        healthy.is_empty(),
        "sweep flagged a subscription still inside its 30s budget: {healthy:?}"
    );

    // Past budget — the row now appears once. Because we're calling
    // detect_stale directly here (not the full sweep_pass which also
    // journals + latches), we must latch manually to prove the
    // caller-latches contract.
    let stale = registry
        .detect_stale("sweep-late", "liveness-test-worker", 1_030_001)
        .unwrap();
    assert_eq!(stale.len(), 1, "expected exactly one stale row: {stale:?}");
    assert_eq!(stale[0].subscription_id, "tick-sub");
    assert_eq!(stale[0].event_type, "test.tick");
    assert_eq!(stale[0].stale_after_ms, 30_000);
    assert_eq!(stale[0].last_event_at_ms, 1_000_000);
    assert_eq!(stale[0].detected_at_ms, 1_030_001);
    registry
        .latch_stale(&stale[0].flow_key, &stale[0].subscription_id, stale[0].last_event_at_ms, 1_030_001)
        .unwrap();

    // A follow-up sweep with a fresh bucket must NOT re-emit — the latch
    // is the whole reason a stopped poller produces exactly one stale
    // signal, not a torrent.
    let second_pass = registry
        .detect_stale("sweep-later", "liveness-test-worker", 1_060_000)
        .unwrap();
    assert!(
        second_pass.is_empty(),
        "sweep re-emitted a latched stale row: {second_pass:?}"
    );
}

#[test]
fn a_fresh_arrival_re_arms_the_latch_and_the_next_silence_can_stale_again() {
    // Complements the test above: proves the wire supports recovery from
    // stale, not just first-time detection. A subscription that goes stale,
    // starts firing again, and then goes silent must emit a fresh stale
    // event on the next crossing — otherwise a bouncing poller looks
    // permanently dead after its first outage.
    let directory = tempfile::tempdir().unwrap();
    let clock = SharedSimClock::new(1_000_000);
    let engine = Engine::with_clock(directory.path(), clock.clone());
    let spec = tick_flow_spec();

    engine
        .submit_event(spec.clone(), tick_event(1), "t")
        .unwrap();

    let registry = Registry::open(directory.path().join("relayflowd.sqlite3")).unwrap();
    let first = registry.detect_stale("b1", "w", 1_030_500).unwrap();
    assert_eq!(first.len(), 1, "first crossing should stale exactly once");
    registry
        .latch_stale(&first[0].flow_key, &first[0].subscription_id, first[0].last_event_at_ms, 1_030_500)
        .unwrap();

    // Simulate a resumed poller — advance the shared clock so submit_event's
    // upsert records the fresh time, then send a distinct event (different
    // dedupe key) so `claim_event` does not report it as a duplicate.
    clock.set(1_050_000);
    engine
        .submit_event(spec.clone(), tick_event(2), "t")
        .unwrap();

    // Silent again for another 30s+ — must emit a new stale.
    let second = registry.detect_stale("b2", "w", 1_090_000).unwrap();
    assert_eq!(
        second.len(),
        1,
        "post-recovery silence should emit a fresh stale row: {second:?}"
    );
    assert_eq!(second[0].last_event_at_ms, 1_050_000);
}

#[test]
fn stale_transition_is_journaled_as_subscription_stale_entry_in_the_last_known_run() {
    // RFC-0001 settled decision 7: "the journal is the boundary" — a
    // subscription.stale signal that only exists in stderr is not real
    // per the RFC. This test proves the sweep pipeline writes a typed
    // JournalEntry into the subscription's last-known run journal, so a
    // future assessor reading `journal_entries` sees the same story as
    // an operator reading stderr.
    let directory = tempfile::tempdir().unwrap();
    let clock = SharedSimClock::new(1_000_000);
    let engine = Engine::with_clock(directory.path(), clock.clone());
    let spec = tick_flow_spec();

    let submitted = engine
        .submit_event(spec.clone(), tick_event(1), "t")
        .expect("submit_event should succeed on first arrival");
    let run_id = submitted
        .run
        .as_ref()
        .expect("first submit_event should have spawned a run")
        .run_id
        .clone();

    // Drive the REAL sweep pipeline — the same function the background
    // sweep thread invokes on each tick. If a future refactor removes
    // journal_stale from inside sweep_pass, this test fails (unlike a
    // hand-rolled journal call that would keep passing).
    use relayflowd::server::liveness::sweep_pass;
    sweep_pass(directory.path(), "b1", "test-worker", 1_030_500).unwrap();

    // Re-read the run's journal via the engine's public accessor and
    // assert the SubscriptionStale entry landed with the expected payload.
    use relayflowd_core::EntryType;
    let entries = engine.journal_entries(&run_id, 1, 100).unwrap();
    let stale_entry = entries
        .iter()
        .find(|e| e.entry_type == EntryType::SubscriptionStale)
        .expect("no subscription.stale entry in the run journal");
    assert_eq!(stale_entry.payload["subscription_id"], "tick-sub");
    assert_eq!(stale_entry.payload["event_type"], "test.tick");
    assert_eq!(stale_entry.payload["last_event_at_ms"], 1_000_000);
    assert_eq!(stale_entry.payload["stale_after_ms"], 30_000);
    assert_eq!(stale_entry.payload["detected_at_ms"], 1_030_500);

    // Also assert the sweep latched the row so a follow-up detect_stale
    // returns empty (proves both journal-then-latch and re-emit-once).
    let registry = Registry::open(directory.path().join("relayflowd.sqlite3")).unwrap();
    let after_latch = registry.detect_stale("b2", "test-worker", 1_060_000).unwrap();
    assert!(
        after_latch.is_empty(),
        "sweep_pass did not latch after journaling: {after_latch:?}"
    );
}
