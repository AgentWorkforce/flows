use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};

use crate::JournalStoreError;

/// Bounded retry for the WAL switch; see `Registry::open`. Named for the
/// switch specifically -- these are not a general retry policy, and a search
/// for "retry" elsewhere in the crate should not land on them by accident.
const WAL_SWITCH_RETRY_ATTEMPTS: usize = 50;
const WAL_SWITCH_RETRY_SLEEP_MS: u64 = 2;

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
        // The WAL switch: `busy_timeout` does NOT cover it. SQLite takes an
        // exclusive lock to change journal mode and does not invoke the busy
        // handler for it, so a concurrent open fails immediately with
        // `database is locked` however long the timeout is. Measured directly:
        // with the timeout set first, the racing test still failed 36 times in
        // 50, and instrumenting the batch statement-by-statement named
        // `journal_mode` every time.
        //
        // So retry it explicitly. WAL is a persistent property of the file, so
        // a loser here is racing a winner that is setting the same mode.
        let mut mode = None;
        for attempt in 0..WAL_SWITCH_RETRY_ATTEMPTS {
            match connection.query_row("PRAGMA journal_mode = WAL", [], |row| {
                row.get::<_, String>(0)
            }) {
                Ok(observed) => {
                    mode = Some(observed);
                    break;
                }
                Err(error) => {
                    if attempt + 1 == WAL_SWITCH_RETRY_ATTEMPTS {
                        return Err(error.into());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(WAL_SWITCH_RETRY_SLEEP_MS));
                }
            }
        }
        // Fail closed. Swallowing the error and continuing would leave the
        // registry in rollback-journal mode silently, which is exactly the
        // silent fallback this codebase refuses -- a reader would see a healthy
        // open and lose the concurrency guarantee the mode is there to provide.
        let mode = mode.unwrap_or_default();
        if !mode.eq_ignore_ascii_case("wal") {
            return Err(JournalStoreError::RegistryNotWal {
                path: path.to_path_buf(),
                actual: mode,
            });
        }

        // busy_timeout goes on AFTER the WAL switch, deliberately.
        //
        // It makes ordinary statements wait instead of failing instantly, which
        // is what two concurrent deliveries need. But the retry loop above is
        // bounded in ATTEMPTS, not in wall-clock, so with a 5s timeout already
        // armed a single open could block 50 x 5s. `crash_resume`'s sigkill
        // sweep opens the registry many times over, and on a GitHub runner that
        // compounded into a step that ran past 25 minutes and was cancelled
        // (run 33960456965) while passing locally in 1.5s.
        //
        // Ordering is safe to choose freely here: measured against the seeded
        // race, timeout-first and timeout-last behaved the same (36/50 and
        // 34/50 lock failures). The WAL retry is what fixed that, not this.
        connection.execute_batch(
            "PRAGMA busy_timeout = 5000;
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
             -- `boot_id` names the engine boot that wrote the claim. It exists
             -- to separate two states the repair path below could not tell
             -- apart: a run that CRASHED before registering, and a run that is
             -- concurrently in flight and has not registered YET. Both present
             -- as a claim row with no matching `runs` row, and treating the
             -- second as the first let two racing deliveries of one event each
             -- start a run (#160).
             CREATE TABLE IF NOT EXISTS event_dedupe (
               flow_key TEXT NOT NULL,
               subscription_id TEXT NOT NULL,
               dedupe_key TEXT NOT NULL,
               run_id TEXT NOT NULL,
               boot_id TEXT NOT NULL DEFAULT '',
               PRIMARY KEY (flow_key, subscription_id, dedupe_key)
             ) WITHOUT ROWID;",
        )?;
        // Trigger-plane liveness lives in a sibling module; its schema is
        // concatenated so both files' invariants land in the same
        // connection during initialization. See `subscriptions.rs` for
        // the LIVENESS_SCHEMA_SQL contents and its rationale.
        connection.execute_batch(crate::subscriptions::LIVENESS_SCHEMA_SQL)?;
        // `CREATE TABLE IF NOT EXISTS` above is inert against a database that
        // predates `boot_id`, so an existing registry needs the column added.
        // A duplicate-column error means a prior open already did it; anything
        // else is a real failure and must surface.
        // Ask the table what it has rather than adding the column and reading
        // the failure message. Matching on "duplicate column name" would couple
        // this to SQLite's wording, which is not part of any contract.
        let has_boot_id = connection
            .prepare("PRAGMA table_info(event_dedupe)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|column| column == "boot_id");
        if !has_boot_id {
            connection.execute(
                "ALTER TABLE event_dedupe ADD COLUMN boot_id TEXT NOT NULL DEFAULT ''",
                [],
            )?;
        }
        // Rows written before this column existed carry '', which matches no
        // live boot id, so they are treated as belonging to a previous boot --
        // which is exactly right: the process that wrote them is gone.
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
        boot_id: &str,
    ) -> Result<Option<String>, JournalStoreError> {
        let changed = self.connection.execute(
            "INSERT OR IGNORE INTO event_dedupe(flow_key, subscription_id, dedupe_key, run_id, boot_id)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![flow_key, subscription_id, dedupe_key, run_id, boot_id],
        )?;
        if changed == 1 {
            return Ok(None);
        }

        let (existing, existing_boot): (String, String) = self.connection.query_row(
            "SELECT run_id, boot_id FROM event_dedupe
             WHERE flow_key = ?1 AND subscription_id = ?2 AND dedupe_key = ?3",
            params![flow_key, subscription_id, dedupe_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
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

        // No run row yet. That is TWO different situations, and the difference
        // is the whole of #160:
        //
        //   * a claim from a PREVIOUS boot -- the process that took it is gone,
        //     so no one will ever spawn that run. Repair it.
        //   * a claim from THIS boot -- another delivery is between its claim
        //     and its registration right now. Repairing that starts a second
        //     run for one event, which is an exactly-once violation.
        //
        // Before `boot_id` these were indistinguishable and both were repaired,
        // so two racing deliveries each spawned a run. A same-boot claim is
        // therefore a duplicate, not wreckage.
        //
        // The in-flight caller releases its own claim if the run fails to
        // materialise (see `release_claim`), so a same-boot claim that will
        // never become a run does not linger and strand the event.
        if existing_boot == boot_id {
            return Ok(Some(existing));
        }

        // The prior boot's claim never became a run. Repair it by taking it
        // over, so the retry spawns rather than being told it is a duplicate.
        self.connection.execute(
            "UPDATE event_dedupe SET run_id = ?4, boot_id = ?5
             WHERE flow_key = ?1 AND subscription_id = ?2 AND dedupe_key = ?3",
            params![flow_key, subscription_id, dedupe_key, run_id, boot_id],
        )?;
        Ok(None)
    }

    /// Release a claim this boot took but could not turn into a run.
    ///
    /// Without this, `claim_event`'s same-boot rule would strand the event: the
    /// claim stays, every retry inside this process is told "duplicate", and no
    /// run exists to carry it. Scoped to `run_id` so a release cannot delete a
    /// claim that some other delivery has since legitimately taken over.
    pub fn release_claim(
        &self,
        flow_key: &str,
        subscription_id: &str,
        dedupe_key: &str,
        run_id: &str,
    ) -> Result<(), JournalStoreError> {
        self.connection.execute(
            "DELETE FROM event_dedupe
             WHERE flow_key = ?1 AND subscription_id = ?2 AND dedupe_key = ?3
               AND run_id = ?4",
            params![flow_key, subscription_id, dedupe_key, run_id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    /// #160, stated without concurrency. The racing integration test in
    /// `relayflowd/tests/event_wake.rs` exercises the real path but is
    /// probabilistic: it only catches the bug when a loser reads inside the
    /// winner's claim window, which measured 3 runs in 30 against a
    /// deliberately broken guard. The rule it depends on is deterministic, so
    /// it is also asserted directly here, where no scheduling is involved --
    /// and this is what actually gates the fix.
    #[test]
    fn a_same_boot_claim_with_no_run_yet_is_a_duplicate_not_wreckage() {
        let directory = tempdir().unwrap();
        let registry = Registry::open(directory.path().join("r.sqlite3")).unwrap();

        // First delivery claims and, like the real engine, has not registered
        // its run yet.
        assert_eq!(
            registry
                .claim_event("f", "s", "k", "run-a", "boot-1")
                .unwrap(),
            None
        );

        // Second delivery, same boot, arrives inside that window. Before the
        // fix this repaired the claim and returned None, spawning a second run.
        assert_eq!(
            registry
                .claim_event("f", "s", "k", "run-b", "boot-1")
                .unwrap(),
            Some("run-a".to_string()),
            "a claim held by this boot is in flight, not abandoned"
        );
    }

    /// The crash case the repair path was written for must still work: a claim
    /// left by a process that died names a run nobody will ever spawn.
    #[test]
    fn a_previous_boots_claim_with_no_run_is_repaired() {
        let directory = tempdir().unwrap();
        let registry = Registry::open(directory.path().join("r.sqlite3")).unwrap();

        assert_eq!(
            registry
                .claim_event("f", "s", "k", "run-a", "boot-1")
                .unwrap(),
            None
        );
        // A new boot finds the orphaned claim and must take it over, otherwise
        // the event is lost silently -- the exactly-once violation the original
        // repair existed to prevent.
        assert_eq!(
            registry
                .claim_event("f", "s", "k", "run-b", "boot-2")
                .unwrap(),
            None,
            "a claim from a dead boot with no run must be repaired"
        );
    }

    /// The ALTER path: a registry written before `boot_id` existed must open,
    /// gain the column, and read its pre-existing rows as a previous boot's.
    /// This branch only runs against an old database, so nothing else in the
    /// suite covers it and a refactor could drop it silently.
    #[test]
    fn a_pre_migration_registry_gains_boot_id_and_its_claims_are_repairable() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("r.sqlite3");

        // Exactly the pre-#160 schema, with a claim recorded under it.
        {
            let legacy = rusqlite::Connection::open(&path).unwrap();
            legacy
                .execute_batch(
                    "CREATE TABLE runs (
                       run_id TEXT PRIMARY KEY, file TEXT NOT NULL,
                       status TEXT NOT NULL, next_wake_at_ms INTEGER
                     ) WITHOUT ROWID;
                     CREATE TABLE event_dedupe (
                       flow_key TEXT NOT NULL, subscription_id TEXT NOT NULL,
                       dedupe_key TEXT NOT NULL, run_id TEXT NOT NULL,
                       PRIMARY KEY (flow_key, subscription_id, dedupe_key)
                     ) WITHOUT ROWID;",
                )
                .unwrap();
            legacy
                .execute(
                    "INSERT INTO event_dedupe(flow_key, subscription_id, dedupe_key, run_id)
                     VALUES ('f', 's', 'k', 'run-legacy')",
                    [],
                )
                .unwrap();
        }

        let registry = Registry::open(&path).unwrap();
        // The legacy row carries boot_id '' -- no live boot -- so it is a dead
        // process's claim and must be repaired, not treated as in flight.
        assert_eq!(
            registry.claim_event("f", "s", "k", "run-new", "boot-1").unwrap(),
            None,
            "a pre-migration claim with no run belongs to no live boot"
        );
    }

    /// A registered run dedupes regardless of which boot claimed it.
    #[test]
    fn a_registered_run_dedupes_across_boots() {
        let directory = tempdir().unwrap();
        let registry = Registry::open(directory.path().join("r.sqlite3")).unwrap();

        assert_eq!(
            registry
                .claim_event("f", "s", "k", "run-a", "boot-1")
                .unwrap(),
            None
        );
        registry
            .register("run-a", std::path::Path::new("/tmp/run-a.sqlite3"))
            .unwrap();
        assert_eq!(
            registry
                .claim_event("f", "s", "k", "run-b", "boot-2")
                .unwrap(),
            Some("run-a".to_string())
        );
    }

    /// Releasing a claim this boot could not turn into a run must free the
    /// event, or the same-boot rule above would strand it inside the process.
    #[test]
    fn releasing_a_claim_lets_the_same_boot_retry() {
        let directory = tempdir().unwrap();
        let registry = Registry::open(directory.path().join("r.sqlite3")).unwrap();

        assert_eq!(
            registry
                .claim_event("f", "s", "k", "run-a", "boot-1")
                .unwrap(),
            None
        );
        registry.release_claim("f", "s", "k", "run-a").unwrap();
        assert_eq!(
            registry
                .claim_event("f", "s", "k", "run-b", "boot-1")
                .unwrap(),
            None,
            "a released claim must not keep dedupe-ing the event"
        );
    }

    /// A release must not steal a claim some other delivery legitimately holds.
    #[test]
    fn releasing_is_scoped_to_the_claiming_run() {
        let directory = tempdir().unwrap();
        let registry = Registry::open(directory.path().join("r.sqlite3")).unwrap();

        assert_eq!(
            registry
                .claim_event("f", "s", "k", "run-a", "boot-1")
                .unwrap(),
            None
        );
        registry.release_claim("f", "s", "k", "run-stale").unwrap();
        assert_eq!(
            registry
                .claim_event("f", "s", "k", "run-b", "boot-1")
                .unwrap(),
            Some("run-a".to_string()),
            "releasing a run that does not hold the claim must be a no-op"
        );
    }

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
