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
             ) WITHOUT ROWID;",
        )?;
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
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn registry_is_a_rebuildable_run_locator() {
        let directory = tempdir().unwrap();
        let registry = Registry::open(directory.path().join("relayflowd.sqlite3")).unwrap();
        let run_file = directory.path().join("runs/run.sqlite3");
        registry.register("run", &run_file).unwrap();
        registry.set_status("run", "completed", None).unwrap();
        let record = registry.lookup("run").unwrap().unwrap();
        assert_eq!(record.file, run_file);
        assert_eq!(record.status, "completed");
    }
}
