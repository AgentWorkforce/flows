use anyhow::{Context, Result, anyhow, bail};
use relayflowd_core::{
    AttemptResult, Budget, Clock, CompletionReason, EffectRecordedPayload, EffectRef, EntryType,
    JournalEntry, Pins, StepKind, StepState, StreamAppendedPayload, WaitCompletedPayload,
    WaitCompletionReason, WaitEventPayload, abandonment_actions, completion_actions,
};
use relayflowd_journal::SqliteJournal;
use serde_json::Value;

use super::{DriveOptions, Engine, RunOutcome, validate_agent_pins};
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
        let mut failure_detail = None;
        let mut reject = |error: anyhow::Error| {
            failure_reason = Some(CompletionReason::WorkerError);
            failure_detail = Some(format!("{error:#}"));
        };
        let effects = if matches!(step.kind, StepKind::Agent { .. }) {
            let recorded = recorded_effects(&journal, &step, completion.attempt)?;
            if let Err(error) = validate_agent_completion(&step, runtime, &completion, &recorded) {
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
        let result = AttemptResult {
            output: completion.output,
            budget: completion.budget,
            completed_by: completion.completed_by,
            end_pins: completion.end_pins,
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

    /// Append the effect fact before the worker calls its provider. The
    /// journal's unique key decides the winner atomically and reports whether
    /// this attempt must suppress the provider call.
    #[allow(clippy::too_many_arguments)]
    pub fn record_effect(
        &self,
        run_id: &str,
        step_id: &str,
        attempt: u32,
        idempotency_key: &str,
        surface_path: &str,
        revision_before: &str,
        revision_after: &str,
        agent_identity: &str,
    ) -> Result<bool> {
        let mut journal = self.open_run(run_id)?;
        let spec = journal.run_spec().context("read run spec")?;
        let state = self.load_state(&journal, spec.clone())?;
        let step = spec
            .step(step_id)
            .with_context(|| format!("run {run_id} has no step {step_id}"))?;
        let StepKind::Agent { surfaces, .. } = &step.kind else {
            bail!("step {step_id} is not an agent step")
        };
        if !surfaces.external.iter().any(|path| path == surface_path) {
            bail!("effect path {surface_path} is not declared by agent step {step_id}")
        }
        let StepState::Running {
            attempt: active_attempt,
            idempotency_key: active_key,
            ..
        } = &state.steps[step_id].state
        else {
            bail!("step {step_id} has no active lease")
        };
        if *active_attempt != attempt || active_key != idempotency_key {
            bail!("effect does not match the active agent attempt")
        }
        let persisted = self.append(
            &mut journal,
            &JournalEntry::new(
                EntryType::EffectRecorded,
                run_id,
                Some(step_id.to_owned()),
                Some(attempt),
                self.clock.now_ms(),
                EffectRecordedPayload {
                    surface_path: surface_path.to_owned(),
                    idempotency_key: idempotency_key.to_owned(),
                    revision_before: revision_before.to_owned(),
                    revision_after: revision_after.to_owned(),
                    agent_identity: agent_identity.to_owned(),
                    deduped: false,
                },
            ),
        )?;
        let effect: EffectRecordedPayload = serde_json::from_value(persisted.payload)?;
        Ok(effect.deduped)
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
) -> Result<()> {
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

fn recorded_effects(
    journal: &SqliteJournal,
    step: &relayflowd_core::StepSpec,
    attempt: u32,
) -> Result<Vec<EffectRef>> {
    let recorded = journal
        .scan_all()
        .context("read recorded effects")?
        .into_iter()
        .filter(|entry| {
            entry.entry_type == EntryType::EffectRecorded
                && entry.step_id.as_deref() == Some(step.id.as_str())
                && entry.attempt == Some(attempt)
        })
        .map(|entry| {
            let effect: EffectRecordedPayload = serde_json::from_value(entry.payload)?;
            Ok((effect.surface_path, effect.idempotency_key))
        })
        .collect::<Result<std::collections::BTreeSet<_>>>()?;
    Ok(recorded
        .into_iter()
        .map(|(surface_path, idempotency_key)| EffectRef {
            surface_path,
            idempotency_key,
        })
        .collect())
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
