use std::{
    collections::BTreeMap,
    io::Write,
    os::unix::net::UnixStream,
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result, bail};
use relayflowd_core::{CompletionReason, JournalEntry, Pins, StepKind, StepSpec, StepType};
use serde_json::json;

use crate::worker::{DispatchOutcome, JournalObserver, LeaseProbe, StepDispatch, StepDispatcher};

const LEASE_RENEWAL_MS: i64 = 30_000;

type Writer = Arc<Mutex<UnixStream>>;
type AssignmentKey = (String, String, u32);

mod matching;
use matching::{pin_value_mismatch, select_worker, worker_holds};

#[derive(Clone)]
struct Worker {
    connection_id: u64,
    worker_id: String,
    step_types: Vec<StepType>,
    pins: Pins,
    writer: Writer,
}

/// A watcher starts in replay mode: live appends are buffered (keyed by
/// journal seq) until the registrant has replayed the snapshot and reports the
/// sequence cursor it replayed through. Buffered entries at or below that
/// cursor were already replayed and are dropped; the rest flush in order.
/// Registration-before-replay plus this dedupe closes the gap where an entry
/// appended between snapshot and registration was missed forever.
enum WatchDelivery {
    Replaying {
        buffered: Vec<(i64, serde_json::Value)>,
    },
    Live,
}

struct Watcher {
    connection_id: u64,
    writer: Writer,
    delivery: WatchDelivery,
}

#[derive(Clone)]
struct Assignment {
    connection_id: u64,
    worker_id: String,
    lease_id: String,
    lease_deadline_ms: i64,
}

#[derive(Debug, Clone)]
pub struct AbandonedLease {
    pub run_id: String,
    pub step_id: String,
    pub attempt: u32,
}

/// A dead attempt whose completion could not be journaled yet. Fail closed:
/// it is retained here and retried by the reconciler until the journal
/// records it — never silently dropped.
#[derive(Debug, Clone)]
pub struct PendingAbandonment {
    pub lease: AbandonedLease,
    pub reason: CompletionReason,
}

#[derive(Default)]
struct Sessions {
    workers: Vec<Worker>,
    watchers: BTreeMap<String, Vec<Watcher>>,
    assignments: BTreeMap<AssignmentKey, Assignment>,
}

#[derive(Default)]
pub struct ProtocolHub {
    sessions: Mutex<Sessions>,
    /// Per-run write serialization: every mutating verb for a run (resume,
    /// out-of-band completion, abandonment, stream append, event emit) holds
    /// this lock across its load-state -> decide -> append sequence, so the
    /// scheduling decision is atomic and a step can never be double-dispatched.
    run_locks: Mutex<BTreeMap<String, Arc<Mutex<()>>>>,
    pending_abandonments: Mutex<Vec<PendingAbandonment>>,
}

impl ProtocolHub {
    pub fn run_lock(&self, run_id: &str) -> Arc<Mutex<()>> {
        self.run_locks
            .lock()
            .expect("run locks lock")
            .entry(run_id.to_owned())
            .or_default()
            .clone()
    }

    pub fn attach_worker(
        &self,
        connection_id: u64,
        worker_id: String,
        step_types: Vec<StepType>,
        pins: Pins,
        writer: Writer,
    ) {
        let mut sessions = self.sessions.lock().expect("protocol sessions lock");
        sessions
            .workers
            .retain(|worker| worker.connection_id != connection_id);
        sessions.workers.push(Worker {
            connection_id,
            worker_id,
            step_types,
            pins,
            writer,
        });
    }

    /// A worker's advertised state is only true until it changes it. A step it
    /// completes moves the surfaces that completion pins, so the hub's view
    /// must move with it — otherwise the next attempt's pins, chained from
    /// those very end pins, would read as a mismatch against a stale snapshot.
    /// Merged per surface: a completion speaks only for what it declared.
    pub fn advance_worker_pins(&self, connection_id: u64, end_pins: &Pins) {
        let mut sessions = self.sessions.lock().expect("protocol sessions lock");
        let Some(worker) = sessions
            .workers
            .iter_mut()
            .find(|worker| worker.connection_id == connection_id)
        else {
            return;
        };
        for pin in &end_pins.workspace {
            match worker
                .pins
                .workspace
                .iter_mut()
                .find(|held| held.surface == pin.surface)
            {
                Some(held) => held.revision_id = pin.revision_id.clone(),
                None => worker.pins.workspace.push(pin.clone()),
            }
        }
        for pin in &end_pins.streams {
            match worker
                .pins
                .streams
                .iter_mut()
                .find(|held| held.stream == pin.stream)
            {
                Some(held) => held.read_offset = pin.read_offset,
                None => worker.pins.streams.push(pin.clone()),
            }
        }
    }

    /// Register a watcher BEFORE its journal replay. Live appends buffer until
    /// `watch_ready` supplies the replayed-through cursor.
    pub fn watch(&self, connection_id: u64, run_id: String, writer: Writer) {
        let mut sessions = self.sessions.lock().expect("protocol sessions lock");
        let watchers = sessions.watchers.entry(run_id).or_default();
        watchers.retain(|watcher| watcher.connection_id != connection_id);
        watchers.push(Watcher {
            connection_id,
            writer,
            delivery: WatchDelivery::Replaying {
                buffered: Vec::new(),
            },
        });
    }

    /// Flush entries buffered during replay (deduped against the replay
    /// cursor) and switch the watcher live.
    pub fn watch_ready(&self, connection_id: u64, run_id: &str, replayed_through_seq: i64) {
        let mut sessions = self.sessions.lock().expect("protocol sessions lock");
        let Some(watchers) = sessions.watchers.get_mut(run_id) else {
            return;
        };
        watchers.retain_mut(|watcher| {
            if watcher.connection_id != connection_id {
                return true;
            }
            let buffered = match std::mem::replace(&mut watcher.delivery, WatchDelivery::Live) {
                WatchDelivery::Replaying { buffered } => buffered,
                WatchDelivery::Live => return true,
            };
            for (seq, frame) in buffered {
                if seq <= replayed_through_seq {
                    continue;
                }
                if write_frame(&watcher.writer, &frame).is_err() {
                    return false;
                }
            }
            true
        });
    }

    /// Drop a watcher whose replay failed before it went live.
    pub fn unwatch(&self, connection_id: u64, run_id: &str) {
        let mut sessions = self.sessions.lock().expect("protocol sessions lock");
        if let Some(watchers) = sessions.watchers.get_mut(run_id) {
            watchers.retain(|watcher| watcher.connection_id != connection_id);
        }
    }

    pub fn heartbeat(
        &self,
        connection_id: u64,
        key: &AssignmentKey,
        lease_id: &str,
        now_ms: i64,
    ) -> Result<i64> {
        let mut sessions = self.sessions.lock().expect("protocol sessions lock");
        let assignment = sessions
            .assignments
            .get_mut(key)
            .context("attempt has no active worker lease")?;
        if assignment.connection_id != connection_id || assignment.lease_id != lease_id {
            bail!("heartbeat does not match the active worker lease")
        }
        assignment.lease_deadline_ms = now_ms.saturating_add(LEASE_RENEWAL_MS);
        Ok(assignment.lease_deadline_ms)
    }

    pub fn completion_worker(&self, connection_id: u64, key: &AssignmentKey) -> Result<String> {
        let sessions = self.sessions.lock().expect("protocol sessions lock");
        let assignment = sessions
            .assignments
            .get(key)
            .context("attempt has no active worker lease")?;
        if assignment.connection_id != connection_id {
            bail!("completion came from a worker that does not hold the lease")
        }
        Ok(assignment.worker_id.clone())
    }

    pub fn finish(&self, key: &AssignmentKey) {
        self.sessions
            .lock()
            .expect("protocol sessions lock")
            .assignments
            .remove(key);
    }

    /// Assignments whose (heartbeat-renewed) lease deadline has passed. The
    /// worker may still hold an open socket — a hung worker is exactly the
    /// case the expiry reconciler exists for. Assignments are NOT removed
    /// here; they are released via `finish` only once the abandonment is
    /// durably journaled, so a failed journal write is retried next sweep.
    pub fn expired_assignments(&self, now_ms: i64) -> Vec<AbandonedLease> {
        self.sessions
            .lock()
            .expect("protocol sessions lock")
            .assignments
            .iter()
            .filter(|(_, assignment)| now_ms >= assignment.lease_deadline_ms)
            .map(|((run_id, step_id, attempt), _)| AbandonedLease {
                run_id: run_id.clone(),
                step_id: step_id.clone(),
                attempt: *attempt,
            })
            .collect()
    }

    /// Retain an abandonment whose journal append failed, for reconciler retry.
    pub fn queue_abandonment(&self, lease: AbandonedLease, reason: CompletionReason) {
        self.pending_abandonments
            .lock()
            .expect("pending abandonments lock")
            .push(PendingAbandonment { lease, reason });
    }

    /// Drain the retry queue; the reconciler re-queues what still fails.
    pub fn take_pending_abandonments(&self) -> Vec<PendingAbandonment> {
        std::mem::take(
            &mut *self
                .pending_abandonments
                .lock()
                .expect("pending abandonments lock"),
        )
    }

    pub fn detach(&self, connection_id: u64) -> Vec<AbandonedLease> {
        let mut sessions = self.sessions.lock().expect("protocol sessions lock");
        sessions
            .workers
            .retain(|worker| worker.connection_id != connection_id);
        for watchers in sessions.watchers.values_mut() {
            watchers.retain(|watcher| watcher.connection_id != connection_id);
        }
        let keys = sessions
            .assignments
            .iter()
            .filter_map(|(key, assignment)| {
                (assignment.connection_id == connection_id).then_some(key.clone())
            })
            .collect::<Vec<_>>();
        for key in &keys {
            sessions.assignments.remove(key);
        }
        keys.into_iter()
            .map(|(run_id, step_id, attempt)| AbandonedLease {
                run_id,
                step_id,
                attempt,
            })
            .collect()
    }
}

impl StepDispatcher for ProtocolHub {
    fn executor(&self, step_type: StepType) -> Option<String> {
        self.sessions
            .lock()
            .expect("protocol sessions lock")
            .workers
            .iter()
            .find(|worker| worker.step_types.contains(&step_type))
            .map(|worker| worker.worker_id.clone())
    }

    fn available(&self, step_type: StepType) -> bool {
        self.executor(step_type).is_some()
    }

    fn starting_pins(&self, step: &StepSpec) -> Result<Pins> {
        let sessions = self.sessions.lock().expect("protocol sessions lock");
        // Same selection rule as `dispatch` — the first worker handling the
        // class — so the pins journaled at start belong to the worker that
        // receives the attempt. `dispatch` re-checks the worker id it resolved
        // against the pin source and declines rather than dispatching to a
        // worker whose starting state was never journaled.
        let worker =
            select_worker(&sessions, StepType::Agent).context("no agent worker is attached")?;
        let StepKind::Agent { surfaces, .. } = &step.kind else {
            return Ok(Pins::default());
        };
        let workspace = surfaces
            .workspace
            .iter()
            .map(|surface| {
                worker
                    .pins
                    .workspace
                    .iter()
                    .find(|pin| pin.surface == surface.surface)
                    .cloned()
                    .with_context(|| {
                        format!(
                            "worker {} omitted revision for surface {}",
                            worker.worker_id, surface.surface
                        )
                    })
            })
            .collect::<Result<Vec<_>>>()?;
        let streams = surfaces
            .streams
            .iter()
            .map(|surface| {
                worker
                    .pins
                    .streams
                    .iter()
                    .find(|pin| pin.stream == surface.stream)
                    .cloned()
                    .with_context(|| {
                        format!(
                            "worker {} omitted read offset for stream {}",
                            worker.worker_id, surface.stream
                        )
                    })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Pins { workspace, streams })
    }

    fn dispatch(&self, dispatch: StepDispatch) -> Result<DispatchOutcome> {
        let mut sessions = self.sessions.lock().expect("protocol sessions lock");
        let Some(worker) = select_worker(&sessions, dispatch.step_type).cloned() else {
            return Ok(DispatchOutcome::NoWorker);
        };
        // Appendix A rule 2: the pins journaled at start are the state this
        // attempt must begin from, and they were sourced from whichever worker
        // `select_worker` returned then. If a detach or a second attachment has
        // changed that answer, the worker now selected may never have reported
        // those surfaces — dispatching would hand it a starting state it cannot
        // honor. Decline instead; the run parks and re-dispatches from pins the
        // holding worker actually reported.
        if !worker_holds(&worker, &dispatch.pins) {
            return Ok(DispatchOutcome::NoWorker);
        }
        // Holding the surface *names* is not holding the state. Unless this
        // dispatch is itself the instruction to move (a `reset` retry carries
        // `restore_pins`), the worker must already be at the exact revisions
        // and offsets the attempt was elected against; a replacement standing
        // at different ones would start from unjournaled state.
        if let Some(detail) = pin_value_mismatch(&worker, &dispatch) {
            return Ok(DispatchOutcome::PinMismatch { detail });
        }
        write_frame(
            &worker.writer,
            &json!({"event": "step.dispatch", "data": dispatch}),
        )
        .with_context(|| format!("dispatch step to worker {}", worker.worker_id))?;
        let key = (
            dispatch.run_id.clone(),
            dispatch.step_id.clone(),
            dispatch.attempt,
        );
        sessions.assignments.insert(
            key,
            Assignment {
                connection_id: worker.connection_id,
                worker_id: worker.worker_id,
                lease_id: dispatch.lease_id,
                lease_deadline_ms: dispatch.lease_deadline_ms,
            },
        );
        Ok(DispatchOutcome::Dispatched)
    }
}

impl LeaseProbe for ProtocolHub {
    fn lease_active(&self, run_id: &str, step_id: &str, attempt: u32, now_ms: i64) -> bool {
        let key = (run_id.to_owned(), step_id.to_owned(), attempt);
        self.sessions
            .lock()
            .expect("protocol sessions lock")
            .assignments
            .get(&key)
            .is_some_and(|assignment| now_ms < assignment.lease_deadline_ms)
    }
}

impl JournalObserver for ProtocolHub {
    fn appended(&self, entry: &JournalEntry) {
        let mut sessions = self.sessions.lock().expect("protocol sessions lock");
        let Some(watchers) = sessions.watchers.get_mut(&entry.run_id) else {
            return;
        };
        let frame = json!({"event": "entry", "data": entry});
        watchers.retain_mut(|watcher| match &mut watcher.delivery {
            WatchDelivery::Replaying { buffered } => {
                buffered.push((entry.seq, frame.clone()));
                true
            }
            WatchDelivery::Live => write_frame(&watcher.writer, &frame).is_ok(),
        });
    }
}

pub fn write_frame(writer: &Writer, value: &impl serde::Serialize) -> Result<()> {
    let mut writer = writer.lock().expect("protocol writer lock");
    serde_json::to_writer(&mut *writer, value)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

pub type SharedWriter = Writer;
