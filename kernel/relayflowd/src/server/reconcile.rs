//! Expiry reconciler: the sweep that turns a hung worker into a durable
//! `lease_expired` completion. Heartbeats renew a lease; when they stop past
//! its deadline — even with the socket still open — this sweep abandons the
//! attempt (journaled, `completionReason: lease_expired`), releases the
//! assignment, and re-drives the run so the step can be leased again. It also
//! retries abandonments whose journal append failed (fail closed: a dead
//! attempt is never silently dropped).

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    thread,
    time::Duration,
};

use relayflowd_core::CompletionReason;

use super::session::ProtocolHub;
use crate::Engine;
use crate::worker::LeaseProbe;

const SWEEP_INTERVAL_MS: u64 = 250;

pub(super) fn spawn_reconciler(data_dir: PathBuf, hub: Arc<ProtocolHub>) {
    thread::spawn(move || {
        loop {
            for run_id in reconcile_pass(&data_dir, &hub, super::now_ms()) {
                redrive(data_dir.clone(), hub.clone(), run_id);
            }
            thread::sleep(Duration::from_millis(SWEEP_INTERVAL_MS));
        }
    });
}

/// One sweep at `now_ms` (time is a parameter so tests can simulate a clock).
/// Returns the runs whose dead attempts were journaled this pass; the caller
/// re-drives them so their steps become leasable again.
pub(super) fn reconcile_pass(data_dir: &Path, hub: &Arc<ProtocolHub>, now_ms: i64) -> Vec<String> {
    let mut abandoned_runs = Vec::new();
    for lease in hub.expired_assignments(now_ms) {
        let lock = hub.run_lock(&lease.run_id);
        // A busy run keeps its assignment; the sweep retries next pass.
        let Ok(_guard) = lock.try_lock() else {
            continue;
        };
        // Re-check under the lock: a heartbeat may have renewed the lease.
        if hub.lease_active(&lease.run_id, &lease.step_id, lease.attempt, now_ms) {
            continue;
        }
        let key = (lease.run_id.clone(), lease.step_id.clone(), lease.attempt);
        match engine(data_dir, hub).abandon_out_of_band(
            &lease.run_id,
            &lease.step_id,
            lease.attempt,
            CompletionReason::LeaseExpired,
        ) {
            Ok(outcome) => {
                hub.finish(&key);
                if outcome.is_some() {
                    abandoned_runs.push(lease.run_id.clone());
                }
            }
            Err(error) => {
                // Fail closed: the assignment stays; this sweep repeats until
                // the journal records the expiry.
                eprintln!(
                    "relayflowd: error: failed to journal lease_expired for run {} step {} attempt {}: {error:#}; retrying next sweep",
                    lease.run_id, lease.step_id, lease.attempt
                );
            }
        }
    }
    for pending in hub.take_pending_abandonments() {
        let lock = hub.run_lock(&pending.lease.run_id);
        let _guard = lock.lock().expect("run lock");
        match engine(data_dir, hub).abandon_out_of_band(
            &pending.lease.run_id,
            &pending.lease.step_id,
            pending.lease.attempt,
            pending.reason,
        ) {
            Ok(Some(_)) => abandoned_runs.push(pending.lease.run_id.clone()),
            // Already resolved elsewhere: the journal has its completion.
            Ok(None) => {}
            Err(error) => {
                eprintln!(
                    "relayflowd: error: retried abandonment still failing for run {} step {} attempt {}: {error:#}; retained",
                    pending.lease.run_id, pending.lease.step_id, pending.lease.attempt
                );
                hub.queue_abandonment(pending.lease, pending.reason);
            }
        }
    }
    abandoned_runs
}

/// Re-drive a run whose attempt was abandoned so the step is leased again.
/// Runs detached: the drive may sleep through the retry backoff.
fn redrive(data_dir: PathBuf, hub: Arc<ProtocolHub>, run_id: String) {
    thread::spawn(move || {
        let lock = hub.run_lock(&run_id);
        let _guard = lock.lock().expect("run lock");
        if let Err(error) = engine(&data_dir, &hub).resume_live(&run_id, hub.as_ref()) {
            eprintln!(
                "relayflowd: error: failed to re-drive run {run_id} after abandonment: {error:#}"
            );
        }
    });
}

fn engine(data_dir: &Path, hub: &Arc<ProtocolHub>) -> Engine {
    let dispatcher: Arc<dyn crate::worker::StepDispatcher> = hub.clone();
    let observer: Arc<dyn crate::worker::JournalObserver> = hub.clone();
    Engine::with_runtime(data_dir, dispatcher, observer)
}
