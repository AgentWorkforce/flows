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
    pub human_intervention: bool,
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
        if !relayflowd_core::memory::valid_decimal(&completion.budget.dollars)
            || relayflowd_core::journal_dollars(&completion.budget.dollars).is_err()
        {
            bail!("step completion usage.dollars must be a non-negative decimal string");
        }
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
        //
        // ORDERING NOTE (#197 item 4): this capture MUST run before any
        // `reject()` call below. If it did not, `reject`'s "keep both accounts"
        // path would see a leftover `failure_detail` from a completion whose
        // ORIGINAL `completion_reason` was `Success` and format
        // "rejected: …; worker reported: …" for a success. The explicit
        // `match` (rather than the tighter `.is_some().then().flatten()`)
        // makes the "only on non-success" precondition self-evident so a
        // future edit that moves this line downward reads as suspicious.
        let mut failure_detail = match failure_reason {
            Some(_) => worker_failure_detail(&completion.output),
            None => None,
        };
        let mut rejected_completion = false;
        let mut reject = |error: anyhow::Error| {
            rejected_completion = true;
            failure_reason = Some(CompletionReason::WorkerError);
            // Keep BOTH accounts when a worker reports its own failure and then
            // trips validation. The rejection says why the kernel refused the
            // completion; the worker's output says what went wrong upstream of
            // that, and the two are rarely the same story. Overwriting here
            // would discard the worker's account for exactly the completions
            // that have the most gone wrong — the loss this whole change exists
            // to stop, reintroduced one layer up.
            failure_detail = Some(match failure_detail.take() {
                Some(reported) => format!("rejected: {error:#}; worker reported: {reported}"),
                None => format!("{error:#}"),
            });
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
            human_intervention: completion.human_intervention,
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
        self.resume_live_with_human_influence(run_id, leases, false)
    }

    pub fn resume_live_with_human_influence(
        &self,
        run_id: &str,
        leases: &dyn LeaseProbe,
        allow_human_influenced: bool,
    ) -> Result<RunOutcome> {
        let now_ms = self.clock.now_ms();
        self.resume_filtered(
            run_id,
            DriveOptions {
                allow_human_influenced,
                ..DriveOptions::default()
            },
            &|step_id, attempt| leases.lease_active(run_id, step_id, attempt, now_ms),
        )
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

/// The worker's own account of a failure, bounded — both in the journal AND
/// during render — so a large or hostile output cannot bloat the process's
/// heap OR the run's journal. `None` when the worker sent nothing useful,
/// which keeps the caller's fallback ("reported X without detail") honest
/// rather than recording an empty string as though it were a diagnostic.
///
/// #197 (item 3) previously said "bounded" when only the OUTPUT was bounded;
/// the render inside this function was unbounded, so a multi-megabyte JSON
/// object was fully materialized into memory before anything was measured or
/// truncated. `write_bounded_json` now stops emitting once
/// `MAX_RENDER_BYTES` has been produced, and the truncation suffix is added
/// after the cheap byte cap, not after a full render.
fn worker_failure_detail(output: &Value) -> Option<String> {
    // Chars, not bytes: the cut below is by char index. The suffix reports the
    // remainder in bytes, which is why both units appear in one function.
    const MAX_CHARS: usize = 2000;
    // UTF-8 upper-bounds a char at 4 bytes, plus slack for the "… (N bytes
    // truncated)" suffix computation. This ceiling ONLY caps the render; the
    // final cut still happens on char boundaries below.
    const MAX_RENDER_BYTES: usize = MAX_CHARS * 4 + 256;
    if output.is_null() {
        return None;
    }
    let mut render_truncated = false;
    let rendered = match output {
        Value::String(text) => {
            if text.len() > MAX_RENDER_BYTES {
                render_truncated = true;
                // Char-boundary-safe slice for the pre-cap head.
                let cut = text
                    .char_indices()
                    .take_while(|(byte_index, _)| *byte_index <= MAX_RENDER_BYTES)
                    .last()
                    .map(|(byte_index, ch)| byte_index + ch.len_utf8())
                    .unwrap_or(0);
                text[..cut].to_owned()
            } else {
                text.clone()
            }
        }
        other => {
            // A hand-rolled `Write` that stops once its budget is exhausted,
            // so `to_writer` never allocates a full render of a hostile
            // object before we get a chance to cut it.
            struct BoundedWriter {
                buf: Vec<u8>,
                budget: usize,
                truncated: bool,
            }
            impl std::io::Write for BoundedWriter {
                fn write(&mut self, chunk: &[u8]) -> std::io::Result<usize> {
                    if self.budget == 0 {
                        self.truncated = true;
                        return Ok(chunk.len());
                    }
                    let take = chunk.len().min(self.budget);
                    self.buf.extend_from_slice(&chunk[..take]);
                    self.budget -= take;
                    if take < chunk.len() {
                        self.truncated = true;
                    }
                    // Report full consumption so serde does not spin.
                    Ok(chunk.len())
                }
                fn flush(&mut self) -> std::io::Result<()> {
                    Ok(())
                }
            }
            let mut writer = BoundedWriter {
                buf: Vec::with_capacity(MAX_RENDER_BYTES.min(4096)),
                budget: MAX_RENDER_BYTES,
                truncated: false,
            };
            let _ = serde_json::to_writer(&mut writer, other);
            render_truncated = writer.truncated;
            // Repair a mid-multi-byte cut so `String::from_utf8` never fails.
            while !writer.buf.is_empty() && std::str::from_utf8(&writer.buf).is_err() {
                writer.buf.pop();
            }
            match String::from_utf8(writer.buf) {
                Ok(text) => text,
                Err(_) => String::new(),
            }
        }
    };
    let trimmed = rendered.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Truncate on a char boundary; `output` is arbitrary worker-supplied data
    // and slicing it by byte index would panic on multi-byte input.
    Some(match trimmed.char_indices().nth(MAX_CHARS) {
        None => {
            if render_truncated {
                format!("{trimmed}… (render bounded)")
            } else {
                trimmed.to_owned()
            }
        }
        Some((cut, _)) => format!(
            "{}… ({} bytes truncated)",
            &trimmed[..cut],
            trimmed.len() - cut
        ),
    })
}

#[cfg(test)]
mod worker_failure_detail_tests {
    use super::worker_failure_detail;
    use serde_json::{Value, json};

    #[test]
    fn a_null_or_blank_output_yields_no_detail() {
        // The caller's fallback ("reported X without detail") is only honest if
        // this returns None rather than an empty string dressed as a diagnostic.
        assert_eq!(worker_failure_detail(&Value::Null), None);
        assert_eq!(worker_failure_detail(&json!("")), None);
        assert_eq!(worker_failure_detail(&json!("   \n\t ")), None);
    }

    #[test]
    fn a_string_output_is_carried_verbatim_and_trimmed() {
        assert_eq!(
            worker_failure_detail(&json!("  analyzer exited 1: no such model  ")),
            Some("analyzer exited 1: no such model".to_owned())
        );
    }

    #[test]
    fn a_non_string_output_is_rendered_rather_than_dropped() {
        // A worker that reports structured failure data must not have it
        // discarded just because it is not a bare string.
        assert_eq!(
            worker_failure_detail(&json!({"code": 2})),
            Some(r#"{"code":2}"#.to_owned())
        );
    }

    /// The truncation comment names a panic mode — byte slicing on multi-byte
    /// input — and this pins it. The character matters: `€` is THREE bytes, so
    /// byte index `MAX_CHARS` (2000) falls at 666 chars + 2 bytes, mid-character,
    /// and `&trimmed[..MAX_CHARS]` panics on it.
    ///
    /// An earlier version of this test used `é` and claimed the same thing. That
    /// was wrong: `é` is two bytes, so byte 2000 is a valid boundary and the
    /// byte-slice mutation does NOT panic there — it silently returns half the
    /// intended characters. The test still failed, but on a length assertion,
    /// which is a much weaker signal than the panic it advertised. A test whose
    /// stated rationale is false is worse than no test, because the next reader
    /// trusts it.
    #[test]
    fn truncation_does_not_split_a_multi_byte_char() {
        // 2500 three-byte chars = 7500 bytes: above the char cap (2000) so
        // the char cut happens, but below MAX_RENDER_BYTES (~8256) so the
        // render cap does NOT preempt it. The char-boundary invariant is
        // what this test exists to pin, so keep the input in the char-cap
        // regime and let `render_is_bounded_before_allocation_for_hostile_*`
        // cover the render cap.
        let output = json!("€".repeat(2500));
        let detail = worker_failure_detail(&output).expect("detail for a long output");
        assert!(
            detail.contains('…'),
            "expected a truncation marker, got {detail:?}"
        );
        // Cut at 2000 CHARS = 6000 bytes; input is 7500 bytes, so 1500 bytes remain.
        assert!(
            detail.contains("1500 bytes truncated"),
            "expected the byte remainder, got {detail:?}"
        );
        assert_eq!(detail.chars().take_while(|c| *c == '€').count(), 2000);
    }

    #[test]
    fn an_output_at_the_boundary_is_not_truncated() {
        let exact = "a".repeat(2000);
        assert_eq!(worker_failure_detail(&json!(exact.clone())), Some(exact));
    }

    /// #197 item 3: the render itself is bounded. Before the fix, a
    /// pathological JSON object would allocate its full serialization into
    /// memory before anything measured or cut it, which was the exact
    /// "bloat the process" case the docstring claimed to prevent. Give the
    /// worker a JSON object whose full render would be ~500 KB and confirm
    /// (a) we still return a bounded detail, and (b) we mark it as bounded.
    #[test]
    fn render_is_bounded_before_allocation_for_hostile_json() {
        // 50_000-element array of small integers → ~500 KB serialized.
        let big: Vec<Value> = (0..50_000_i64).map(|n| json!(n)).collect();
        let detail = worker_failure_detail(&Value::Array(big))
            .expect("detail for a large output");
        // Truncation was applied AND signaled — the caller can tell the
        // difference between a short detail that fit and a bounded render.
        assert!(
            detail.contains('…'),
            "expected a truncation marker, got {} bytes",
            detail.len()
        );
        // Render was capped: `MAX_RENDER_BYTES = MAX_CHARS * 4 + 256 = 8256`;
        // trimmed detail should stay near that ceiling with slack for the
        // suffix ("… (N bytes truncated)"). Pin at a generous ~9 KB so
        // future MAX_CHARS bumps don't need to touch this test.
        assert!(
            detail.len() < 9_000,
            "detail bloated past render bound: {} bytes",
            detail.len()
        );
    }

    /// A big STRING output also gets its render bounded — the previous cheap
    /// `text.clone()` allocated the full string before the char-boundary cut.
    #[test]
    fn render_is_bounded_before_allocation_for_hostile_string() {
        // 500 KB of ASCII.
        let big: String = "x".repeat(500_000);
        let detail = worker_failure_detail(&json!(big))
            .expect("detail for a large string");
        assert!(detail.contains('…'), "expected truncation marker");
        assert!(
            detail.len() < 9_000,
            "detail bloated past render bound: {} bytes",
            detail.len()
        );
    }
}
