//! Pragmas for every SQLite connection this crate opens.
//!
//! WAL is a persistent property of the file. `busy_timeout` and
//! `synchronous` are not: a connection that skips them fails at once
//! with `database is locked` the moment another connection holds a
//! write, which is what a short-lived registry open does on every
//! lease renewal.

use std::{thread, time::Duration};

use rusqlite::Connection;

/// How long a statement waits for another connection's lock.
///
/// Five seconds was not enough. A review fleet sharing one registry
/// (adversarial-review, context-review, ci) heartbeats that file from
/// many runs at once; on a host at load 20-60 the renewal `UPDATE`
/// gave up with `database is locked` and the step ended terminal.
/// Fifteen seconds covers a queue of fsyncs and still finishes inside
/// the client's 30s request timeout and the ~20s of slack on a 30s
/// lease, so a lock that truly never clears still fails the heartbeat
/// instead of hanging it.
pub(crate) const BUSY_TIMEOUT: Duration = Duration::from_secs(15);

/// Bounded retry for the WAL *switch* only. Not a general retry policy.
/// The handler is cleared for the duration: the switch does not consult
/// it today, and if a future SQLite did, an attempt-bounded loop with
/// the timeout armed would block attempts times `BUSY_TIMEOUT`.
/// `crash_resume`'s sigkill sweep opens the registry many times and that
/// product ran past 25 minutes on a GitHub runner (run 33960456965).
const WAL_SWITCH_RETRY_ATTEMPTS: usize = 50;
const WAL_SWITCH_RETRY_SLEEP: Duration = Duration::from_millis(2);

pub(crate) enum WalError {
    Sqlite(rusqlite::Error),
    NotWal(String),
}

impl From<rusqlite::Error> for WalError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

/// WAL plus [`BUSY_TIMEOUT`] plus `synchronous = FULL`.
///
/// The mode is queried, not assigned, when the file is already WAL.
/// `PRAGMA journal_mode = WAL` takes an exclusive lock and does not
/// invoke the busy handler. Measured on the registry: with the timeout
/// armed first, a racing open still failed 36 times in 50, and the
/// failing statement was `journal_mode` every time. The retry around
/// that switch is only about 100ms, so a steady-state open must not
/// take the lock again. Ordinary writes wait on `BUSY_TIMEOUT` instead.
pub(crate) fn ensure_wal(connection: &Connection) -> Result<(), WalError> {
    // Armed before the mode query so an ordinary lock (a checkpoint, a
    // short write) is waited out. The switch below clears it.
    connection.busy_timeout(BUSY_TIMEOUT)?;
    let mode: String = connection.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
    if !mode.eq_ignore_ascii_case("wal") {
        connection.busy_timeout(Duration::ZERO)?;
        let switched = switch_to_wal(connection)?;
        connection.busy_timeout(BUSY_TIMEOUT)?;
        if !switched.eq_ignore_ascii_case("wal") {
            return Err(WalError::NotWal(switched));
        }
    }
    connection.execute_batch("PRAGMA synchronous = FULL;")?;
    Ok(())
}

/// Read-only opens cannot switch journal mode. They still have to wait:
/// the default busy handler is off, so a checkpoint looks like a missing
/// database.
pub(crate) fn set_busy_timeout(connection: &Connection) -> Result<(), rusqlite::Error> {
    connection.busy_timeout(BUSY_TIMEOUT)
}

fn switch_to_wal(connection: &Connection) -> Result<String, rusqlite::Error> {
    let mut last = String::new();
    for attempt in 0..WAL_SWITCH_RETRY_ATTEMPTS {
        match connection.query_row("PRAGMA journal_mode = WAL", [], |row| {
            row.get::<_, String>(0)
        }) {
            Ok(observed) if observed.eq_ignore_ascii_case("wal") => return Ok(observed),
            Ok(observed) => last = observed,
            Err(error) => {
                if attempt + 1 == WAL_SWITCH_RETRY_ATTEMPTS {
                    return Err(error);
                }
            }
        }
        thread::sleep(WAL_SWITCH_RETRY_SLEEP);
    }
    Ok(last)
}
