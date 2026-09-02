//! Deterministic parallel batch selection.
//!
//! DAG independence is not enough for agent work: two steps can be topology-
//! independent while mutating the same declared surface. The authored-order
//! maximal batch therefore reserves each mutable surface once. An unfinished
//! attempt in backoff or waiting retains its reservation just like a live
//! lease, preventing a crash/retry from turning into a last-write-wins fork.

use std::collections::BTreeSet;

use crate::{
    spec::{StepKind, StepSpec},
    state::{RunState, StepRuntime, StepState},
};

pub(super) fn runnable_batch(state: &RunState) -> Vec<(&StepSpec, &StepRuntime)> {
    let mut occupied = state
        .spec
        .steps
        .iter()
        .filter(|step| {
            matches!(
                state.steps[&step.id].state,
                StepState::Running { .. }
                    | StepState::Backoff { .. }
                    | StepState::Waiting { .. }
                    | StepState::NeedsHuman { .. }
            )
        })
        .flat_map(surface_keys)
        .collect::<BTreeSet<_>>();
    let mut selected = Vec::new();
    for step in &state.spec.steps {
        let runtime = &state.steps[&step.id];
        if runtime.state != StepState::Runnable {
            continue;
        }
        let surfaces = surface_keys(step).collect::<Vec<_>>();
        if surfaces.iter().any(|surface| occupied.contains(surface)) {
            continue;
        }
        occupied.extend(surfaces);
        selected.push((step, runtime));
    }
    selected
}

fn surface_keys(step: &StepSpec) -> impl Iterator<Item = String> + '_ {
    let StepKind::Agent { surfaces, .. } = &step.kind else {
        return Vec::new().into_iter();
    };
    surfaces
        .workspace
        .iter()
        .map(|surface| format!("workspace:{}", surface.surface))
        .chain(
            surfaces
                .streams
                .iter()
                .map(|surface| format!("stream:{}", surface.stream)),
        )
        .chain(
            surfaces
                .external
                .iter()
                .map(|surface| format!("external:{surface}")),
        )
        .collect::<Vec<_>>()
        .into_iter()
}
