use anyhow::{Context, Result, bail};
use relayflowd_core::{
    AttemptResult, Budget, Clock, CompletionReason, EffectRef, EntryType, JournalEntry, Pins,
    StepState, StreamAppendedPayload, WaitCompletedPayload, WaitCompletionReason, WaitEventPayload,
    abandonment_actions, completion_actions,
};
use relayflowd_journal::SqliteJournal;
use serde_json::Value;

use super::{DriveOptions, Engine, RunOutcome, ensure_supported};
use crate::clock::WallClock;

#[derive(Debug, Clone)]
pub struct OutOfBandCompletion {
    pub attempt: u32,
    pub idempotency_key: String,
    pub completion_reason: CompletionReason,
    pub output: Value,
    pub budget: Budget,
    pub completed_by: String,
    pub end_pins: Option<Pins>,
    pub effects: Vec<EffectRef>,
}

impl Engine<WallClock> {
    /// Complete a currently leased step through the same verification/retry
    /// state-machine path used by in-process deterministic execution.
    pub fn complete_out_of_band(
        &self,
        run_id: &str,
        step_id: &str,
        completion: OutOfBandCompletion,
    ) -> Result<RunOutcome> {
        let mut journal = self.open_run(run_id)?;
        let spec = journal.run_spec().context("read run spec")?;
        ensure_supported(&spec)?;
        let state = self.load_state(&journal, spec.clone())?;
        let step = spec
            .step(step_id)
            .cloned()
            .with_context(|| format!("run {run_id} has no step {step_id}"))?;
        let runtime = &state.steps[step_id];
        let StepState::Running {
            attempt,
            ref idempotency_key,
            ..
        } = runtime.state
        else {
            bail!("step {step_id} has no active lease")
        };
        if attempt != completion.attempt || idempotency_key != &completion.idempotency_key {
            bail!("step {step_id} completion does not match its active lease")
        }
        let failure_reason = (completion.completion_reason != CompletionReason::Success)
            .then_some(completion.completion_reason);
        let result = AttemptResult {
            output: completion.output,
            budget: completion.budget,
            completed_by: completion.completed_by,
            end_pins: completion.end_pins,
            effects: completion.effects,
            failure_reason,
        };
        for action in completion_actions(
            run_id,
            &step,
            attempt,
            runtime.semantic_executions,
            result,
            self.clock.now_ms(),
        ) {
            self.interpret_non_execution(&mut journal, action)?;
        }
        self.drive(journal, spec, DriveOptions::default())
    }

    /// Explain a live worker disconnect immediately, then make the unfinished
    /// step eligible for another lease without consuming an iteration.
    pub fn abandon_out_of_band(
        &self,
        run_id: &str,
        step_id: &str,
        attempt: u32,
        reason: CompletionReason,
    ) -> Result<RunOutcome> {
        if !matches!(
            reason,
            CompletionReason::Crashed | CompletionReason::LeaseExpired
        ) {
            bail!("a dead attempt requires crashed or lease_expired")
        }
        let mut journal = self.open_run(run_id)?;
        let spec = journal.run_spec().context("read run spec")?;
        ensure_supported(&spec)?;
        let state = self.load_state(&journal, spec.clone())?;
        let actions = abandonment_actions(&state, step_id, attempt, reason, self.clock.now_ms());
        if actions.is_empty() {
            bail!("step {step_id} attempt {attempt} has no active lease")
        }
        for action in actions {
            self.persist_only(&mut journal, action)?;
        }
        let state = self.load_state(&journal, spec)?;
        self.registry()?.set_status(run_id, "parked", None)?;
        Ok(RunOutcome {
            run_id: run_id.to_owned(),
            status: super::RunStatus::Parked,
            completion_reason: None,
            completed_steps: state.completed_steps(),
        })
    }

    pub fn append_stream(
        &self,
        run_id: &str,
        stream: &str,
        producer: &str,
        message: Value,
    ) -> Result<u64> {
        let mut journal = self.open_run(run_id)?;
        let offset = next_stream_offset(&journal, stream)?;
        self.append(
            &mut journal,
            &JournalEntry::new(
                EntryType::StreamAppended,
                run_id,
                None,
                None,
                self.clock.now_ms(),
                StreamAppendedPayload {
                    stream: stream.to_owned(),
                    offset,
                    producer: producer.to_owned(),
                    message,
                },
            ),
        )?;
        Ok(offset)
    }

    pub fn read_stream(
        &self,
        run_id: &str,
        stream: &str,
        from_offset: u64,
        limit: usize,
    ) -> Result<(Vec<Value>, u64)> {
        let journal = self.open_run(run_id)?;
        let mut messages = Vec::new();
        let mut next_offset = from_offset;
        for entry in journal.scan_all().context("read stream journal")? {
            if entry.entry_type != EntryType::StreamAppended {
                continue;
            }
            let payload: StreamAppendedPayload = serde_json::from_value(entry.payload)?;
            if payload.stream == stream && payload.offset >= from_offset && messages.len() < limit {
                next_offset = payload.offset.saturating_add(1);
                messages.push(payload.message);
            }
        }
        Ok((messages, next_offset))
    }

    pub fn emit_event(&self, run_id: &str, event_key: &str, payload: Value) -> Result<usize> {
        let mut journal = self.open_run(run_id)?;
        let spec = journal.run_spec().context("read run spec")?;
        let entries = journal.scan_all().context("read event waits")?;
        let mut open = Vec::new();
        for entry in &entries {
            if entry.entry_type == EntryType::WaitEvent {
                let wait: WaitEventPayload = serde_json::from_value(entry.payload.clone())?;
                if wait.event_key == event_key {
                    open.push((wait.wait_id, entry.step_id.clone(), entry.attempt));
                }
            } else if entry.entry_type == EntryType::WaitCompleted {
                let done: WaitCompletedPayload = serde_json::from_value(entry.payload.clone())?;
                open.retain(|(wait_id, _, _)| wait_id != &done.wait_id);
            }
        }
        for (wait_id, step_id, attempt) in &open {
            self.append(
                &mut journal,
                &JournalEntry::new(
                    EntryType::WaitCompleted,
                    run_id,
                    step_id.clone(),
                    *attempt,
                    self.clock.now_ms(),
                    WaitCompletedPayload {
                        wait_id: wait_id.clone(),
                        completion_reason: WaitCompletionReason::EventReceived,
                        result: payload.clone(),
                    },
                ),
            )?;
        }
        if !open.is_empty() {
            let _ = self.drive(journal, spec, DriveOptions::default())?;
        }
        Ok(open.len())
    }
}

fn next_stream_offset(journal: &SqliteJournal, stream: &str) -> Result<u64> {
    let mut next = 0;
    for entry in journal.scan_all().context("read stream offset")? {
        if entry.entry_type != EntryType::StreamAppended {
            continue;
        }
        let payload: StreamAppendedPayload = serde_json::from_value(entry.payload)?;
        if payload.stream == stream {
            next = next.max(payload.offset.saturating_add(1));
        }
    }
    Ok(next)
}
