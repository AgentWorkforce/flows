//! Trigger-plane liveness sweep — RFC-0001 gate 2, "Native's silent-death"
//! answer.
//!
//! Every tick, ask the registry for subscriptions whose last matched event
//! fell outside their declared `stale_after_ms`, journal ONE
//! `subscription.stale` entry per newly-stale row into that subscription's
//! last-known run journal (making it real per settled decision 7 — the
//! journal is the boundary), latch the row so the transition emits once
//! per silence, and emit a structured stderr line as an observability
//! belt-and-suspenders.
//!
//! The reconciler in `reconcile.rs` handles a different sweep (lease
//! expiry of an in-flight step); this one is about the trigger *plane*
//! itself — a flow that is *never* triggered is silently zero, and this
//! module is what makes silence observable.
//!
//! ## Known gap
//!
//! Subscriptions that have never matched a single event have no row in
//! `subscriptions` and no matching `event_dedupe` row — so the sweep sees
//! nothing to report. This closes the "died after firing at least once"
//! failure mode (which is what the hn-monitor workload triggers in
//! practice); the "provisioned but never fired" case remains as a
//! follow-up. Detecting THAT one requires pre-registering all spec
//! triggers at spec-observation time, which the current `submit_event`
//! path does not do.

use std::{
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

use relayflowd_core::{EntryType, JournalEntry};
use relayflowd_journal::{Registry, SqliteJournal, StaleSubscription};
use serde_json::json;

/// The sweep runs on this cadence and buckets its single-winner claim by
/// the same value. Two 30s buckets in a row cannot re-emit the same
/// silence (the caller latches per row after journaling); overlapping
/// sweeps within the same bucket lose the claim.
pub(super) const SWEEP_INTERVAL_MS: u64 = 30_000;

/// How long a sweep_claims row is retained before pruning. One day at 30s
/// cadence is ~2880 rows — trivial storage, but bounded is the point.
const SWEEP_CLAIMS_RETENTION_MS: i64 = 24 * 60 * 60 * 1_000;

pub(super) fn spawn_liveness_sweep(data_dir: PathBuf) {
    let worker_id = format!("relayflowd-liveness-{}", std::process::id());
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_millis(SWEEP_INTERVAL_MS));
            let now_ms = super::now_ms();
            let sweep_id = sweep_id_for(now_ms);
            if let Err(error) = sweep_pass(&data_dir, &sweep_id, &worker_id, now_ms) {
                // Fail LOUD: a silently-failing liveness sweep defeats
                // the whole module's purpose. The claim is bucketed, so
                // a next-bucket retry is a distinct sweep; if this
                // sweep detected rows but failed to journal them, they
                // remain un-latched and the next bucket picks them up.
                eprintln!(
                    "relayflowd: error: liveness sweep failed at bucket {sweep_id}: {error:#}; next bucket will retry"
                );
            }
        }
    });
}

/// One sweep tick. For each newly-stale subscription:
///   1. emit the `subscription.stale` line to stderr,
///   2. journal a `subscription.stale` entry into the subscription's
///      last-known run journal,
///   3. latch the row (CAS-guarded).
///
/// The order — emit → journal → latch — is deliberate. Emit-first
/// means that even under a persistent journal-append fault, the
/// stderr line an operator would grep for still appears; skipping
/// the emit on journal failure would produce only error lines during
/// the outage, hiding which subscription was affected. Journal-before-
/// latch means a crash between the two leaves the row un-latched and
/// the next sweep bucket retries — at-least-once semantics instead of
/// at-most-once. Downstream consumers should treat two
/// `subscription.stale` entries with the same
/// (flow_key, subscription_id) and no intervening
/// `subscription.matched` as the same silence — the `detected_at_ms`
/// values will differ (they're `now_ms` at each retry).
///
/// Also prunes `sweep_claims` rows older than `SWEEP_CLAIMS_RETENTION_MS`
/// so the table stays bounded.
pub fn sweep_pass(
    data_dir: &Path,
    sweep_id: &str,
    worker_id: &str,
    now_ms: i64,
) -> anyhow::Result<()> {
    let registry = Registry::open(data_dir.join("relayflowd.sqlite3"))?;
    let detected = registry.detect_stale(sweep_id, worker_id, now_ms)?;
    // Per-row: emit stderr line ALWAYS → journal → latch. The stderr
    // line is the operator-observable signal; if we skipped it on
    // journal-write failure the sweep would spew only error lines
    // during a persistent journal fault, and the `subscription.stale`
    // string an on-call would grep for would never appear. So emit
    // first — belt-and-suspenders per the module doc — then journal,
    // then latch. A journal failure leaves the row un-latched so the
    // next bucket retries. Errors are logged and processing continues
    // to the next row so one broken subscription cannot silence the
    // sweep for the rest.
    for row in &detected {
        emit_stale_line(row);
        if let Err(error) = journal_stale(&registry, row) {
            eprintln!(
                "relayflowd: error: journaling subscription.stale for flow={:?} sub={:?} failed: {error:#}; \
                 row stays un-latched, next bucket will retry",
                row.flow_key, row.subscription_id
            );
            continue;
        }
        // CAS guard: if a fresh event arrived between detect_stale and
        // now, the row's last_event_at_ms has moved and the update is
        // a no-op. The signal we just emitted was a spurious alert
        // (harmless — at-least-once observability); the row remains
        // sweep-visible for the next real crossing.
        match registry.latch_stale(
            &row.flow_key,
            &row.subscription_id,
            row.last_event_at_ms,
            now_ms,
        ) {
            Ok(true) => {}
            Ok(false) => {
                eprintln!(
                    "relayflowd: info: subscription.stale for flow={:?} sub={:?} was re-armed by a fresh event before latch — treating as spurious",
                    row.flow_key, row.subscription_id
                );
            }
            Err(error) => {
                eprintln!(
                    "relayflowd: error: latching subscription.stale for flow={:?} sub={:?} failed: {error:#}; \
                     next bucket may re-emit — journal write already succeeded",
                    row.flow_key, row.subscription_id
                );
            }
        }
    }
    // Bounded storage for the sweep_claims table. Runs unconditionally
    // — the per-row error handling above ensures we reach this line
    // even when some rows failed. `?` here is correct: a prune error
    // is a real registry-level problem, not a per-row concern.
    registry.prune_sweep_claims(now_ms - SWEEP_CLAIMS_RETENTION_MS)?;
    Ok(())
}

/// Bucket identifier for the RelayCron single-winner claim. Two processes
/// firing sweeps within the same window collide on the same bucket, and
/// only the first insertion wins.
pub(super) fn sweep_id_for(now_ms: i64) -> String {
    let bucket = now_ms / SWEEP_INTERVAL_MS as i64;
    format!("liveness-{bucket}")
}

/// Journal the stale transition into the subscription's last-known run
/// journal. If the subscription has no matching run (never fired — see
/// the "known gap" note at the top of this file), the caller degrades to
/// log-only: the transition is still emitted to stderr in `sweep_pass`,
/// just not journaled. This does not silently drop the alert.
fn journal_stale(registry: &Registry, row: &StaleSubscription) -> anyhow::Result<()> {
    let Some(record) = registry.last_run_for_subscription(&row.flow_key, &row.subscription_id)?
    else {
        eprintln!(
            "relayflowd: warning: subscription.stale flow={:?} sub={:?} has no last-known run to journal into; \
             emitting as stderr only. This subscription may have been provisioned but never fired.",
            row.flow_key, row.subscription_id
        );
        return Ok(());
    };
    let mut journal = SqliteJournal::open(&record.file)?;
    let payload = json!({
        "flow_key": row.flow_key,
        "subscription_id": row.subscription_id,
        "event_type": row.event_type,
        "last_event_at_ms": row.last_event_at_ms,
        "stale_after_ms": row.stale_after_ms,
        "detected_at_ms": row.detected_at_ms,
    });
    let entry = JournalEntry::new(
        EntryType::SubscriptionStale,
        &record.run_id,
        None,
        None,
        row.detected_at_ms,
        payload,
    );
    use relayflowd_core::Journal as _;
    journal.append(&entry)?;
    Ok(())
}

fn emit_stale_line(entry: &StaleSubscription) {
    // One line per stale transition. User-controlled fields (`flow_key`,
    // `subscription_id`, `event_type`) are quoted with `format!("{:?}")`
    // so a subscription id containing a space or an `=` does not break
    // the parseability an operator would grep against. The
    // `subscription.stale` tag matches the journal `entry_type` value
    // so downstream dashboards can cross-reference.
    eprintln!(
        "relayflowd: subscription.stale flow={:?} sub={:?} event_type={:?} last_event_at_ms={} stale_after_ms={} detected_at_ms={}",
        entry.flow_key,
        entry.subscription_id,
        entry.event_type,
        entry.last_event_at_ms,
        entry.stale_after_ms,
        entry.detected_at_ms,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn sweep_id_buckets_by_the_interval() {
        assert_eq!(sweep_id_for(0), "liveness-0");
        assert_eq!(sweep_id_for(29_999), "liveness-0");
        assert_eq!(sweep_id_for(30_000), "liveness-1");
        assert_eq!(sweep_id_for(60_001), "liveness-2");
    }

    #[test]
    fn sweep_pass_healthy_subscription_is_a_noop() {
        let dir = tempdir().unwrap();
        let registry = Registry::open(dir.path().join("relayflowd.sqlite3")).unwrap();
        registry
            .upsert_subscription("flow", "sub", "hn.story", 60_000, 1_000_000)
            .unwrap();
        // 59_999 ms later — 1ms shy of budget.
        sweep_pass(dir.path(), &sweep_id_for(1_059_999), "w", 1_059_999).unwrap();
        // Still no latch:
        let detected = registry.detect_stale("later", "w", 1_060_001).unwrap();
        assert_eq!(detected.len(), 1, "healthy row should still be un-latched");
    }

    #[test]
    fn sweep_pass_latches_after_journaling_and_next_bucket_is_empty() {
        // End-to-end at the module boundary with a subscription that
        // has never fired — journal_stale degrades to log-only, but the
        // latch STILL happens (else the same row re-emits every 30s
        // forever).
        let dir = tempdir().unwrap();
        let registry = Registry::open(dir.path().join("relayflowd.sqlite3")).unwrap();
        registry
            .upsert_subscription("flow", "sub", "hn.story", 30_000, 1_000_000)
            .unwrap();

        // Past budget — one full pass:
        sweep_pass(dir.path(), &sweep_id_for(1_040_000), "w", 1_040_000).unwrap();

        // Next bucket, same row: must NOT re-emit (latched).
        let leftover = registry
            .detect_stale(&sweep_id_for(1_080_000), "w", 1_080_000)
            .unwrap();
        assert!(
            leftover.is_empty(),
            "subscription.stale re-emitted after being latched: {leftover:?}"
        );
    }
}
