//! Which attached worker may receive an attempt, and whether it stands where
//! the attempt is pinned. Split from `session.rs` so worker selection and
//! Appendix A rule 2's starting-state check read as their own subject.

use relayflowd_core::{Pins, StepType};

use super::{Sessions, Worker};
use crate::worker::StepDispatch;

/// The single worker-selection rule, shared by pin sourcing and dispatch.
pub(super) fn select_worker(sessions: &Sessions, step_type: StepType) -> Option<&Worker> {
    sessions
        .workers
        .iter()
        .find(|worker| worker.step_types.contains(&step_type))
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
            .find(|held| held.surface == pin.surface);
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
            .any(|held| held.surface == pin.surface)
    }) && pins.streams.iter().all(|pin| {
        worker
            .pins
            .streams
            .iter()
            .any(|held| held.stream == pin.stream)
    })
}
