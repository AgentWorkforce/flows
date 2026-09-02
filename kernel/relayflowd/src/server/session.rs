use std::{
    collections::BTreeMap,
    io::Write,
    os::unix::net::UnixStream,
    sync::{Arc, Mutex},
};

use anyhow::Result;
use relayflowd_core::{
    CompletionReason, EntryType, JournalEntry, Pins, StepCompletedPayload, StepType,
};
use serde_json::json;

use crate::worker::JournalObserver;

const LEASE_RENEWAL_MS: i64 = 30_000;

type Writer = Arc<Mutex<UnixStream>>;
type AssignmentKey = (String, String, u32);

mod assignments;
mod matching;

#[derive(Clone)]
struct Worker {
    connection_id: u64,
    worker_id: String,
    step_types: Vec<StepType>,
    capacity: usize,
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

#[derive(Clone)]
struct Reservation {
    connection_id: u64,
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
    reservations: BTreeMap<AssignmentKey, Reservation>,
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
        capacity: usize,
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
            capacity,
            pins,
            writer,
        });
    }

    /// Move the live projection only from an accepted, durable completion
    /// fact. Merged per surface because a completion speaks only for what it
    /// declared.
    fn advance_worker_pins(sessions: &mut Sessions, connection_id: u64, end_pins: &Pins) {
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
        sessions
            .reservations
            .retain(|_, reservation| reservation.connection_id != connection_id);
        keys.into_iter()
            .map(|(run_id, step_id, attempt)| AbandonedLease {
                run_id,
                step_id,
                attempt,
            })
            .collect()
    }
}

impl JournalObserver for ProtocolHub {
    fn appended(&self, entry: &JournalEntry) {
        let mut sessions = self.sessions.lock().expect("protocol sessions lock");
        // Capacity returns only after the completion is a durable journal
        // fact. This callback runs after append and before the driver elects
        // later runnable work, so a freed slot can be reused immediately.
        if entry.entry_type == EntryType::StepCompleted
            && let (Some(step_id), Some(attempt)) = (&entry.step_id, entry.attempt)
        {
            let key = (entry.run_id.clone(), step_id.clone(), attempt);
            let connection_id = sessions
                .assignments
                .get(&key)
                .map(|assignment| assignment.connection_id);
            let payload: StepCompletedPayload = serde_json::from_value(entry.payload.clone())
                .expect("kernel appended a valid step.completed payload");
            if let (Some(connection_id), Some(end_pins)) = (connection_id, payload.end_pins) {
                Self::advance_worker_pins(&mut sessions, connection_id, &end_pins);
            }
            sessions.assignments.remove(&key);
        }
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
    let mut frame = serde_json::to_vec(value)?;
    frame.push(b'\n');
    let mut writer = writer.lock().expect("protocol writer lock");
    writer.write_all(&frame)?;
    writer.flush()?;
    Ok(())
}

pub type SharedWriter = Writer;
