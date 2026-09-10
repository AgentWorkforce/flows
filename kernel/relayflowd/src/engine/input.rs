use anyhow::{Context, Result};
use relayflowd_core::{
    AttemptResult, Clock, CompletionReason, Disposition, EntryType, StepCompletedPayload, StepSpec,
    completion_actions, input::select,
};
use relayflowd_journal::SqliteJournal;
use serde_json::{Map, Value};

use super::Engine;

impl<C: Clock> Engine<C> {
    /// Resolve only durable successful completions. A restarted driver reads
    /// the same journal values, without re-executing or asking an SDK cache.
    /// None means a missing value completed this attempt with a typed failure.
    pub(super) fn resolve_step_input(
        &self,
        journal: &mut SqliteJournal,
        step: &StepSpec,
        attempt: u32,
    ) -> Result<Option<Map<String, Value>>> {
        let Some(bindings) = &step.input else {
            return Ok(Some(Map::new()));
        };
        let entries = journal.scan_all()?;
        let mut inputs = Map::new();
        for (name, binding) in bindings {
            let mut output = None;
            for entry in &entries {
                if entry.entry_type != EntryType::StepCompleted
                    || entry.step_id.as_deref() != Some(&binding.step)
                {
                    continue;
                }
                let completed: StepCompletedPayload = serde_json::from_value(entry.payload.clone())
                    .context("invalid step.completed while resolving input")?;
                if completed.completion_reason == CompletionReason::Success
                    && completed.disposition == Disposition::StepDone
                {
                    output = Some(completed.output);
                }
            }
            let selected = output
                .as_ref()
                .and_then(|output| select(output, binding.path.as_deref().unwrap_or_default()));
            let Some(value) = selected else {
                let state = self.load_state(journal, journal.run_spec()?)?;
                let mut failure = AttemptResult::successful(Value::Null, "kernel");
                failure.failure_reason = Some(CompletionReason::WorkerError);
                failure.failure_detail = Some(format!(
                    "input {name:?}: source {:?} has no successful output value at {:?}",
                    binding.step, binding.path
                ));
                for action in completion_actions(
                    journal.run_id(),
                    step,
                    attempt,
                    state.steps[&step.id].semantic_executions,
                    failure,
                    self.clock.now_ms(),
                ) {
                    self.interpret_non_execution(journal, action)?;
                }
                return Ok(None);
            };
            inputs.insert(name.clone(), value.clone());
        }
        Ok(Some(inputs))
    }
}
