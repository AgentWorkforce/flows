//! Which attached worker may receive an attempt, and whether it stands where
//! the attempt is pinned. Split from `session.rs` so worker selection and
//! Appendix A rule 2's starting-state check read as their own subject.

use std::cmp::Ordering;

use relayflowd_core::{Pins, StepKind, StepSpec, StepType, workspace_surfaces_equal};

use super::{Sessions, Worker};
use crate::worker::StepDispatch;

/// Deterministic least-loaded selection. Capacity is counted across both
/// journal-pending reservations and live assignments, so admission happens
/// before a durable start and concurrent runs cannot overbook a worker.
pub(super) fn select_worker(sessions: &Sessions, step_type: StepType) -> Option<&Worker> {
    sessions
        .workers
        .iter()
        .filter(|worker| worker.step_types.contains(&step_type))
        .filter_map(|worker| {
            let load = worker_load(sessions, worker.connection_id);
            (load < worker.capacity).then_some((worker, load))
        })
        .min_by(|(left, left_load), (right, right_load)| {
            normalized_load_order(*left_load, left.capacity, *right_load, right.capacity)
        })
        .map(|(worker, _)| worker)
}

pub(super) fn select_worker_for_step<'a>(
    sessions: &'a Sessions,
    step: &StepSpec,
    required_pins: &Pins,
) -> Option<&'a Worker> {
    sessions
        .workers
        .iter()
        .filter(|worker| worker.step_types.contains(&step.step_type()))
        .filter(|worker| worker_can_pin(worker, step, required_pins))
        .filter_map(|worker| {
            let load = worker_load(sessions, worker.connection_id);
            (load < worker.capacity).then_some((worker, load))
        })
        .min_by(|(left, left_load), (right, right_load)| {
            normalized_load_order(*left_load, left.capacity, *right_load, right.capacity)
        })
        .map(|(worker, _)| worker)
}

fn worker_load(sessions: &Sessions, connection_id: u64) -> usize {
    sessions
        .assignments
        .values()
        .filter(|assignment| assignment.connection_id == connection_id)
        .count()
        + sessions
            .reservations
            .values()
            .filter(|reservation| reservation.connection_id == connection_id)
            .count()
}

fn normalized_load_order(
    left_load: usize,
    left_capacity: usize,
    right_load: usize,
    right_capacity: usize,
) -> Ordering {
    (left_load as u128 * right_capacity as u128).cmp(&(right_load as u128 * left_capacity as u128))
}

fn worker_can_pin(worker: &Worker, step: &StepSpec, required_pins: &Pins) -> bool {
    if !worker_holds(worker, required_pins) {
        return false;
    }
    let StepKind::Agent { surfaces, .. } = &step.kind else {
        return true;
    };
    surfaces.workspace.iter().all(|declared| {
        worker
            .pins
            .workspace
            .iter()
            .any(|held| workspace_surfaces_equal(&held.surface, &declared.surface))
    }) && surfaces.streams.iter().all(|declared| {
        worker
            .pins
            .streams
            .iter()
            .any(|held| held.stream == declared.stream)
    })
}

/// Which pinned values does the selected worker not stand at? `None` when the
/// worker's reported state matches the attempt's pins, or when the dispatch
/// tells the worker to restore to them (Appendix A rule 4's `reset`), which
/// makes the pins an instruction rather than a claim about the worker.
pub(super) fn pin_value_mismatch(worker: &Worker, dispatch: &StepDispatch) -> Option<String> {
    let restoring = dispatch
        .recovery
        .as_ref()
        .and_then(|recovery| recovery.restore_pins.as_ref())
        == Some(&dispatch.pins);
    if restoring {
        return None;
    }
    let mut differences = Vec::new();
    for pin in &dispatch.pins.workspace {
        let held = worker
            .pins
            .workspace
            .iter()
            .find(|held| workspace_surfaces_equal(&held.surface, &pin.surface));
        if let Some(held) = held
            && held.revision_id != pin.revision_id
        {
            differences.push(format!(
                "{} pinned at {} but worker {} holds {}",
                pin.surface, pin.revision_id, worker.worker_id, held.revision_id
            ));
        }
    }
    for pin in &dispatch.pins.streams {
        let held = worker
            .pins
            .streams
            .iter()
            .find(|held| held.stream == pin.stream);
        if let Some(held) = held
            && held.read_offset != pin.read_offset
        {
            differences.push(format!(
                "{} pinned at offset {} but worker {} holds offset {}",
                pin.stream, pin.read_offset, worker.worker_id, held.read_offset
            ));
        }
    }
    (!differences.is_empty()).then(|| differences.join("; "))
}

/// Does this worker report every surface the attempt is pinned to?
pub(super) fn worker_holds(worker: &Worker, pins: &Pins) -> bool {
    pins.workspace.iter().all(|pin| {
        worker
            .pins
            .workspace
            .iter()
            .any(|held| workspace_surfaces_equal(&held.surface, &pin.surface))
    }) && pins.streams.iter().all(|pin| {
        worker
            .pins
            .streams
            .iter()
            .any(|held| held.stream == pin.stream)
    })
}
