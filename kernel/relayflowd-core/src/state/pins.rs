//! Appendix A rule 6: the per-surface pin chain, validated on every fold.
//! Split from `state.rs` so the fold's bookkeeping and the chain's rules stay
//! separately readable.

use super::{RunState, StateError};
use crate::{
    entry::{JournalEntry, Pins},
    machine::carried_pins,
    spec::{RecoveryMode, StepKind, StepType},
};

impl RunState {
    pub(super) fn validate_start_pins(
        &self,
        entry: &JournalEntry,
        payload: &crate::entry::AttemptStartedPayload,
    ) -> Result<(), StateError> {
        if payload.step_type != StepType::Agent {
            return Ok(());
        }
        let step_id = entry
            .step_id
            .as_deref()
            .ok_or(StateError::MissingStep(entry.seq))?;
        let runtime = self
            .steps
            .get(step_id)
            .ok_or_else(|| StateError::UnknownStep(step_id.to_owned()))?;
        let spec = self
            .spec
            .step(step_id)
            .ok_or_else(|| StateError::UnknownStep(step_id.to_owned()))?;
        // A retry re-enters the *same* step, so the whole pin set must be the
        // one recovery selected. A first attempt inherits the chain **per
        // surface** (Appendix A rule 6): surfaces the run has already pinned
        // must carry that exact revision forward, surfaces the chain has never
        // produced are worker-sourced and unconstrained here.
        if let Some(previous) = runtime.last_completion_reason {
            let expected = match spec.kind {
                StepKind::Agent {
                    recovery_mode: RecoveryMode::Inspect,
                    ..
                } => runtime
                    .last_end_pins
                    .as_ref()
                    .or(runtime.last_start_pins.as_ref()),
                StepKind::Agent { .. } => runtime.last_start_pins.as_ref(),
                _ => None,
            };
            if let Some(expected) = expected
                && expected != &payload.pins
            {
                return Err(StateError::BrokenPinChain {
                    step: step_id.to_owned(),
                    chain_source: format!("recovery after {previous:?}"),
                    expected: Box::new(expected.clone()),
                    actual: Box::new(payload.pins.clone()),
                });
            }
            return Ok(());
        }
        let (Some(chain), StepKind::Agent { surfaces, .. }) =
            (self.current_pins.as_ref(), &spec.kind)
        else {
            return Ok(());
        };
        let carried = carried_pins(Some(chain), surfaces);
        let inherited = Pins {
            workspace: payload
                .pins
                .workspace
                .iter()
                .filter(|pin| {
                    carried
                        .workspace
                        .iter()
                        .any(|declared| declared.surface == pin.surface)
                })
                .cloned()
                .collect(),
            streams: payload
                .pins
                .streams
                .iter()
                .filter(|pin| {
                    carried
                        .streams
                        .iter()
                        .any(|declared| declared.stream == pin.stream)
                })
                .cloned()
                .collect(),
        };
        if inherited != carried {
            return Err(StateError::BrokenPinChain {
                step: step_id.to_owned(),
                chain_source: "previous agent completion".to_owned(),
                expected: Box::new(carried),
                actual: Box::new(inherited),
            });
        }
        Ok(())
    }
}

/// Appendix A rule 6: completion pins the end state, and the next step's start
/// *is* that end state. A step declares only its own surfaces (rule 1), so its
/// `end_pins` speak for those surfaces alone — a surface it never named is
/// untouched by it and its pinned revision is still the chain's truth. The
/// chain therefore merges per surface; replacing it wholesale would drop a
/// revision an earlier step pinned the moment an intermediate step declared a
/// different surface, and the next step to declare it would source it from a
/// worker as if the run had never pinned it.
pub(super) fn chain_forward(chain: Option<Pins>, end_pins: Option<Pins>) -> Option<Pins> {
    let Some(end_pins) = end_pins else {
        return chain;
    };
    let Some(mut merged) = chain else {
        return Some(end_pins);
    };
    for pin in end_pins.workspace {
        match merged
            .workspace
            .iter_mut()
            .find(|held| held.surface == pin.surface)
        {
            Some(held) => *held = pin,
            None => merged.workspace.push(pin),
        }
    }
    for pin in end_pins.streams {
        match merged
            .streams
            .iter_mut()
            .find(|held| held.stream == pin.stream)
        {
            Some(held) => *held = pin,
            None => merged.streams.push(pin),
        }
    }
    Some(merged)
}
