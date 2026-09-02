//! Deterministic parallel batch selection.
//!
//! DAG independence is not enough for agent work: two steps can be topology-
//! independent while mutating the same declared surface. The authored-order
//! maximal batch therefore reserves each mutable surface once. An unfinished
//! attempt in backoff or waiting retains its reservation just like a live
//! lease, preventing a crash/retry from turning into a last-write-wins fork.

use crate::{
    spec::{StepKind, StepSpec, external_surface_identity},
    state::{RunState, StepRuntime, StepState},
};

#[derive(Clone, PartialEq, Eq)]
enum SurfaceIdentity {
    Opaque(String),
    External {
        namespace: String,
        components: Vec<String>,
    },
}

impl SurfaceIdentity {
    fn conflicts(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Opaque(left), Self::Opaque(right)) => left == right,
            (
                Self::External {
                    namespace: left_namespace,
                    components: left,
                },
                Self::External {
                    namespace: right_namespace,
                    components: right,
                },
            ) => {
                left_namespace == right_namespace
                    && (left.starts_with(right) || right.starts_with(left))
            }
            _ => false,
        }
    }
}

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
        .collect::<Vec<_>>();
    let mut selected = Vec::new();
    for step in &state.spec.steps {
        let runtime = &state.steps[&step.id];
        if runtime.state != StepState::Runnable {
            continue;
        }
        let surfaces = surface_keys(step).collect::<Vec<_>>();
        if surfaces
            .iter()
            .any(|surface| occupied.iter().any(|held| surface.conflicts(held)))
        {
            continue;
        }
        occupied.extend(surfaces);
        selected.push((step, runtime));
    }
    selected
}

fn surface_keys(step: &StepSpec) -> impl Iterator<Item = SurfaceIdentity> + '_ {
    let StepKind::Agent { surfaces, .. } = &step.kind else {
        return Vec::new().into_iter();
    };
    surfaces
        .workspace
        .iter()
        .map(|surface| SurfaceIdentity::Opaque(format!("workspace:{}", surface.surface)))
        .chain(
            surfaces
                .streams
                .iter()
                .map(|surface| SurfaceIdentity::Opaque(format!("stream:{}", surface.stream))),
        )
        .chain(surfaces.external.iter().map(|surface| {
            let (namespace, components) = external_surface_identity(surface)
                .expect("validated specs have canonical external surfaces");
            SurfaceIdentity::External {
                namespace,
                components,
            }
        }))
        .collect::<Vec<_>>()
        .into_iter()
}
