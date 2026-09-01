use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};

use crate::JournalStoreError;

pub struct Registry {
    connection: Connection,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryRecord {
    pub run_id: String,
    pub file: PathBuf,
    pub status: String,
    pub next_wake_at_ms: Option<i64>,
}

impl Registry {
    /// Sibling-module access to the underlying connection. `pub(crate)`
    /// so the `subscriptions` module (which extends `impl Registry`)
    /// can issue queries against the same handle without adopting a
    /// separate connection or plumbing methods through a trait.
    pub(crate) fn connection(&self) -> &Connection {
        &self.connection
    }
}

impl Registry {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, JournalStoreError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             CREATE TABLE IF NOT EXISTS runs (
               run_id TEXT PRIMARY KEY,
               file TEXT NOT NULL,
               status TEXT NOT NULL,
               next_wake_at_ms INTEGER
             ) WITHOUT ROWID;
             -- The dedupe identity is (flow, subscription, key), not the key
             -- alone. A bare key is globally unique, so two unrelated flows
             -- that derive the same key -- both using a template like
             -- `test.ping:hello` -- would collide, and the second flow's event
             -- would be reported deduped without ever spawning a run.
             CREATE TABLE IF NOT EXISTS event_dedupe (
               flow_key TEXT NOT NULL,
               subscription_id TEXT NOT NULL,
               dedupe_key TEXT NOT NULL,
               run_id TEXT NOT NULL,
               PRIMARY KEY (flow_key, subscription_id, dedupe_key)
             ) WITHOUT ROWID;",
        )?;
        // Trigger-plane liveness lives in a sibling module; its schema is
        // concatenated so both files' invariants land in the same
        // connection during initialization. See `subscriptions.rs` for
        // the LIVENESS_SCHEMA_SQL contents and its rationale.
        connection.execute_batch(crate::subscriptions::LIVENESS_SCHEMA_SQL)?;
        Ok(Self { connection })
    }

    pub fn register(&self, run_id: &str, file: &Path) -> Result<(), JournalStoreError> {
        self.connection.execute(
            "INSERT INTO runs(run_id, file, status, next_wake_at_ms)
             VALUES (?1, ?2, 'running', NULL)",
            params![run_id, file.to_string_lossy()],
        )?;
        Ok(())
    }

    pub fn set_status(
        &self,
        run_id: &str,
        status: &str,
        next_wake_at_ms: Option<i64>,
    ) -> Result<(), JournalStoreError> {
        let changed = self.connection.execute(
            "UPDATE runs SET status = ?2, next_wake_at_ms = ?3 WHERE run_id = ?1",
            params![run_id, status, next_wake_at_ms],
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows.into());
        }
        Ok(())
    }

    /// Durably extend a waiting run's lease deadline (heartbeat renewal).
    /// Returns whether a waiting_worker row was updated; a run that has moved
    /// on (completed, parked) is left untouched — the caller's lease check,
    /// not this locator, decides whether the heartbeat itself is valid.
    pub fn renew_deadline(
        &self,
        run_id: &str,
        lease_deadline_ms: i64,
    ) -> Result<bool, JournalStoreError> {
        let changed = self.connection.execute(
            "UPDATE runs SET next_wake_at_ms = ?2
             WHERE run_id = ?1 AND status = 'waiting_worker'",
            params![run_id, lease_deadline_ms],
        )?;
        Ok(changed > 0)
    }

    pub fn lookup(&self, run_id: &str) -> Result<Option<RegistryRecord>, JournalStoreError> {
        self.connection
            .query_row(
                "SELECT run_id, file, status, next_wake_at_ms FROM runs WHERE run_id = ?1",
                [run_id],
                |row| {
                    let file: String = row.get(1)?;
                    Ok(RegistryRecord {
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

    /// Claim an event for exactly-once delivery.
    ///
    /// Returns `Ok(None)` when this caller won the claim and must spawn the
    /// run, or `Ok(Some(existing_run_id))` when a live run already owns it.
    ///
    /// The claim is scoped to (flow, subscription, key): a bare key is
    /// globally unique and would let unrelated subscriptions suppress one
    /// another.
    ///
    /// A claim is only honoured when the run it names is actually registered.
    /// The claim is written before the run's journal exists, so a crash in
    /// between used to leave a claim pointing at a run that could never be
    /// resumed -- every retry then answered "deduped" with no run, and the
    /// event was lost silently. That is an exactly-once violation, not a
    /// missed optimisation. An incomplete claim is now REPAIRED: it is handed
    /// to the retrying caller, which spawns the run it names.
    pub fn claim_event(
        &self,
        flow_key: &str,
        subscription_id: &str,
        dedupe_key: &str,
        run_id: &str,
    ) -> Result<Option<String>, JournalStoreError> {
        let changed = self.connection.execute(
            "INSERT OR IGNORE INTO event_dedupe(flow_key, subscription_id, dedupe_key, run_id)
             VALUES (?1, ?2, ?3, ?4)",
            params![flow_key, subscription_id, dedupe_key, run_id],
        )?;
        if changed == 1 {
            return Ok(None);
        }

        let existing: String = self.connection.query_row(
            "SELECT run_id FROM event_dedupe
             WHERE flow_key = ?1 AND subscription_id = ?2 AND dedupe_key = ?3",
            params![flow_key, subscription_id, dedupe_key],
            |row| row.get(0),
        )?;

        // Is the claimed run real? `runs` is written when the run is
        // registered, after its journal exists.
        let registered: i64 = self.connection.query_row(
            "SELECT COUNT(1) FROM runs WHERE run_id = ?1",
            params![&existing],
            |row| row.get(0),
        )?;
        if registered > 0 {
            return Ok(Some(existing));
        }

        // The prior claim never became a run. Repair it by taking it over, so
        // the retry spawns rather than being told it is a duplicate.
        self.connection.execute(
            "UPDATE event_dedupe SET run_id = ?4
             WHERE flow_key = ?1 AND subscription_id = ?2 AND dedupe_key = ?3",
            params![flow_key, subscription_id, dedupe_key, run_id],
        )?;
        Ok(None)
    }

}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    fn open_registry() -> (tempfile::TempDir, Registry) {
        let directory = tempdir().unwrap();
        let registry = Registry::open(directory.path().join("relayflowd.sqlite3")).unwrap();
        (directory, registry)
    }

    #[test]
    fn registry_is_a_rebuildable_run_locator() {
        let (directory, registry) = open_registry();
        let run_file = directory.path().join("runs/run.sqlite3");
        registry.register("run", &run_file).unwrap();
        registry.set_status("run", "completed", None).unwrap();
        let record = registry.lookup("run").unwrap().unwrap();
        assert_eq!(record.file, run_file);
        assert_eq!(record.status, "completed");
    }

}
