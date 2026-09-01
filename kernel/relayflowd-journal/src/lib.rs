//! Append-only SQLite implementation of the Relayflow journal protocol.

mod append;
mod registry;
mod segment;
mod subscriptions;

use std::path::{Path, PathBuf};

use relayflowd_core::{EpochSummaryPayload, Journal, JournalEntry, JournalError, RunSpec};
use rusqlite::{Connection, OpenFlags, params};
use thiserror::Error;

pub use registry::{Registry, RegistryRecord};
pub use subscriptions::StaleSubscription;

const SCHEMA: &str = r#"
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE segments (
  segment_id      INTEGER PRIMARY KEY,
  journal_version INTEGER NOT NULL,
  opened_seq      INTEGER NOT NULL
);

CREATE TABLE entries (
  seq        INTEGER PRIMARY KEY,
  segment_id INTEGER NOT NULL REFERENCES segments(segment_id),
  entry_type TEXT    NOT NULL,
  step_id    TEXT,
  attempt    INTEGER,
  at_ms      INTEGER NOT NULL,
  payload    TEXT    NOT NULL
);
CREATE INDEX ix_entries_segment ON entries(segment_id, seq);
CREATE INDEX ix_entries_step ON entries(step_id, seq) WHERE step_id IS NOT NULL;

CREATE TABLE effects (
  step_id         TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  surface_path    TEXT NOT NULL,
  entry_seq       INTEGER NOT NULL,
  attempt         INTEGER NOT NULL,
  confirmed_seq   INTEGER,
  PRIMARY KEY (step_id, idempotency_key, surface_path)
) WITHOUT ROWID;

CREATE TABLE stream_index (
  stream    TEXT    NOT NULL,
  offset    INTEGER NOT NULL,
  entry_seq INTEGER NOT NULL,
  PRIMARY KEY (stream, offset)
) WITHOUT ROWID;
"#;

pub struct SqliteJournal {
    connection: Connection,
    run_id: String,
    path: PathBuf,
}

impl SqliteJournal {
    pub fn create(
        path: impl AsRef<Path>,
        run_id: impl Into<String>,
        created_at_ms: i64,
    ) -> Result<Self, JournalStoreError> {
        let path = path.as_ref().to_path_buf();
        if path.exists() {
            return Err(JournalStoreError::AlreadyExists(path));
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let run_id = run_id.into();
        let connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )?;
        configure(&connection)?;
        connection.execute_batch(SCHEMA)?;
        let mut journal = Self {
            connection,
            run_id,
            path,
        };
        let transaction = journal.connection.transaction()?;
        transaction.execute(
            "INSERT INTO meta(key, value) VALUES ('run_id', ?1), ('created_at_ms', ?2), ('journal_version', ?3)",
            params![journal.run_id, created_at_ms.to_string(), relayflowd_core::JOURNAL_VERSION.to_string()],
        )?;
        transaction.execute(
            "INSERT INTO segments(segment_id, journal_version, opened_seq) VALUES (1, ?1, 1)",
            [i64::from(relayflowd_core::JOURNAL_VERSION)],
        )?;
        transaction.commit()?;
        Ok(journal)
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, JournalStoreError> {
        let path = path.as_ref().to_path_buf();
        let connection = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        configure(&connection)?;
        let run_id =
            connection.query_row("SELECT value FROM meta WHERE key = 'run_id'", [], |row| {
                row.get(0)
            })?;
        Ok(Self {
            connection,
            run_id,
            path,
        })
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn scan_all(&self) -> Result<Vec<JournalEntry>, JournalStoreError> {
        self.scan_where("SELECT seq, segment_id, entry_type, step_id, attempt, at_ms, payload FROM entries ORDER BY seq", [])
    }

    pub fn run_spec(&self) -> Result<RunSpec, JournalStoreError> {
        let payload: String = self.connection.query_row(
            "SELECT payload FROM entries WHERE entry_type = 'run.spawned' ORDER BY seq LIMIT 1",
            [],
            |row| row.get(0),
        )?;
        let spawned: relayflowd_core::RunSpawnedPayload = serde_json::from_str(&payload)?;
        Ok(serde_json::from_value(spawned.spec)?)
    }

    pub fn scan_from(
        &self,
        from_seq: i64,
        limit: usize,
    ) -> Result<Vec<JournalEntry>, JournalStoreError> {
        let mut statement = self.connection.prepare(
            "SELECT seq, segment_id, entry_type, step_id, attempt, at_ms, payload
             FROM entries WHERE seq >= ?1 ORDER BY seq LIMIT ?2",
        )?;
        let rows = statement.query_map(params![from_seq, limit as i64], |row| {
            append::entry_from_row(row, &self.run_id)
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn effect_count(&self) -> Result<u64, JournalStoreError> {
        self.connection
            .query_row("SELECT COUNT(*) FROM effects", [], |row| row.get(0))
            .map_err(Into::into)
    }

    /// Elections that have been confirmed performed. A provider call happened
    /// for each; the difference from [`Self::effect_count`] is the elections
    /// still open to reclaim.
    pub fn confirmed_effect_count(&self) -> Result<u64, JournalStoreError> {
        self.connection
            .query_row(
                "SELECT COUNT(*) FROM effects WHERE confirmed_seq IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    fn scan_where<const N: usize>(
        &self,
        sql: &str,
        params: [&dyn rusqlite::ToSql; N],
    ) -> Result<Vec<JournalEntry>, JournalStoreError> {
        let mut statement = self.connection.prepare(sql)?;
        let rows = statement.query_map(rusqlite::params_from_iter(params), |row| {
            append::entry_from_row(row, &self.run_id)
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    #[cfg(test)]
    fn make_read_only(&self) -> Result<(), JournalStoreError> {
        self.connection.execute_batch("PRAGMA query_only = ON")?;
        Ok(())
    }
}

fn configure(connection: &Connection) -> Result<(), rusqlite::Error> {
    connection.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = FULL;
         PRAGMA foreign_keys = ON;",
    )
}

impl Journal for SqliteJournal {
    fn append(&mut self, entry: &JournalEntry) -> Result<JournalEntry, JournalError> {
        self.append_entry(entry).map_err(to_core_error)
    }

    fn scan_segment(&self, segment_id: i64) -> Result<Vec<JournalEntry>, JournalError> {
        self.scan_where(
            "SELECT seq, segment_id, entry_type, step_id, attempt, at_ms, payload
             FROM entries WHERE segment_id = ?1 ORDER BY seq",
            [&segment_id as &dyn rusqlite::ToSql],
        )
        .map_err(to_core_error)
    }

    fn current_segment(&self) -> Result<i64, JournalError> {
        self.connection
            .query_row("SELECT MAX(segment_id) FROM segments", [], |row| row.get(0))
            .map_err(JournalStoreError::from)
            .map_err(to_core_error)
    }

    fn rollover(
        &mut self,
        summary: EpochSummaryPayload,
        at_ms: i64,
    ) -> Result<Vec<JournalEntry>, JournalError> {
        self.rollover_segment(summary, at_ms).map_err(to_core_error)
    }
}

fn to_core_error(error: JournalStoreError) -> JournalError {
    JournalError(error.to_string())
}

#[derive(Debug, Error)]
pub enum JournalStoreError {
    #[error("journal file already exists: {0}")]
    AlreadyExists(PathBuf),
    #[error("journal I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("SQLite journal failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("journal JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unknown journal entry type {0:?}")]
    UnknownEntryType(String),
    #[error("journal entry belongs to run {actual}, expected {expected}")]
    WrongRun { expected: String, actual: String },
    #[error("journal entry targets segment {actual}, current segment is {expected}")]
    WrongSegment { expected: i64, actual: i64 },
    #[error("stream {stream} expected offset {expected}, received {actual}")]
    InvalidStreamOffset {
        stream: String,
        expected: u64,
        actual: u64,
    },
    #[error("{0} entry requires a step id")]
    MissingStep(&'static str),
    #[error("{entry} entry requires an attempt")]
    MissingAttempt { entry: &'static str },
    #[error(
        "attempt {attempt} cannot confirm effect {surface_path} on step {step_id}: it does not hold the election"
    )]
    UnelectedEffect {
        step_id: String,
        surface_path: String,
        attempt: u32,
    },
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use relayflowd_core::{
        Budget, EffectConfirmedPayload, EffectRecordedPayload, EntryType, EpochSummaryPayload,
        RunSpawnedPayload,
    };
    use serde_json::json;
    use tempfile::tempdir;

    use super::*;

    fn created() -> (tempfile::TempDir, SqliteJournal) {
        let directory = tempdir().unwrap();
        let journal =
            SqliteJournal::create(directory.path().join("run.sqlite3"), "run", 10).unwrap();
        (directory, journal)
    }

    #[test]
    fn append_is_durable_and_monotonic_after_reopen() {
        let (directory, mut journal) = created();
        let persisted = journal
            .append(&JournalEntry::new(
                EntryType::RunSpawned,
                "run",
                None,
                None,
                10,
                RunSpawnedPayload {
                    spec: json!({"steps": []}),
                    spec_hash: "hash".to_owned(),
                    parent_run_id: None,
                    journal_version: relayflowd_core::JOURNAL_VERSION,
                    created_by: "test".to_owned(),
                },
            ))
            .unwrap();
        assert_eq!(persisted.seq, 1);
        drop(journal);

        let reopened = SqliteJournal::open(directory.path().join("run.sqlite3")).unwrap();
        assert_eq!(reopened.scan_all().unwrap(), vec![persisted]);
        let synchronous: i64 = reopened
            .connection
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .unwrap();
        assert_eq!(synchronous, 2, "SQLite FULL synchronous mode");
    }

    #[test]
    fn failed_commit_is_returned_not_swallowed() {
        let (_directory, mut journal) = created();
        journal.make_read_only().unwrap();
        let error = journal
            .append(&JournalEntry::new(
                EntryType::RunSpawned,
                "run",
                None,
                None,
                0,
                json!({}),
            ))
            .unwrap_err();
        assert!(error.0.contains("readonly") || error.0.contains("read-only"));
    }

    fn election(attempt: u32) -> JournalEntry {
        JournalEntry::new(
            EntryType::EffectRecorded,
            "run",
            Some("agent".to_owned()),
            Some(attempt),
            10,
            EffectRecordedPayload {
                surface_path: "/github/pull/1".to_owned(),
                idempotency_key: "stable".to_owned(),
                revision_before: "a".to_owned(),
                revision_after: "b".to_owned(),
                agent_identity: "worker".to_owned(),
                deduped: false,
            },
        )
    }

    fn confirmation(attempt: u32) -> JournalEntry {
        JournalEntry::new(
            EntryType::EffectConfirmed,
            "run",
            Some("agent".to_owned()),
            Some(attempt),
            11,
            EffectConfirmedPayload {
                surface_path: "/github/pull/1".to_owned(),
                idempotency_key: "stable".to_owned(),
                agent_identity: "worker".to_owned(),
            },
        )
    }

    #[test]
    fn effects_are_deduplicated_at_the_journal_boundary() {
        let (_directory, mut journal) = created();
        let first = journal.append(&election(1)).unwrap();
        journal.append(&confirmation(1)).unwrap();
        let second = journal.append(&election(2)).unwrap();
        assert!(!first.payload["deduped"].as_bool().unwrap());
        assert!(second.payload["deduped"].as_bool().unwrap());
        assert_eq!(journal.effect_count().unwrap(), 1);
        assert_eq!(journal.confirmed_effect_count().unwrap(), 1);
    }

    /// Appendix A rule 5's crash window. An election is only a claim on the
    /// provider call; until it is confirmed, the attempt holding it may have
    /// died before making that call. So an unconfirmed election never dedupes a
    /// later attempt — it is reclaimed — while the holder itself still sees its
    /// own election as its own, and a confirmed one suppresses for good.
    #[test]
    fn an_unconfirmed_election_is_reclaimed_by_the_next_attempt_not_treated_as_done() {
        let (_directory, mut journal) = created();
        let elected = journal.append(&election(1)).unwrap();
        assert!(!elected.payload["deduped"].as_bool().unwrap());
        // The electing attempt re-recording is still the holder, not a reclaim.
        let again = journal.append(&election(1)).unwrap();
        assert!(again.payload["deduped"].as_bool().unwrap());
        assert_eq!(journal.confirmed_effect_count().unwrap(), 0);

        // Attempt 1 died before its provider call. Attempt 2 reclaims.
        let reclaimed = journal.append(&election(2)).unwrap();
        assert!(
            !reclaimed.payload["deduped"].as_bool().unwrap(),
            "an election nobody confirmed must not suppress the provider call"
        );
        // Attempt 1 no longer holds it, so it cannot confirm what it lost.
        let stale = journal.append(&confirmation(1)).unwrap_err();
        assert!(stale.0.contains("does not hold the election"), "{stale:?}");

        journal.append(&confirmation(2)).unwrap();
        assert_eq!(journal.confirmed_effect_count().unwrap(), 1);
        let third = journal.append(&election(3)).unwrap();
        assert!(
            third.payload["deduped"].as_bool().unwrap(),
            "a confirmed election suppresses every later attempt"
        );
        assert_eq!(journal.effect_count().unwrap(), 1);
    }

    #[test]
    fn rollover_is_atomic_scaffolding_for_epoch_resume() {
        let (_directory, mut journal) = created();
        journal
            .append(&JournalEntry::new(
                EntryType::RunSpawned,
                "run",
                None,
                None,
                0,
                json!({}),
            ))
            .unwrap();
        let rolled = journal
            .rollover(
                EpochSummaryPayload {
                    epoch: 0,
                    prev_segment_id: 0,
                    journal_version: relayflowd_core::JOURNAL_VERSION,
                    steps_done: BTreeMap::new(),
                    steps_open: BTreeMap::new(),
                    open_waits: BTreeMap::new(),
                    stream_state: BTreeMap::new(),
                    pinned_revisions: BTreeMap::new(),
                    budget_spent: Budget::default(),
                },
                20,
            )
            .unwrap();
        assert_eq!(rolled[0].entry_type, EntryType::SegmentClosed);
        assert_eq!(rolled[1].entry_type, EntryType::EpochSummary);
        assert_eq!(journal.current_segment().unwrap(), 2);
        assert_eq!(journal.scan_segment(2).unwrap(), vec![rolled[1].clone()]);
    }
}
