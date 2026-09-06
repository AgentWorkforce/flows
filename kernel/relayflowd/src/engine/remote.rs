use anyhow::{Context, Result, anyhow, bail};
use relayflowd_core::{
    AttemptResult, Budget, Clock, CompletionReason, EffectRef, EntryType, JournalEntry, Pins,
    StepKind, StepState, StreamAppendedPayload, WaitCompletedPayload, WaitCompletionReason,
    WaitEventPayload, abandonment_actions, completion_actions,
};
use relayflowd_journal::SqliteJournal;
use serde_json::Value;

use super::{
    DriveOptions, Engine, RunOutcome,
    effects::{recorded_effects, reject_unconfirmed_elections, unconfirmed_elections},
    validate_agent_pins,
};
use crate::clock::WallClock;
use crate::worker::LeaseProbe;

#[derive(Debug, Clone)]
pub struct OutOfBandCompletion {
    pub attempt: u32,
    pub idempotency_key: String,
    pub completion_reason: CompletionReason,
    pub output: Value,
    pub budget: Budget,
    pub completed_by: String,
    pub started_pins: Option<Pins>,
    pub end_pins: Option<Pins>,
    pub effects: Vec<EffectRef>,
    pub trajectory_tail: Option<Value>,
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
        let state = self.load_state(&journal, spec.clone())?;
        if state.cancel_requested.is_some() || state.completion.is_some() {
            bail!("run {run_id} no longer accepts step completions")
        }
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
        let mut failure_reason = (completion.completion_reason != CompletionReason::Success)
            .then_some(completion.completion_reason);
        // A rejected completion names the mistake in the journal. `output` is
        // nulled for every non-success, so the detail rides the completion's
        // verification record — the same channel a failed gate uses.
        //
        // A WORKER-reported failure gets that treatment too. `OutOfBandCompletion`
        // carries no error field, so the only account of what went wrong is the
        // output the worker sent with its failing completion — and that is
        // exactly what gets nulled. Capture it here, bounded, or the run records
        // that the step failed and discards every trace of why.
        let mut failure_detail = failure_reason.and_then(|_| worker_failure_detail(&completion.output));
        let mut rejected_completion = false;
        let mut reject = |error: anyhow::Error| {
            rejected_completion = true;
            failure_reason = Some(CompletionReason::WorkerError);
            failure_detail = Some(format!("{error:#}"));
        };
        let effects = if matches!(step.kind, StepKind::Agent { .. }) {
            let recorded = recorded_effects(&journal, &step, completion.attempt)?;
            let unconfirmed = unconfirmed_elections(&journal, &step, completion.attempt)?;
            if let Err(error) =
                validate_agent_completion(&step, runtime, &completion, &recorded, &unconfirmed)
            {
                reject(error);
            }
            recorded
        } else if completion.effects.is_empty() {
            Vec::new()
        } else {
            // Only an agent step declares external surfaces (Appendix A rule 1)
            // and only `effect.record` journals the fact behind an effect
            // (rule 3). An effect claimed by any other step type is undeclared
            // and unbacked, so the completion fails closed rather than
            // journaling a writeback nothing witnessed.
            reject(anyhow!(
                "step {step_id} is not an agent step and cannot claim effects"
            ));
            Vec::new()
        };
        // Rejected evidence cannot become authoritative state. In particular,
        // inspect retries must inherit the last accepted pins, not an end pin
        // carried by a completion whose claimed starting point was invalid.
        let end_pins = if matches!(step.kind, StepKind::Agent { .. }) && rejected_completion {
            None
        } else {
            completion.end_pins
        };
        let result = AttemptResult {
            output: completion.output,
            budget: completion.budget,
            completed_by: completion.completed_by,
            end_pins,
            effects,
            trajectory_tail: completion.trajectory_tail,
            failure_reason,
            failure_detail,
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

    /// Resume driven from a live server: attempts whose worker still holds a
    /// valid, heartbeating lease are left running; only genuinely dead
    /// attempts (worker detached, or lease deadline passed) are recovered.
    pub fn resume_live(&self, run_id: &str, leases: &dyn LeaseProbe) -> Result<RunOutcome> {
        let now_ms = self.clock.now_ms();
        self.resume_filtered(run_id, DriveOptions::default(), &|step_id, attempt| {
            leases.lease_active(run_id, step_id, attempt, now_ms)
        })
    }

    /// Explain a dead leased attempt (worker disconnect or lease expiry), then
    /// make the unfinished step eligible for another lease without consuming
    /// an iteration. Returns `Ok(None)` when the attempt is no longer the
    /// active lease — its completion is already journaled, nothing to record.
    /// A journal failure is an error: the abandonment MUST NOT be dropped.
    pub fn abandon_out_of_band(
        &self,
        run_id: &str,
        step_id: &str,
        attempt: u32,
        reason: CompletionReason,
    ) -> Result<Option<RunOutcome>> {
        if !matches!(
            reason,
            CompletionReason::Crashed | CompletionReason::LeaseExpired
        ) {
            bail!("a dead attempt requires crashed or lease_expired")
        }
        let mut journal = self.open_run(run_id)?;
        let spec = journal.run_spec().context("read run spec")?;
        let state = self.load_state(&journal, spec.clone())?;
        let actions = abandonment_actions(&state, step_id, attempt, reason, self.clock.now_ms());
        if actions.is_empty() {
            return Ok(None);
        }
        for action in actions {
            self.persist_only(&mut journal, action)?;
        }
        let state = self.load_state(&journal, spec)?;
        self.registry()?.set_status(run_id, "parked", None)?;
        Ok(Some(RunOutcome {
            run_id: run_id.to_owned(),
            status: super::RunStatus::Parked,
            completion_reason: None,
            completed_steps: state.completed_steps(),
        }))
    }

    /// Durably record a heartbeat-renewed lease deadline. The journal pins the
    /// lease grant at attempt start; renewals are operational state, persisted
    /// in the run registry so they survive alongside the in-memory hub.
    pub fn renew_lease(&self, run_id: &str, lease_deadline_ms: i64) -> Result<()> {
        self.registry()?
            .renew_deadline(run_id, lease_deadline_ms)
            .context("persist renewed lease deadline")?;
        Ok(())
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

fn validate_agent_completion(
    step: &relayflowd_core::StepSpec,
    runtime: &relayflowd_core::StepRuntime,
    completion: &OutOfBandCompletion,
    recorded_effects: &[EffectRef],
    unconfirmed: &[String],
) -> Result<()> {
    reject_unconfirmed_elections(completion, unconfirmed)?;
    let expected_start = runtime
        .last_start_pins
        .as_ref()
        .context("agent attempt has no journaled start pins")?;
    let reported_start = completion
        .started_pins
        .as_ref()
        .context("agent completion omitted started_pins")?;
    if reported_start != expected_start {
        bail!("agent reported starting from pins other than its journaled pin")
    }
    if let Some(end_pins) = &completion.end_pins {
        validate_agent_pins(step, end_pins)?;
    } else if completion.completion_reason == CompletionReason::Success {
        bail!("successful agent completion omitted end_pins")
    }

    let recorded = recorded_effects
        .iter()
        .map(|effect| {
            (
                effect.surface_path.as_str(),
                effect.idempotency_key.as_str(),
            )
        })
        .collect::<std::collections::BTreeSet<_>>();
    let carried = completion
        .effects
        .iter()
        .map(|effect| {
            (
                effect.surface_path.as_str(),
                effect.idempotency_key.as_str(),
            )
        })
        .collect::<std::collections::BTreeSet<_>>();
    if carried != recorded {
        bail!("agent completion effects do not match its journaled effect facts")
    }
    Ok(())
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

/// The worker's own account of a failure, bounded so a large or hostile output
/// cannot bloat the journal. `None` when the worker sent nothing useful, which
/// keeps the caller's fallback ("reported X without detail") honest rather than
/// recording an empty string as though it were a diagnostic.
fn worker_failure_detail(output: &Value) -> Option<String> {
    const MAX: usize = 2000;
    if output.is_null() {
        return None;
    }
    let rendered = match output {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    let trimmed = rendered.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Truncate on a char boundary; `output` is arbitrary worker-supplied data
    // and slicing it by byte index would panic on multi-byte input.
    Some(match trimmed.char_indices().nth(MAX) {
        None => trimmed.to_owned(),
        Some((cut, _)) => format!("{}… ({} bytes truncated)", &trimmed[..cut], trimmed.len() - cut),
    })
}
