use std::{
    collections::BTreeMap,
    io::Write,
    os::unix::net::UnixStream,
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result, bail};
use relayflowd_core::{JournalEntry, StepType};
use serde_json::json;

use crate::worker::{JournalObserver, StepDispatch, StepDispatcher};

const LEASE_RENEWAL_MS: i64 = 30_000;

type Writer = Arc<Mutex<UnixStream>>;
type AssignmentKey = (String, String, u32);

#[derive(Clone)]
struct Worker {
    connection_id: u64,
    worker_id: String,
    step_types: Vec<StepType>,
    writer: Writer,
}

#[derive(Clone)]
struct Watcher {
    connection_id: u64,
    writer: Writer,
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

#[derive(Default)]
struct Sessions {
    workers: Vec<Worker>,
    watchers: BTreeMap<String, Vec<Watcher>>,
    assignments: BTreeMap<AssignmentKey, Assignment>,
}

#[derive(Default)]
pub struct ProtocolHub {
    sessions: Mutex<Sessions>,
}

impl ProtocolHub {
    pub fn attach_worker(
        &self,
        connection_id: u64,
        worker_id: String,
        step_types: Vec<StepType>,
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
            writer,
        });
    }

    pub fn watch(&self, connection_id: u64, run_id: String, writer: Writer) {
        let mut sessions = self.sessions.lock().expect("protocol sessions lock");
        let watchers = sessions.watchers.entry(run_id).or_default();
        watchers.retain(|watcher| watcher.connection_id != connection_id);
        watchers.push(Watcher {
            connection_id,
            writer,
        });
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

    fn dispatch(&self, dispatch: StepDispatch) -> Result<bool> {
        let mut sessions = self.sessions.lock().expect("protocol sessions lock");
        let Some(worker) = sessions
            .workers
            .iter()
            .find(|worker| worker.step_types.contains(&dispatch.step_type))
            .cloned()
        else {
            return Ok(false);
        };
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
        Ok(true)
    }
}

impl JournalObserver for ProtocolHub {
    fn appended(&self, entry: &JournalEntry) {
        let mut sessions = self.sessions.lock().expect("protocol sessions lock");
        let Some(watchers) = sessions.watchers.get_mut(&entry.run_id) else {
            return;
        };
        let frame = json!({"event": "entry", "data": entry});
        watchers.retain(|watcher| write_frame(&watcher.writer, &frame).is_ok());
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
