use super::{RunState, StateError, decode};
use crate::{JournalEntry, MemoryInjectedPayload, StepState};

impl RunState {
    pub(super) fn validate_memory_payload(
        &self,
        step_id: &str,
        payload: &MemoryInjectedPayload,
    ) -> Result<(), StateError> {
        let declaration = self
            .spec
            .step(step_id)
            .and_then(|step| step.memory.as_ref());
        if declaration != Some(&payload.request)
            || !payload.request.permits(&payload.budget)
            || payload.provider.trim().is_empty()
        {
            return Err(StateError::InvalidMemory {
                step: step_id.into(),
                detail: "pack must match the declaration, name its provider, and fit its budget"
                    .into(),
            });
        }
        Ok(())
    }

    pub(super) fn apply_memory_injected(&mut self, entry: &JournalEntry) -> Result<(), StateError> {
        let step_id = entry
            .step_id
            .as_deref()
            .ok_or(StateError::MissingStep(entry.seq))?;
        let payload: MemoryInjectedPayload = decode(entry)?;
        self.validate_memory_payload(step_id, &payload)?;
        let step = self
            .steps
            .get(step_id)
            .ok_or_else(|| StateError::UnknownStep(step_id.into()))?;
        if step.memory.is_some()
            || !matches!(step.state, StepState::Running { attempt, .. } if Some(attempt) == entry.attempt)
        {
            return Err(StateError::InvalidMemory {
                step: step_id.into(),
                detail: "memory must be injected once by an active attempt".into(),
            });
        }
        self.charge_budget(&payload.budget, 0, entry.at_ms)?;
        self.steps.get_mut(step_id).expect("validated step").memory = Some(payload);
        Ok(())
    }
}
