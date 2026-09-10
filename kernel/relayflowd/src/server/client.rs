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
fn lifecycle_request_via_socket(
    data_dir: &Path,
    request_id: &str,
    verb: &str,
    run_id: &str,
) -> Result<Option<crate::RunOutcome>> {
    use std::{
        io::{BufRead, BufReader, Write},
        os::unix::net::UnixStream,
    };
    let socket = crate::socket_path::derive_socket_path(data_dir)?;
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
        &json!({"id": request_id, "verb": verb, "params": {"run_id": run_id}}),
    )?;
    connection.write_all(b"\n")?;
    connection.flush()?;
    for line in BufReader::new(connection).lines() {
        let response: Response = serde_json::from_str(&line?)?;
        if response.id != request_id {
            continue;
        }
        if !response.ok {
            let error = response.error.context("protocol error omitted detail")?;
            anyhow::bail!("{}: {}", error.code, error.message);
        }
        return Ok(Some(serde_json::from_value(
            response
                .result
                .context("protocol response omitted result")?,
        )?));
    }
    anyhow::bail!("relayflowd serve closed before {verb} replied")
}

/// How long after a lease deadline the CLI still waits before calling the
/// attempt dead. The reconciler sweeps expired leases and journals their
/// completion; this covers the gap between the deadline passing and that sweep
/// landing, so a healthy handover is never mistaken for a dead worker.
const LEASE_SWEEP_GRACE_MS: i64 = 5_000;

/// One reading of the run registry while an out-of-band attempt is in flight.
/// The wait is governed by the attempt's heartbeat-renewed lease, not by a
/// wall-clock limit of the CLI's own: an agent attempt may legitimately run for
/// hours, and a fixed deadline would fail a run that is perfectly healthy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResumeWait {
    /// Terminal status: fold the journal and report the outcome.
    Finished,
    /// The run is no longer waiting on a worker; report what `run.resume` said.
    NotWaiting,
    /// A worker holds a live lease. The attempt is healthy — keep waiting.
    KeepWaiting,
    /// The lease deadline has passed (plus the sweep grace) with no renewal, or
    /// the registry records no deadline at all. Fail closed with a declared
    /// reason rather than waiting on a lease nothing is renewing.
    LeaseExpired,
}

pub(crate) fn resume_wait(
    status: Option<&str>,
    lease_deadline_ms: Option<i64>,
    now_ms: i64,
) -> ResumeWait {
    match status {
        Some("completed" | "failed") => ResumeWait::Finished,
        Some("waiting_worker") => match lease_deadline_ms {
            Some(deadline_ms) if now_ms < deadline_ms.saturating_add(LEASE_SWEEP_GRACE_MS) => {
                ResumeWait::KeepWaiting
            }
            _ => ResumeWait::LeaseExpired,
        },
        _ => ResumeWait::NotWaiting,
    }
}

#[cfg(unix)]
pub fn resume_via_socket(data_dir: &Path, run_id: &str) -> Result<Option<crate::RunOutcome>> {
    use std::{
        io::{BufRead, BufReader, Write},
        os::unix::net::UnixStream,
    };

    let socket = crate::socket_path::derive_socket_path(data_dir)?;
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
        return wait_for_out_of_band_completion(data_dir, run_id, &registry, outcome);
    }
    anyhow::bail!("relayflowd serve closed before run.resume replied")
}

#[cfg(unix)]
pub fn cancel_via_socket(data_dir: &Path, run_id: &str) -> Result<Option<crate::RunOutcome>> {
    lifecycle_request_via_socket(data_dir, "cli-cancel", "run.cancel", run_id)
}

/// Wait out an attempt a worker is running out of band. The loop follows the
/// lease: while the worker keeps renewing it the attempt is alive however long
/// it takes, and the wait ends when the run reaches a terminal state, leaves
/// `waiting_worker`, or the lease genuinely expires.
#[cfg(unix)]
fn wait_for_out_of_band_completion(
    data_dir: &Path,
    run_id: &str,
    registry: &relayflowd_journal::Registry,
    outcome: crate::RunOutcome,
) -> Result<Option<crate::RunOutcome>> {
    loop {
        let record = registry.lookup(run_id)?;
        let status = record.as_ref().map(|run| run.status.as_str());
        let lease_deadline_ms = record.as_ref().and_then(|run| run.next_wake_at_ms);
        match resume_wait(status, lease_deadline_ms, super::now_ms()) {
            ResumeWait::Finished => return Ok(Some(Engine::new(data_dir).resume(run_id, None)?)),
            ResumeWait::NotWaiting => return Ok(Some(outcome)),
            ResumeWait::KeepWaiting => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            ResumeWait::LeaseExpired => anyhow::bail!(
                "lease for run {run_id} expired without an out-of-band completion \
                 (deadline {lease_deadline_ms:?})"
            ),
        }
    }
}

#[cfg(not(unix))]
pub fn resume_via_socket(_data_dir: &Path, _run_id: &str) -> Result<Option<crate::RunOutcome>> {
    Ok(None)
}

#[cfg(not(unix))]
pub fn cancel_via_socket(_data_dir: &Path, _run_id: &str) -> Result<Option<crate::RunOutcome>> {
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A worker renewing its lease keeps the CLI waiting for as long as the
    /// attempt runs. The old fixed 30s deadline failed every healthy agent
    /// attempt longer than that; the lease, not the clock, decides.
    #[test]
    fn resume_waits_while_the_heartbeat_renewed_lease_is_live() {
        // Ten minutes into the attempt — twenty times the old fixed deadline —
        // with a lease the worker renewed 30s out.
        let now_ms = 600_000;
        assert_eq!(
            resume_wait(Some("waiting_worker"), Some(now_ms + 30_000), now_ms),
            ResumeWait::KeepWaiting
        );
        // Still waiting the instant before the deadline plus the sweep grace.
        assert_eq!(
            resume_wait(
                Some("waiting_worker"),
                Some(now_ms - LEASE_SWEEP_GRACE_MS + 1),
                now_ms
            ),
            ResumeWait::KeepWaiting
        );
        // Only a lease nothing renewed ends the wait, and it ends declared.
        assert_eq!(
            resume_wait(
                Some("waiting_worker"),
                Some(now_ms - LEASE_SWEEP_GRACE_MS),
                now_ms
            ),
            ResumeWait::LeaseExpired
        );
        // A waiting_worker row with no deadline records no live lease: fail
        // closed rather than wait on nothing.
        assert_eq!(
            resume_wait(Some("waiting_worker"), None, now_ms),
            ResumeWait::LeaseExpired
        );
        // Terminal and non-waiting states are answered immediately.
        assert_eq!(
            resume_wait(Some("completed"), None, now_ms),
            ResumeWait::Finished
        );
        assert_eq!(
            resume_wait(Some("failed"), None, now_ms),
            ResumeWait::Finished
        );
        assert_eq!(
            resume_wait(Some("parked"), None, now_ms),
            ResumeWait::NotWaiting
        );
        assert_eq!(resume_wait(None, None, now_ms), ResumeWait::NotWaiting);
    }
}
