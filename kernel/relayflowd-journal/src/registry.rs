use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

use crate::JournalStoreError;
use crate::sqlite::{self, WalError};

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunAdmissionClaim {
    Acquired,
    Existing(String),
    Recover(String),
    Conflict,
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
        // Fail closed. Swallowing a missed WAL switch would leave the
        // registry in rollback-journal mode, and a reader would see a
        // healthy open with none of the concurrency the mode is there
        // to provide. The switch itself, and why it is not repeated once
        // the file is already WAL, lives in `sqlite::ensure_wal`.
        match sqlite::ensure_wal(&connection) {
            Ok(()) => {}
            Err(WalError::NotWal(actual)) => {
                return Err(JournalStoreError::RegistryNotWal {
                    path: path.to_path_buf(),
                    actual,
                });
            }
            Err(WalError::Sqlite(error)) => return Err(error.into()),
        }
        // DDL on every open re-takes the write lock just to notice the
        // tables are already there. Lease renewals are that open. Skip it
        // once the schema this process knows how to migrate is present;
        // `schema_is_current` has to name every table and the `boot_id`
        // column, or an old registry would never be migrated.
        if !schema_is_current(&connection)? {
            connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS runs (
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
             ) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS run_admissions (
               admission_key TEXT PRIMARY KEY,
               spec_hash TEXT NOT NULL,
               run_id TEXT NOT NULL,
               boot_id TEXT NOT NULL
             ) WITHOUT ROWID;",
            )?;
            // Trigger-plane liveness lives in a sibling module; its schema is
            // concatenated so both files' invariants land in the same
            // connection during initialization. See `subscriptions.rs` for
            // the LIVENESS_SCHEMA_SQL contents and its rationale.
            connection.execute_batch(crate::subscriptions::LIVENESS_SCHEMA_SQL)?;
            // `CREATE TABLE IF NOT EXISTS` above is inert against a database that
            // predates `boot_id`, so an existing registry needs the column added.
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
        }
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

    /// Claim one caller-owned start identity before creating its run journal.
    ///
    /// A registered claim is the durable admission receipt. An unregistered
    /// claim from this boot is still in flight; one from an older boot is safe
    /// to repair because its process cannot finish creating the claimed run.
    /// The spec hash is immutable so one key can never name two programs.
    pub fn claim_run_admission(
        &mut self,
        admission_key: &str,
        spec_hash: &str,
        proposed_run_id: &str,
        boot_id: &str,
    ) -> Result<RunAdmissionClaim, JournalStoreError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "INSERT OR IGNORE INTO run_admissions(admission_key, spec_hash, run_id, boot_id)
             VALUES (?1, ?2, ?3, ?4)",
            params![admission_key, spec_hash, proposed_run_id, boot_id],
        )?;
        if changed == 1 {
            transaction.commit()?;
            return Ok(RunAdmissionClaim::Acquired);
        }

        let (existing_hash, existing_run, existing_boot): (String, String, String) = transaction
            .query_row(
                "SELECT spec_hash, run_id, boot_id FROM run_admissions
                 WHERE admission_key = ?1",
                [admission_key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
        if existing_hash != spec_hash {
            transaction.commit()?;
            return Ok(RunAdmissionClaim::Conflict);
        }
        let registered: i64 = transaction.query_row(
            "SELECT COUNT(1) FROM runs WHERE run_id = ?1",
            [&existing_run],
            |row| row.get(0),
        )?;
        if registered > 0 {
            if existing_boot != boot_id {
                transaction.execute(
                    "UPDATE run_admissions SET boot_id = ?2 WHERE admission_key = ?1",
                    params![admission_key, boot_id],
                )?;
                transaction.commit()?;
                return Ok(RunAdmissionClaim::Recover(existing_run));
            }
            transaction.commit()?;
            return Ok(RunAdmissionClaim::Existing(existing_run));
        }
        if existing_boot == boot_id {
            transaction.commit()?;
            return Ok(RunAdmissionClaim::Existing(existing_run));
        }

        transaction.execute(
            "UPDATE run_admissions SET run_id = ?2, boot_id = ?3
             WHERE admission_key = ?1",
            params![admission_key, proposed_run_id, boot_id],
        )?;
        transaction.commit()?;
        Ok(RunAdmissionClaim::Acquired)
    }

    pub fn release_run_admission(
        &self,
        admission_key: &str,
        run_id: &str,
    ) -> Result<(), JournalStoreError> {
        self.connection.execute(
            "DELETE FROM run_admissions WHERE admission_key = ?1 AND run_id = ?2",
            params![admission_key, run_id],
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

/// Every table `open` creates, plus the `boot_id` column added after the
/// fact. A miss falls through to DDL; a hit must not, or every heartbeat
/// takes a write lock to recreate schema that is already there.
fn schema_is_current(connection: &Connection) -> Result<bool, rusqlite::Error> {
    let names = {
        let mut statement = connection.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN \
             ('runs', 'event_dedupe', 'run_admissions', 'subscriptions', 'sweep_claims')",
        )?;
        statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    if names.len() != 5 {
        return Ok(false);
    }
    let columns = {
        let mut statement = connection.prepare("PRAGMA table_info(event_dedupe)")?;
        statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?
    };
    Ok(columns.iter().any(|column| column == "boot_id"))
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

    #[test]
    fn run_admission_reuses_registered_run_and_rejects_spec_drift() {
        let directory = tempdir().unwrap();
        let mut registry = Registry::open(directory.path().join("r.sqlite3")).unwrap();
        assert_eq!(
            registry
                .claim_run_admission("root", "hash-a", "run-a", "boot-1")
                .unwrap(),
            RunAdmissionClaim::Acquired
        );
        registry
            .register("run-a", directory.path().join("run-a.sqlite3").as_path())
            .unwrap();
        assert_eq!(
            registry
                .claim_run_admission("root", "hash-a", "run-b", "boot-1")
                .unwrap(),
            RunAdmissionClaim::Existing("run-a".to_string())
        );
        assert_eq!(
            registry
                .claim_run_admission("root", "hash-b", "run-b", "boot-1")
                .unwrap(),
            RunAdmissionClaim::Conflict
        );
    }

    #[test]
    fn prior_boot_unregistered_run_admission_is_repaired() {
        let directory = tempdir().unwrap();
        let mut registry = Registry::open(directory.path().join("r.sqlite3")).unwrap();
        assert_eq!(
            registry
                .claim_run_admission("root", "hash", "run-a", "boot-1")
                .unwrap(),
            RunAdmissionClaim::Acquired
        );
        assert_eq!(
            registry
                .claim_run_admission("root", "hash", "run-b", "boot-2")
                .unwrap(),
            RunAdmissionClaim::Acquired
        );
        assert_eq!(
            registry
                .claim_run_admission("root", "hash", "run-c", "boot-2")
                .unwrap(),
            RunAdmissionClaim::Existing("run-b".to_string())
        );
    }

    #[test]
    fn concurrent_same_boot_run_admissions_have_one_owner() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("r.sqlite3");
        Registry::open(&path).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let claims = ["run-a", "run-b"].map(|run_id| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut registry = Registry::open(path).unwrap();
                barrier.wait();
                registry
                    .claim_run_admission("root", "hash", run_id, "boot-1")
                    .unwrap()
            })
        });
        let results = claims.map(|claim| claim.join().unwrap());
        assert_eq!(
            results
                .iter()
                .filter(|claim| matches!(claim, RunAdmissionClaim::Acquired))
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|claim| matches!(claim, RunAdmissionClaim::Existing(_)))
                .count(),
            1
        );
    }

    #[test]
    fn concurrent_new_boot_retries_have_one_recovery_owner() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("r.sqlite3");
        let mut registry = Registry::open(&path).unwrap();
        assert_eq!(
            registry
                .claim_run_admission("root", "hash", "run-a", "dead-boot")
                .unwrap(),
            RunAdmissionClaim::Acquired
        );
        registry
            .register("run-a", directory.path().join("run-a.sqlite3").as_path())
            .unwrap();
        drop(registry);

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let claims = ["run-b", "run-c"].map(|run_id| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut registry = Registry::open(path).unwrap();
                barrier.wait();
                registry
                    .claim_run_admission("root", "hash", run_id, "new-boot")
                    .unwrap()
            })
        });
        let results = claims.map(|claim| claim.join().unwrap());
        assert_eq!(
            results
                .iter()
                .filter(|claim| matches!(claim, RunAdmissionClaim::Recover(run) if run == "run-a"))
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|claim| matches!(claim, RunAdmissionClaim::Existing(run) if run == "run-a"))
                .count(),
            1
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
            registry
                .claim_event("f", "s", "k", "run-new", "boot-1")
                .unwrap(),
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

    fn waiting_run(path: &std::path::Path) {
        let registry = Registry::open(path).unwrap();
        registry
            .register("run", std::path::Path::new("run.sqlite3"))
            .unwrap();
        registry
            .set_status("run", "waiting_worker", Some(1))
            .unwrap();
        let timeout: i64 = registry
            .connection()
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .unwrap();
        assert_eq!(timeout, crate::sqlite::BUSY_TIMEOUT.as_millis() as i64);
        let mode: String = registry
            .connection()
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert!(mode.eq_ignore_ascii_case("wal"), "{mode}");
    }

    /// A reader must not block a lease renewal. Rollback-journal mode would,
    /// and the renewal would sit until `busy_timeout` and then fail the
    /// heartbeat. WAL is what makes the write commit while the read is open.
    #[test]
    fn renew_deadline_commits_while_another_connection_holds_a_read() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("r.sqlite3");
        waiting_run(&path);

        let holder = Registry::open(&path).unwrap();
        holder.connection().execute_batch("BEGIN").unwrap();
        let _count: i64 = holder
            .connection()
            .query_row("SELECT COUNT(*) FROM runs", [], |row| row.get(0))
            .unwrap();

        let path_for_writer = path.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let outcome = (|| -> Result<bool, JournalStoreError> {
                let registry = Registry::open(&path_for_writer)?;
                registry.renew_deadline("run", 50)
            })();
            tx.send(outcome.map_err(|error| error.to_string())).ok();
        });

        let renewed = rx.recv_timeout(std::time::Duration::from_secs(2));
        drop(holder);
        worker.join().unwrap();
        assert_eq!(
            renewed.expect("renewal blocked on a reader; journal is not WAL"),
            Ok(true)
        );
        let record = Registry::open(&path)
            .unwrap()
            .lookup("run")
            .unwrap()
            .unwrap();
        assert_eq!(record.next_wake_at_ms, Some(50));
    }

    /// The other connection's open happens *while* the write is held, which
    /// is the heartbeat path: `Registry::open` then `renew_deadline`. The
    /// old open re-ran `PRAGMA journal_mode = WAL` and gave up in ~100ms
    /// because that switch ignores `busy_timeout`.
    #[test]
    fn renew_deadline_waits_out_a_short_write_instead_of_failing_locked() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Barrier};

        let directory = tempdir().unwrap();
        let path = directory.path().join("r.sqlite3");
        waiting_run(&path);

        let holder = Registry::open(&path).unwrap();
        holder
            .connection()
            .execute_batch("BEGIN IMMEDIATE")
            .unwrap();
        holder
            .connection()
            .execute(
                "UPDATE runs SET next_wake_at_ms = 2 WHERE run_id = 'run'",
                [],
            )
            .unwrap();

        let path_for_writer = path.clone();
        let release = Arc::new(Barrier::new(2));
        let started = Arc::new(AtomicBool::new(false));
        let release_for_writer = release.clone();
        let started_for_writer = started.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            release_for_writer.wait();
            started_for_writer.store(true, Ordering::SeqCst);
            let outcome = (|| -> Result<bool, JournalStoreError> {
                let registry = Registry::open(&path_for_writer)?;
                registry.renew_deadline("run", 99)
            })();
            tx.send(outcome.map_err(|error| error.to_string())).ok();
        });

        release.wait();
        let give_up = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !started.load(Ordering::SeqCst) {
            assert!(
                std::time::Instant::now() < give_up,
                "renewing connection did not start"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let early = rx.recv_timeout(std::time::Duration::from_millis(400));
        assert!(
            matches!(early, Err(std::sync::mpsc::RecvTimeoutError::Timeout)),
            "renewal finished while the write was still open: {early:?}"
        );

        holder.connection().execute_batch("COMMIT").unwrap();
        let renewed = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("renewal did not finish after the writer committed");
        worker.join().unwrap();
        assert_eq!(
            renewed,
            Ok(true),
            "a lock that clears must not fail the renewal"
        );
        let record = Registry::open(&path)
            .unwrap()
            .lookup("run")
            .unwrap()
            .unwrap();
        assert_eq!(record.next_wake_at_ms, Some(99));
    }

    /// A write that cannot commit is still an error. Waiting out a lock
    /// must not turn into swallowing the failure.
    #[test]
    fn renew_deadline_does_not_swallow_a_write_that_cannot_commit() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("r.sqlite3");
        waiting_run(&path);
        let registry = Registry::open(&path).unwrap();
        registry
            .connection()
            .execute_batch("PRAGMA query_only = ON")
            .unwrap();
        let error = registry.renew_deadline("run", 5).unwrap_err();
        let message = error.to_string();
        assert!(
            message.contains("readonly") || message.contains("read-only"),
            "{message}"
        );
    }
}
