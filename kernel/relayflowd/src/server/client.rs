//! The CLI side of the protocol: `relayflowd resume` hands the run to a live
//! `serve` when one is listening, so a single process owns the journal. Split
//! from `server.rs`, which is the serving half.

use std::{io, path::Path};

use anyhow::{Context, Result};
use serde_json::json;

#[cfg(unix)]
use super::Response;
use crate::Engine;

#[cfg(unix)]
pub fn resume_via_socket(data_dir: &Path, run_id: &str) -> Result<Option<crate::RunOutcome>> {
    use std::{
        io::{BufRead, BufReader, Write},
        os::unix::net::UnixStream,
    };

    let socket = data_dir.join("relayflowd.sock");
    if !socket.exists() {
        return Ok(None);
    }
    let mut connection = match UnixStream::connect(&socket) {
        Ok(connection) => connection,
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
            ) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error.into()),
    };
    serde_json::to_writer(
        &mut connection,
        &json!({"id": "cli-resume", "verb": "run.resume", "params": {"run_id": run_id}}),
    )?;
    connection.write_all(b"\n")?;
    connection.flush()?;
    for line in BufReader::new(connection).lines() {
        let response: Response = serde_json::from_str(&line?)?;
        if response.id != "cli-resume" {
            continue;
        }
        if !response.ok {
            let error = response.error.context("protocol error omitted detail")?;
            anyhow::bail!("{}: {}", error.code, error.message);
        }
        let outcome: crate::RunOutcome = serde_json::from_value(
            response
                .result
                .context("protocol response omitted result")?,
        )?;
        if outcome.status != crate::RunStatus::Parked {
            return Ok(Some(outcome));
        }
        let registry = relayflowd_journal::Registry::open(data_dir.join("relayflowd.sqlite3"))?;
        let initial_status = registry.lookup(run_id)?.map(|run| run.status);
        if matches!(initial_status.as_deref(), Some("completed" | "failed")) {
            return Ok(Some(Engine::new(data_dir).resume(run_id, None)?));
        }
        if initial_status.as_deref() != Some("waiting_worker") {
            return Ok(Some(outcome));
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while std::time::Instant::now() < deadline {
            let status = registry.lookup(run_id)?.map(|run| run.status);
            if matches!(status.as_deref(), Some("completed" | "failed")) {
                return Ok(Some(Engine::new(data_dir).resume(run_id, None)?));
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        anyhow::bail!("timed out waiting for out-of-band completion of run {run_id}")
    }
    anyhow::bail!("relayflowd serve closed before run.resume replied")
}

#[cfg(not(unix))]
pub fn resume_via_socket(_data_dir: &Path, _run_id: &str) -> Result<Option<crate::RunOutcome>> {
    Ok(None)
}
