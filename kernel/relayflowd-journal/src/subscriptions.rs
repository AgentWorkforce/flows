//! Trigger-plane liveness: subscription-arrival tracking + sweep election.
//!
//! Split from `registry.rs` (which owns the run locator + event dedupe)
//! because this is a distinct sub-domain: the sweep has its own state
//! (`subscriptions`, `sweep_claims`), its own contract (RelayCron
//! single-winner + latch-with-CAS-guard for at-least-once-per-silence
//! semantics — the latch prevents re-emission on the happy path, and
//! the CAS prevents clobbering a legitimately re-armed row), and
//! its own consumer (`server::liveness` in the `relayflowd` crate).
//!
//! The `impl Registry` block below extends the type defined in
//! `registry.rs`; Rust allows impl blocks to live in multiple files.
//! Schema is the concatenation of `LIVENESS_SCHEMA_SQL` here with
//! `registry::open`'s existing DDL — both are `CREATE TABLE IF NOT
//! EXISTS`, order-independent.

use rusqlite::params;

use crate::{JournalStoreError, registry::Registry};

/// Schema for the two subscription-liveness tables. Concatenated into
/// `Registry::open`'s `execute_batch` call so both files' invariants
/// land in the same connection during initialization.
pub(crate) const LIVENESS_SCHEMA_SQL: &str = "
    -- Subscription liveness (RFC-0001 gate 2, 'Native's silent-death'
    -- lesson). Every successful event.submit UPSERTs the matching
    -- (flow_key, subscription_id) row with the wall-clock time it
    -- arrived. A background sweep flags rows whose last event is
    -- older than the subscription's declared stale_after_ms. Without
    -- this table, a flow that stops being triggered reports nothing
    -- and looks identical to a healthy quiet one — the exact silent
    -- failure the Native lesson forbids.
    CREATE TABLE IF NOT EXISTS subscriptions (
      flow_key         TEXT NOT NULL,
      subscription_id  TEXT NOT NULL,
      event_type       TEXT NOT NULL,
      stale_after_ms   INTEGER NOT NULL,
      last_event_at_ms INTEGER NOT NULL,
      -- NULL while healthy; set to the sweep's now_ms when the row
      -- crosses into stale. The sweep uses this column both as its
      -- 'has this already been reported' latch (so a single crossing
      -- emits exactly one stale event, not one per sweep tick) and as
      -- the timestamp downstream logs and metrics carry.
      stale_at_ms      INTEGER,
      PRIMARY KEY (flow_key, subscription_id)
    ) WITHOUT ROWID;

    -- Sweep single-winner claim (RelayCron pattern). A sweep runs at
    -- most once per bucket_id — typically a floor of now_ms by the
    -- sweep interval, so two processes that fire the sweep within the
    -- same bucket race and only the first INSERT wins. In a single-
    -- process serve this also protects against overlapping sweeps
    -- when a tick takes longer than the interval.
    CREATE TABLE IF NOT EXISTS sweep_claims (
      sweep_id      TEXT PRIMARY KEY,
      claimed_at_ms INTEGER NOT NULL,
      claimed_by    TEXT    NOT NULL
    ) WITHOUT ROWID;
";

/// A subscription the sweep just detected as stale — its last matched
/// event arrived longer ago than its declared `stale_after_ms`. Callers
/// turn this into observable action (a structured log line, an
/// escalation, a metric).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaleSubscription {
    pub flow_key: String,
    pub subscription_id: String,
    pub event_type: String,
    pub last_event_at_ms: i64,
    pub stale_after_ms: i64,
    pub detected_at_ms: i64,
}

impl Registry {
    /// Locate the most recent run this subscription spawned (via
    /// `event_dedupe.run_id`) so a sweep can journal its stale
    /// transition into a real per-run journal, not just stderr.
    /// Returns `Ok(None)` when the subscription has never fired (the
    /// "built but never provisioned" case documented as a known gap
    /// in `server::liveness`).
    ///
    /// Ordering depends on `run_id` being a lexically time-sorted
    /// ULID — the engine (`engine::wake`) generates them with
    /// `Ulid::new().to_string()`. Both `runs` and `event_dedupe` are
    /// WITHOUT ROWID, so rowid ordering is unavailable. This
    /// coupling is documented at the SQL and pinned by
    /// `last_run_for_subscription_returns_the_lex_greatest_ulid_regardless_of_insertion`
    /// in the tests below.
    pub fn last_run_for_subscription(
        &self,
        flow_key: &str,
        subscription_id: &str,
    ) -> Result<Option<crate::registry::RegistryRecord>, JournalStoreError> {
        use rusqlite::OptionalExtension;
        use std::path::PathBuf;
        self.connection()
            .query_row(
                "SELECT r.run_id, r.file, r.status, r.next_wake_at_ms
                   FROM event_dedupe d
                   JOIN runs r ON r.run_id = d.run_id
                  WHERE d.flow_key = ?1 AND d.subscription_id = ?2
                  ORDER BY r.run_id DESC
                  LIMIT 1",
                params![flow_key, subscription_id],
                |row| {
                    let file: String = row.get(1)?;
                    Ok(crate::registry::RegistryRecord {
                        run_id: row.get(0)?,
                        file: PathBuf::from(file),
                        status: row.get(2)?,
                        next_wake_at_ms: row.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    /// Record (or refresh) that a subscription is live: bump
    /// `last_event_at_ms` and clear any `stale_at_ms` latch that a prior
    /// sweep may have set. Called from every successful `event.submit`
    /// that matched a trigger — the arrival IS the liveness signal.
    ///
    /// `stale_after_ms` is the declared budget for silence; the sweep
    /// marks the row stale when `now_ms - last_event_at_ms >=
    /// stale_after_ms`. A deduped-but-matched event bumps the row
    /// (proves the trigger source is alive, even if the kernel already
    /// has this run) — this is intentional; distinguishing "genuinely
    /// alive" from "seeing a replay of an old event" is not part of
    /// this contract.
    pub fn upsert_subscription(
        &self,
        flow_key: &str,
        subscription_id: &str,
        event_type: &str,
        stale_after_ms: i64,
        now_ms: i64,
    ) -> Result<(), JournalStoreError> {
        self.connection().execute(
            "INSERT INTO subscriptions
               (flow_key, subscription_id, event_type, stale_after_ms,
                last_event_at_ms, stale_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL)
             ON CONFLICT(flow_key, subscription_id)
             DO UPDATE SET
               event_type       = excluded.event_type,
               stale_after_ms   = excluded.stale_after_ms,
               last_event_at_ms = excluded.last_event_at_ms,
               stale_at_ms      = NULL",
            params![
                flow_key,
                subscription_id,
                event_type,
                stale_after_ms,
                now_ms
            ],
        )?;
        Ok(())
    }

    /// Elect a single winner for this sweep bucket and return the rows
    /// that have crossed their silence budget. Does NOT latch them —
    /// the caller must call `latch_stale` after successfully turning
    /// each row into an observable action (journal write + log).
    ///
    /// Split from a prior "detect + latch in one transaction" shape
    /// because the observable-action write happens OUTSIDE this crate
    /// (it opens a per-run journal via `SqliteJournal`). Detect + latch
    /// must be ordered "action first, latch second" so a crash between
    /// them leaves the row un-latched for the next sweep to retry
    /// (at-least-once); latch is CAS-guarded on `last_event_at_ms` to
    /// avoid clobbering a row that a concurrent arrival re-armed.
    ///
    /// The `sweep_id` election is a RelayCron single-winner claim: at
    /// most one caller wins per identifier; losers get `Ok(vec![])`
    /// and MUST NOT retry within the same bucket.
    pub fn detect_stale(
        &self,
        sweep_id: &str,
        worker_id: &str,
        now_ms: i64,
    ) -> Result<Vec<StaleSubscription>, JournalStoreError> {
        let claimed = self.connection().execute(
            "INSERT OR IGNORE INTO sweep_claims(sweep_id, claimed_at_ms, claimed_by)
             VALUES (?1, ?2, ?3)",
            params![sweep_id, now_ms, worker_id],
        )?;
        if claimed == 0 {
            return Ok(Vec::new());
        }

        let mut statement = self.connection().prepare(
            "SELECT flow_key, subscription_id, event_type,
                    last_event_at_ms, stale_after_ms
               FROM subscriptions
              WHERE stale_at_ms IS NULL
                AND (?1 - last_event_at_ms) >= stale_after_ms",
        )?;
        let rows = statement
            .query_map(params![now_ms], |row| {
                Ok(StaleSubscription {
                    flow_key: row.get(0)?,
                    subscription_id: row.get(1)?,
                    event_type: row.get(2)?,
                    last_event_at_ms: row.get(3)?,
                    stale_after_ms: row.get(4)?,
                    detected_at_ms: now_ms,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Mark a detected-stale row as latched so the next sweep skips it.
    /// Called AFTER the caller has journaled + logged the transition.
    ///
    /// CAS guard on `last_event_at_ms`: the row is only latched if it
    /// still shows the SAME `last_event_at_ms` value the caller
    /// detected. Prevents a lost-signal race — if a fresh event arrived
    /// between `detect_stale` and `latch_stale`, the row has moved on
    /// and clobbering `stale_at_ms` would silently mark a healthy row
    /// as reported, so a later real crossing would never re-detect.
    ///
    /// Returns whether the latch actually applied (`true` = row
    /// updated, `false` = row was re-armed between detect and latch).
    /// Callers may log the `false` case for observability but must not
    /// treat it as an error.
    pub fn latch_stale(
        &self,
        flow_key: &str,
        subscription_id: &str,
        detected_last_event_at_ms: i64,
        stale_at_ms: i64,
    ) -> Result<bool, JournalStoreError> {
        let changed = self.connection().execute(
            "UPDATE subscriptions SET stale_at_ms = ?4
             WHERE flow_key = ?1
               AND subscription_id = ?2
               AND last_event_at_ms = ?3",
            params![
                flow_key,
                subscription_id,
                detected_last_event_at_ms,
                stale_at_ms
            ],
        )?;
        Ok(changed > 0)
    }

    /// Delete `sweep_claims` rows whose `claimed_at_ms < cutoff_ms`.
    /// Called from the sweep loop itself so the table stays bounded.
    /// The caller passes an absolute cutoff timestamp (typically
    /// `now_ms - retention_window_ms`), NOT a duration.
    pub fn prune_sweep_claims(&self, cutoff_ms: i64) -> Result<usize, JournalStoreError> {
        Ok(self.connection().execute(
            "DELETE FROM sweep_claims WHERE claimed_at_ms < ?1",
            params![cutoff_ms],
        )?)
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use crate::registry::Registry;

    use super::StaleSubscription;

    fn open_registry() -> (tempfile::TempDir, Registry) {
        let directory = tempdir().unwrap();
        let registry = Registry::open(directory.path().join("relayflowd.sqlite3")).unwrap();
        (directory, registry)
    }

    /// Run one full sweep (detect + latch every row). Tests that want
    /// to prove crash-window or CAS-race behavior call `detect_stale`
    /// alone and skip `latch_stale`; tests that treat the sweep as a
    /// single logical operation use this helper.
    fn sweep_and_latch(
        registry: &Registry,
        sweep_id: &str,
        worker: &str,
        now_ms: i64,
    ) -> Vec<StaleSubscription> {
        let rows = registry.detect_stale(sweep_id, worker, now_ms).unwrap();
        for row in &rows {
            registry
                .latch_stale(
                    &row.flow_key,
                    &row.subscription_id,
                    row.last_event_at_ms,
                    now_ms,
                )
                .unwrap();
        }
        rows
    }

    #[test]
    fn sweep_marks_row_stale_when_silence_exceeds_budget() {
        let (_dir, registry) = open_registry();
        registry
            .upsert_subscription("flow-A", "sub-A", "hn.story", 30_000, 1_000_000)
            .unwrap();
        let stale = sweep_and_latch(&registry, "bucket-1", "worker", 1_030_001);
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].subscription_id, "sub-A");
        assert_eq!(stale[0].last_event_at_ms, 1_000_000);
        assert_eq!(stale[0].stale_after_ms, 30_000);
        assert_eq!(stale[0].detected_at_ms, 1_030_001);
    }

    #[test]
    fn sweep_does_not_re_emit_the_same_stale_row_on_a_later_tick() {
        let (_dir, registry) = open_registry();
        registry
            .upsert_subscription("flow", "sub", "hn.story", 30_000, 1_000_000)
            .unwrap();
        let first = sweep_and_latch(&registry, "bucket-1", "w", 1_030_500);
        assert_eq!(first.len(), 1);
        let second = sweep_and_latch(&registry, "bucket-2", "w", 1_060_500);
        assert!(
            second.is_empty(),
            "sweep re-emitted a latched row: {second:?}"
        );
    }

    #[test]
    fn detect_without_latch_stays_available_for_the_next_sweep() {
        // Crash-window contract: caller may crash after detect but
        // before latch. The un-latched row must still be visible to
        // the next sweep bucket.
        let (_dir, registry) = open_registry();
        registry
            .upsert_subscription("flow", "sub", "hn.story", 30_000, 1_000_000)
            .unwrap();
        let detected = registry.detect_stale("b1", "w", 1_030_500).unwrap();
        assert_eq!(detected.len(), 1);
        let retry = registry.detect_stale("b2", "w", 1_060_000).unwrap();
        assert_eq!(retry.len(), 1, "un-latched row not re-detected: {retry:?}");
    }

    #[test]
    fn latch_is_a_no_op_if_a_fresh_event_arrived_between_detect_and_latch() {
        // Race the M lens caught. Detect sees old last_event_at_ms;
        // arrival bumps it; unguarded latch would clobber the re-armed
        // row. CAS guard on last_event_at_ms turns the latch into a
        // no-op, and the next real crossing is still detectable.
        let (_dir, registry) = open_registry();
        registry
            .upsert_subscription("flow", "sub", "hn.story", 30_000, 1_000_000)
            .unwrap();
        let stale = registry.detect_stale("b1", "w", 1_030_500).unwrap();
        assert_eq!(stale.len(), 1);
        let detected = &stale[0];
        registry
            .upsert_subscription("flow", "sub", "hn.story", 30_000, 1_040_000)
            .unwrap();
        let latched = registry
            .latch_stale("flow", "sub", detected.last_event_at_ms, 1_030_500)
            .unwrap();
        assert!(!latched, "latch_stale clobbered a re-armed row");
        let re_detected = registry.detect_stale("b2", "w", 1_070_001).unwrap();
        assert_eq!(
            re_detected.len(),
            1,
            "post-race subscription is now silently un-detectable: {re_detected:?}"
        );
        assert_eq!(re_detected[0].last_event_at_ms, 1_040_000);
    }

    #[test]
    fn upsert_after_stale_re_arms_and_next_silence_can_re_emit() {
        let (_dir, registry) = open_registry();
        registry
            .upsert_subscription("flow", "sub", "hn.story", 30_000, 1_000_000)
            .unwrap();
        assert_eq!(sweep_and_latch(&registry, "b1", "w", 1_030_500).len(), 1);
        registry
            .upsert_subscription("flow", "sub", "hn.story", 30_000, 1_040_000)
            .unwrap();
        assert!(sweep_and_latch(&registry, "b2", "w", 1_050_000).is_empty());
        let third = sweep_and_latch(&registry, "b3", "w", 1_080_000);
        assert_eq!(third.len(), 1);
        assert_eq!(third[0].last_event_at_ms, 1_040_000);
    }

    #[test]
    fn sweep_election_gives_the_first_caller_the_result_and_second_gets_empty() {
        let (_dir, registry) = open_registry();
        registry
            .upsert_subscription("flow", "sub", "hn.story", 30_000, 1_000_000)
            .unwrap();
        let winner = sweep_and_latch(&registry, "bucket-42", "w1", 1_040_000);
        assert_eq!(winner.len(), 1);
        let loser = sweep_and_latch(&registry, "bucket-42", "w2", 1_040_100);
        assert!(
            loser.is_empty(),
            "second caller in same bucket won: {loser:?}"
        );
    }

    #[test]
    fn sweep_ignores_subscriptions_whose_silence_is_still_within_budget() {
        let (_dir, registry) = open_registry();
        registry
            .upsert_subscription("flow", "sub", "hn.story", 30_000, 1_000_000)
            .unwrap();
        assert!(sweep_and_latch(&registry, "b", "w", 1_029_999).is_empty());
    }

    #[test]
    fn upsert_is_idempotent_across_bumps_and_preserves_event_type_updates() {
        let (_dir, registry) = open_registry();
        registry
            .upsert_subscription("flow", "sub", "hn.story", 60_000, 1_000_000)
            .unwrap();
        registry
            .upsert_subscription("flow", "sub", "hn.story_v2", 90_000, 1_005_000)
            .unwrap();
        assert!(sweep_and_latch(&registry, "b1", "w", 1_010_000).is_empty());
        let stale = sweep_and_latch(&registry, "b2", "w", 1_100_000);
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].event_type, "hn.story_v2");
        assert_eq!(stale[0].stale_after_ms, 90_000);
        assert_eq!(stale[0].last_event_at_ms, 1_005_000);
    }

    #[test]
    fn prune_sweep_claims_deletes_only_rows_older_than_cutoff() {
        let (_dir, registry) = open_registry();
        registry.detect_stale("old-bucket", "w", 100).unwrap();
        registry.detect_stale("recent-bucket", "w", 1_000).unwrap();
        let removed = registry.prune_sweep_claims(500).unwrap();
        assert_eq!(removed, 1);
        let recent = registry.detect_stale("recent-bucket", "w", 2_000).unwrap();
        assert!(recent.is_empty(), "pruned wrong row: {recent:?}");
    }

    #[test]
    fn last_run_for_subscription_returns_none_before_first_arrival() {
        let (_dir, registry) = open_registry();
        registry
            .upsert_subscription("flow", "sub", "hn.story", 30_000, 1_000_000)
            .unwrap();
        assert!(
            registry
                .last_run_for_subscription("flow", "sub")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn last_run_for_subscription_returns_the_lex_greatest_ulid_regardless_of_insertion() {
        // Three inserts, greatest ULID in the middle. Insertion-order
        // regressions (rowid ASC or DESC) or an omitted ORDER BY all
        // fail — only `ORDER BY r.run_id DESC` passes.
        let (dir, registry) = open_registry();
        registry
            .claim_event("flow", "sub", "k1", "01AAAAAA", "boot")
            .unwrap();
        registry
            .register("01AAAAAA", &dir.path().join("a.sqlite3"))
            .unwrap();
        registry
            .claim_event("flow", "sub", "k2", "01ZZZZZZ", "boot")
            .unwrap();
        registry
            .register("01ZZZZZZ", &dir.path().join("z.sqlite3"))
            .unwrap();
        registry
            .claim_event("flow", "sub", "k3", "01MMMMMM", "boot")
            .unwrap();
        registry
            .register("01MMMMMM", &dir.path().join("m.sqlite3"))
            .unwrap();
        let record = registry
            .last_run_for_subscription("flow", "sub")
            .unwrap()
            .expect("subscription with matching runs must have a last run");
        assert_eq!(
            record.run_id, "01ZZZZZZ",
            "SQL is not ordering by run_id DESC — record: {record:?}"
        );
    }
}
