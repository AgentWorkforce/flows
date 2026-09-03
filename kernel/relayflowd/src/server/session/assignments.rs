//! Capacity reservations, deterministic placement, leases, and dispatch.

use anyhow::{Context, Result, bail};
use relayflowd_core::{Pins, StepKind, StepSpec, StepType, workspace_surfaces_equal};
use serde_json::json;

use super::{
    AbandonedLease, Assignment, AssignmentKey, LEASE_RENEWAL_MS, ProtocolHub, Reservation,
    matching::{pin_value_mismatch, select_worker, select_worker_for_step, worker_holds},
    write_frame,
};
use crate::worker::{DispatchOutcome, LeaseProbe, StepDispatch, StepDispatcher};

impl ProtocolHub {
    pub fn heartbeat(
        &self,
        connection_id: u64,
        key: &AssignmentKey,
        lease_id: &str,
        now_ms: i64,
    ) -> Result<(i64, i64)> {
        let mut sessions = self.sessions.lock().expect("protocol sessions lock");
        let assignment_deadline = {
            let assignment = sessions
                .assignments
                .get_mut(key)
                .context("attempt has no active worker lease")?;
            if assignment.connection_id != connection_id || assignment.lease_id != lease_id {
                bail!("heartbeat does not match the active worker lease")
            }
            assignment.lease_deadline_ms = now_ms.saturating_add(LEASE_RENEWAL_MS);
            assignment.lease_deadline_ms
        };
        let run_deadline = sessions
            .assignments
            .iter()
            .filter(|((run_id, _, _), _)| run_id == &key.0)
            .map(|(_, assignment)| assignment.lease_deadline_ms)
            .min()
            .expect("the renewed assignment is still present");
        Ok((assignment_deadline, run_deadline))
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

    pub fn earliest_lease_deadline(&self, run_id: &str) -> Option<i64> {
        let sessions = self.sessions.lock().expect("protocol sessions lock");
        sessions
            .assignments
            .iter()
            .filter(|((assigned_run, _, _), assignment)| {
                assigned_run == run_id
                    && sessions
                        .workers
                        .iter()
                        .any(|worker| worker.connection_id == assignment.connection_id)
            })
            .map(|(_, assignment)| assignment.lease_deadline_ms)
            .min()
    }

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
}

impl StepDispatcher for ProtocolHub {
    fn executor(&self, step_type: StepType) -> Option<String> {
        let sessions = self.sessions.lock().expect("protocol sessions lock");
        select_worker(&sessions, step_type).map(|worker| worker.worker_id.clone())
    }

    fn available(&self, step_type: StepType) -> bool {
        self.executor(step_type).is_some()
    }

    fn reserve_dispatch(
        &self,
        run_id: &str,
        step: &StepSpec,
        attempt: u32,
        required_pins: &Pins,
    ) -> Result<bool> {
        let mut sessions = self.sessions.lock().expect("protocol sessions lock");
        let key = (run_id.to_owned(), step.id.clone(), attempt);
        if sessions.reservations.contains_key(&key) {
            return Ok(true);
        }
        let Some(connection_id) = select_worker_for_step(&sessions, step, required_pins)
            .map(|worker| worker.connection_id)
        else {
            return Ok(false);
        };
        sessions
            .reservations
            .insert(key, Reservation { connection_id });
        Ok(true)
    }

    fn reserved_executor(&self, run_id: &str, step: &StepSpec, attempt: u32) -> Option<String> {
        let sessions = self.sessions.lock().expect("protocol sessions lock");
        let reservation =
            sessions
                .reservations
                .get(&(run_id.to_owned(), step.id.clone(), attempt))?;
        sessions
            .workers
            .iter()
            .find(|worker| worker.connection_id == reservation.connection_id)
            .map(|worker| worker.worker_id.clone())
    }

    fn reserved_starting_pins(&self, run_id: &str, step: &StepSpec, attempt: u32) -> Result<Pins> {
        let sessions = self.sessions.lock().expect("protocol sessions lock");
        let reservation = sessions
            .reservations
            .get(&(run_id.to_owned(), step.id.clone(), attempt))
            .context("dispatch has no worker reservation")?;
        let worker = sessions
            .workers
            .iter()
            .find(|worker| worker.connection_id == reservation.connection_id)
            .context("reserved worker detached before start pins were journaled")?;
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
                    .find(|pin| workspace_surfaces_equal(&pin.surface, &surface.surface))
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

    fn release_dispatch_reservation(&self, run_id: &str, step_id: &str, attempt: u32) {
        self.sessions
            .lock()
            .expect("protocol sessions lock")
            .reservations
            .remove(&(run_id.to_owned(), step_id.to_owned(), attempt));
    }

    fn dispatch(&self, dispatch: StepDispatch) -> Result<DispatchOutcome> {
        let mut sessions = self.sessions.lock().expect("protocol sessions lock");
        let key = (
            dispatch.run_id.clone(),
            dispatch.step_id.clone(),
            dispatch.attempt,
        );
        let Some(connection_id) = sessions
            .reservations
            .get(&key)
            .map(|reservation| reservation.connection_id)
        else {
            return Ok(DispatchOutcome::NoWorker);
        };
        let Some(worker) = sessions
            .workers
            .iter()
            .find(|worker| worker.connection_id == connection_id)
            .cloned()
        else {
            sessions.reservations.remove(&key);
            return Ok(DispatchOutcome::NoWorker);
        };
        if !worker_holds(&worker, &dispatch.pins) {
            sessions.reservations.remove(&key);
            return Ok(DispatchOutcome::NoWorker);
        }
        if let Some(detail) = pin_value_mismatch(&worker, &dispatch) {
            sessions.reservations.remove(&key);
            return Ok(DispatchOutcome::PinMismatch { detail });
        }
        if let Err(error) = write_frame(
            &worker.writer,
            &json!({"event": "step.dispatch", "data": dispatch}),
        )
        .with_context(|| format!("dispatch step to worker {}", worker.worker_id))
        {
            sessions.reservations.remove(&key);
            return Err(error);
        }
        sessions.reservations.remove(&key);
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

    fn active_lease_deadline(&self, run_id: &str, step_id: &str, attempt: u32) -> Option<i64> {
        let sessions = self.sessions.lock().expect("protocol sessions lock");
        let assignment =
            sessions
                .assignments
                .get(&(run_id.to_owned(), step_id.to_owned(), attempt))?;
        sessions
            .workers
            .iter()
            .any(|worker| worker.connection_id == assignment.connection_id)
            .then_some(assignment.lease_deadline_ms)
    }
}

impl LeaseProbe for ProtocolHub {
    fn lease_active(&self, run_id: &str, step_id: &str, attempt: u32, now_ms: i64) -> bool {
        let key = (run_id.to_owned(), step_id.to_owned(), attempt);
        let sessions = self.sessions.lock().expect("protocol sessions lock");
        sessions.assignments.get(&key).is_some_and(|assignment| {
            now_ms < assignment.lease_deadline_ms
                && sessions
                    .workers
                    .iter()
                    .any(|worker| worker.connection_id == assignment.connection_id)
        })
    }
}
