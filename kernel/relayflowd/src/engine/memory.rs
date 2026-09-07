use super::Engine;
use crate::memory::MemoryProvider;
use anyhow::Result;
use relayflowd_core::{
    AttemptResult, Clock, CompletionReason, EntryType, JournalEntry, MemoryInjectedPayload,
    StepSpec, completion_actions,
};
use relayflowd_journal::SqliteJournal;
use std::sync::Arc;

impl<C: Clock> Engine<C> {
    pub fn with_memory_provider(mut self, provider: Arc<dyn MemoryProvider>) -> Self {
        self.memory_provider = provider;
        self
    }

    /// A committed pack belongs to the step, not an attempt. Never ask the
    /// provider again once this fact exists, including on semantic retries.
    /// False means injection failed and the attempt was completed as a typed
    /// failure; the caller must not execute or dispatch it.
    pub(super) fn ensure_step_memory(
        &self,
        journal: &mut SqliteJournal,
        step: &StepSpec,
        attempt: u32,
    ) -> Result<bool> {
        let Some(request) = &step.memory else {
            return Ok(true);
        };
        let state = self.load_state(journal, journal.run_spec()?)?;
        if state.steps[&step.id].memory.is_some() {
            return Ok(true);
        }
        let candidate = self
            .memory_provider
            .provide(journal.run_id(), &step.id, request);
        let (reason, detail) = match candidate {
            Ok(pack) if request.permits(&pack.budget) => {
                let entry = JournalEntry::new(
                    EntryType::MemoryInjected,
                    journal.run_id(),
                    Some(step.id.clone()),
                    Some(attempt),
                    self.clock.now_ms(),
                    MemoryInjectedPayload {
                        request: request.clone(),
                        pack: pack.pack,
                        budget: pack.budget,
                        provider: self.memory_provider.name().to_owned(),
                    },
                );
                // The journal validates the fact and accounting inside its
                // transaction. A write failure propagates: no worker sees it.
                self.append(journal, &entry)?;
                return Ok(true);
            }
            Ok(_) => (
                CompletionReason::BudgetExceeded,
                "memory pack exceeds the step's declared memory budget".to_owned(),
            ),
            Err(error) => (
                CompletionReason::WorkerError,
                format!("memory provider failed: {error:#}"),
            ),
        };
        let mut result = AttemptResult::successful(serde_json::Value::Null, "kernel");
        result.failure_reason = Some(reason);
        result.failure_detail = Some(detail);
        for action in completion_actions(
            journal.run_id(),
            step,
            attempt,
            state.steps[&step.id].semantic_executions,
            result,
            self.clock.now_ms(),
        ) {
            self.interpret_non_execution(journal, action)?;
        }
        Ok(false)
    }
}
