use std::{collections::BTreeSet, thread, time::Duration};

use anyhow::{Context, Result, bail};
use relayflowd_core::{
    Action, AttemptResult, Clock, CompletionReason, RunCompletionReason, RunSpec, RunState,
    abandonment_actions, completion_actions, next_actions,
};
use relayflowd_journal::SqliteJournal;

use super::{DriveOptions, Engine, RunOutcome, RunStatus, outcome_from_state};
use crate::{
    exec_det,
    worker::{DispatchOutcome, StepDispatch},
};

impl<C: Clock> Engine<C> {
    pub(super) fn drive(
        &self,
        mut journal: SqliteJournal,
        spec: RunSpec,
        options: DriveOptions,
    ) -> Result<RunOutcome> {
        let initial_completed = self.load_state(&journal, spec.clone())?.completed_steps();
        let mut pause_consumed = false;
        let mut failed_batch_redriven = false;
        loop {
            let state = self.load_state(&journal, spec.clone())?;
            if let Some(reason) = state.completion {
                return Ok(outcome_from_state(&state, reason));
            }
            if options.stop_after.is_some_and(|limit| {
                state.completed_steps().saturating_sub(initial_completed) >= limit
            }) {
                self.registry()?
                    .set_status(&state.run_id, "interrupted", None)?;
                return Ok(parked_outcome(&state, RunStatus::Interrupted));
            }
            if !pause_consumed && options.pause_before_completion && state.all_steps_succeeded() {
                pause_consumed = true;
                thread::sleep(Duration::from_secs(300));
            }

            let actions = next_actions(&state, self.clock.now_ms());
            if actions.is_empty() {
                self.park_idle_run(&state)?;
                return Ok(parked_outcome(&state, RunStatus::Parked));
            }
            let mut dispatched = false;
            let mut backpressured = false;
            let mut handoff_failed = false;
            let mut skipped_dispatches = BTreeSet::new();
            for action in actions {
                match action {
                    Action::Append(mut entry) => {
                        if entry.entry_type == relayflowd_core::EntryType::StepAttemptStarted {
                            let step_id = entry
                                .step_id
                                .as_deref()
                                .expect("a step start always names its step");
                            let step = state
                                .spec
                                .step(step_id)
                                .expect("the scheduler only starts declared steps");
                            if !pause_consumed
                                && options.pause_before_step.as_deref() == Some(step_id)
                            {
                                pause_consumed = true;
                                thread::sleep(Duration::from_secs(300));
                            }
                            let attempt = entry.attempt.expect("a step start has an attempt");
                            let admitted =
                                if step.step_type() == relayflowd_core::StepType::Deterministic {
                                    true
                                } else if let Some(dispatcher) = &self.dispatcher {
                                    dispatcher.reserve_dispatch(
                                        &state.run_id,
                                        step,
                                        attempt,
                                        &Self::dispatch_required_pins(&state, step),
                                    )?
                                } else {
                                    false
                                };
                            if !admitted {
                                // Admission is per pair. A lane with no
                                // compatible worker remains Runnable, while
                                // later independent lanes still get their
                                // journal-first handoff.
                                skipped_dispatches.insert((step_id.to_owned(), attempt));
                                backpressured = true;
                                continue;
                            }
                        }
                        let prepared = (|| -> Result<()> {
                            self.prepare_start_entry(&state, &mut entry)?;
                            self.assign_executor(&state, &mut entry)?;
                            self.route_start(&mut journal, &state, &mut entry)?;
                            self.append(&mut journal, &entry)?;
                            Ok(())
                        })();
                        if let Err(error) = prepared {
                            if let (Some(dispatcher), Some(step_id), Some(attempt)) = (
                                self.dispatcher.as_ref(),
                                entry.step_id.as_deref(),
                                entry.attempt,
                            ) {
                                dispatcher.release_dispatch_reservation(
                                    &state.run_id,
                                    step_id,
                                    attempt,
                                );
                            }
                            return Err(error);
                        }
                    }
                    Action::ExecDeterministic { step, attempt } => {
                        if !self.ensure_step_memory(&mut journal, &step, attempt)? {
                            continue;
                        }
                        let started = self.load_state(&journal, spec.clone())?;
                        let runtime = &started.steps[&step.id];
                        let workspace = started
                            .routing
                            .get(&step.id)
                            .and_then(|r| r.workspace.as_deref());
                        let mut result = exec_det::execute_placed(
                            &step,
                            runtime.memory.as_ref(),
                            workspace.map(std::path::Path::new),
                        );
                        if let Some(path) = workspace {
                            match crate::workspace::pin(std::path::Path::new(path)) {
                                Ok(pin) => {
                                    result.end_pins = Some(relayflowd_core::Pins {
                                        workspace: vec![pin],
                                        streams: vec![],
                                    })
                                }
                                Err(error) => {
                                    result.failure_reason = Some(CompletionReason::WorkerError);
                                    result.failure_detail = Some(error.to_string());
                                }
                            }
                        }
                        let semantic_executions = state.steps[&step.id].semantic_executions;
                        for action in completion_actions(
                            journal.run_id(),
                            &step,
                            attempt,
                            semantic_executions,
                            result,
                            self.clock.now_ms(),
                        ) {
                            self.interpret_non_execution(&mut journal, action)?;
                        }
                        let completed = self.load_state(&journal, spec.clone())?;
                        if options.stop_after.is_some_and(|limit| {
                            completed
                                .completed_steps()
                                .saturating_sub(initial_completed)
                                >= limit
                        }) {
                            self.registry()?
                                .set_status(&completed.run_id, "interrupted", None)?;
                            return Ok(parked_outcome(&completed, RunStatus::Interrupted));
                        }
                    }
                    Action::Dispatch {
                        step,
                        attempt,
                        worker_class,
                        lease_id,
                        idempotency_key,
                        lease_deadline_ms,
                        pins: _,
                        recovery,
                    } => {
                        if skipped_dispatches.remove(&(step.id.clone(), attempt)) {
                            continue;
                        }
                        let injection = self.ensure_step_memory(&mut journal, &step, attempt);
                        if !matches!(injection, Ok(true)) {
                            if let Some(dispatcher) = &self.dispatcher {
                                dispatcher.release_dispatch_reservation(
                                    &state.run_id,
                                    &step.id,
                                    attempt,
                                );
                            }
                            injection?;
                            continue;
                        }
                        let started_state = self.load_state(&journal, spec.clone())?;
                        let pins = started_state.steps[&step.id]
                            .last_start_pins
                            .clone()
                            .unwrap_or_default();
                        let outcome = self
                            .dispatcher
                            .as_ref()
                            .map(|dispatcher| {
                                dispatcher.dispatch(StepDispatch {
                                    run_id: state.run_id.clone(),
                                    step_id: step.id.clone(),
                                    attempt,
                                    step_type: worker_class,
                                    spec: step.clone(),
                                    memory: started_state.steps[&step.id].memory.clone(),
                                    lease_id,
                                    idempotency_key,
                                    pins,
                                    routing: started_state.routing.get(&step.id).context("dispatch has no journaled route")?.clone(),
                                    wake_context: resolve_wake_context(&journal)?,
                                    recovery,
                                    lease_deadline_ms,
                                })
                            })
                            .transpose();
                        let outcome = match outcome {
                            Ok(Some(outcome)) => outcome,
                            Ok(None) => DispatchOutcome::NoWorker,
                            Err(error) => {
                                if let Some(dispatcher) = &self.dispatcher {
                                    dispatcher.release_dispatch_reservation(
                                        &state.run_id,
                                        &step.id,
                                        attempt,
                                    );
                                }
                                return Err(error);
                            }
                        };
                        match outcome {
                            DispatchOutcome::Dispatched => {
                                // Record operational backpressure after each
                                // handoff. If the driver crashes before the
                                // rest of the batch, the durable start entry
                                // and this wake deadline still describe the
                                // lease already handed out.
                                self.registry()?.set_status(
                                    &state.run_id,
                                    "waiting_worker",
                                    Some(lease_deadline_ms),
                                )?;
                                dispatched = true;
                            }
                            DispatchOutcome::NoWorker => {
                                if let Some(dispatcher) = &self.dispatcher {
                                    dispatcher.release_dispatch_reservation(
                                        &state.run_id,
                                        &step.id,
                                        attempt,
                                    );
                                }
                                // Preflight admitted the whole batch, so this
                                // is a detach race. Explain the unhanded lease
                                // as crashed, leave it retryable, and continue:
                                // one lost worker must not discard later batch
                                // actions that another worker can honor.
                                for action in abandonment_actions(
                                    &started_state,
                                    &step.id,
                                    attempt,
                                    CompletionReason::Crashed,
                                    self.clock.now_ms(),
                                ) {
                                    self.persist_only(&mut journal, action)?;
                                }
                                backpressured = true;
                                handoff_failed = true;
                            }
                            DispatchOutcome::PinMismatch { detail } => {
                                if let Some(dispatcher) = &self.dispatcher {
                                    dispatcher.release_dispatch_reservation(
                                        &state.run_id,
                                        &step.id,
                                        attempt,
                                    );
                                }
                                // Appendix A rule 2: a worker standing at
                                // revisions other than the journaled pins
                                // fails closed. Continue the batch so an
                                // independent compatible lane is not dropped.
                                self.fail_dispatch_closed(
                                    &mut journal,
                                    &started_state,
                                    &step,
                                    attempt,
                                    detail,
                                )?;
                                handoff_failed = true;
                            }
                        }
                    }
                    Action::ArmTimer { at_ms } => {
                        self.wait_for_timer(&journal, at_ms)?;
                        break;
                    }
                    Action::CompleteRun { reason } => {
                        self.registry()?.set_status(
                            journal.run_id(),
                            if reason == RunCompletionReason::Success {
                                "completed"
                            } else {
                                "failed"
                            },
                            None,
                        )?;
                        let final_state = self.load_state(&journal, spec.clone())?;
                        return Ok(outcome_from_state(&final_state, reason));
                    }
                }
            }
            if !dispatched && handoff_failed && !failed_batch_redriven {
                // A whole batch can lose admission between preflight and
                // handoff. Re-fold once so due retries can reach a compatible
                // replacement already attached. Bound this to one failed
                // batch: a dispatcher that keeps racing closed must park
                // instead of spinning forever.
                failed_batch_redriven = true;
                continue;
            }
            if dispatched || backpressured {
                let parked = self.load_state(&journal, spec.clone())?;
                self.park_idle_run(&parked)?;
                return Ok(parked_outcome(&parked, RunStatus::Parked));
            }
        }
    }

    /// Journal a dispatch that could not be honored as a declared `worker_error`
    /// completion of the attempt. It runs through the same completion path as
    /// any other rejected attempt, so retry policy and the failure taxonomy
    /// hold: the step retries against whatever a worker actually reports, and
    /// exhausting `max_iterations` ends the run with a declared reason rather
    /// than an expired lease nobody explained.
    fn fail_dispatch_closed(
        &self,
        journal: &mut SqliteJournal,
        state: &RunState,
        step: &relayflowd_core::StepSpec,
        attempt: u32,
        detail: String,
    ) -> Result<()> {
        let mut result = AttemptResult::successful(serde_json::Value::Null, "kernel");
        result.failure_reason = Some(CompletionReason::WorkerError);
        result.failure_detail = Some(format!(
            "attempt was not dispatched: the attached worker does not hold its starting pins ({detail})"
        ));
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
        Ok(())
    }

    pub(super) fn interpret_non_execution(
        &self,
        journal: &mut SqliteJournal,
        action: Action,
    ) -> Result<()> {
        match action {
            Action::Append(entry) => {
                self.append(journal, &entry)?;
            }
            Action::ArmTimer { at_ms } => self.wait_for_timer(journal, at_ms)?,
            _ => bail!("completion emitted an invalid execution action"),
        }
        Ok(())
    }

    pub(super) fn persist_only(&self, journal: &mut SqliteJournal, action: Action) -> Result<()> {
        match action {
            Action::Append(entry) => {
                self.append(journal, &entry)?;
                Ok(())
            }
            _ => bail!("recovery emitted a non-journal action"),
        }
    }

    fn wait_for_timer(&self, journal: &SqliteJournal, at_ms: i64) -> Result<()> {
        self.registry()?
            .set_status(journal.run_id(), "sleeping", Some(at_ms))?;
        let remaining = at_ms.saturating_sub(self.clock.now_ms());
        if remaining > 0 {
            thread::sleep(Duration::from_millis(remaining as u64));
        }
        self.registry()?
            .set_status(journal.run_id(), "running", None)?;
        Ok(())
    }

    fn park_idle_run(&self, state: &RunState) -> Result<()> {
        let active_lease = state
            .spec
            .steps
            .iter()
            .filter_map(|step| match state.steps[&step.id].state {
                relayflowd_core::StepState::Running {
                    attempt,
                    lease_deadline_ms,
                    ..
                } if step.step_type() != relayflowd_core::StepType::Deterministic => Some(
                    self.dispatcher
                        .as_ref()
                        .and_then(|dispatcher| {
                            dispatcher.active_lease_deadline(&state.run_id, &step.id, attempt)
                        })
                        .unwrap_or(lease_deadline_ms),
                ),
                _ => None,
            })
            .min();
        match active_lease {
            Some(deadline_ms) => {
                self.registry()?
                    .set_status(&state.run_id, "waiting_worker", Some(deadline_ms))?
            }
            None => self.registry()?.set_status(&state.run_id, "parked", None)?,
        }
        Ok(())
    }
}

fn parked_outcome(state: &RunState, status: RunStatus) -> RunOutcome {
    RunOutcome {
        run_id: state.run_id.clone(),
        status,
        completion_reason: None,
        completed_steps: state.completed_steps(),
    }
}

/// Resolve the `wake_context` a dispatch must carry.
///
/// The previous form was `journal.scan_from(..).ok().and_then(..)`, which
/// collapsed two very different outcomes into `None`:
///
/// - the run was never woken by an event, which is legitimate; and
/// - the journal could not be read, which is a resolution failure.
///
/// Silently substituting `None` for the second dispatches the step as though it
/// had never been woken — the agent then runs without the event that justified
/// waking it, and nothing in the journal says so.
///
/// **What this change actually does, precisely.** The error propagates out of
/// the dispatch closure into the existing `Err` arm, which releases the dispatch
/// reservation and returns from `drive`. That is an abort *before* dispatch, not
/// a recorded attempt failure: no `completion_actions` run, nothing is journaled
/// for the attempt, and no retry is scheduled here. Recovery arrives later by
/// the ordinary route — the lease expires and a subsequent drive abandons the
/// attempt via `abandonment_actions(.., Crashed)`.
///
/// That is deliberately narrower than the eventual contract. The intended
/// end state classifies the failure and journals it (transient → retry the
/// attempt under its budget; permanent → park `needs_human`), and none of that
/// classification exists yet. This function only stops the step from silently
/// running as un-woken; it does not implement the classification.
///
/// A clean scan that finds no `subscription.matched` entry returns `Ok(None)` —
/// the legitimate "never woken" case. Note this is *not* the only path to
/// `None`: an entry present with no `wake_context` key also yields `None`, which
/// is the same shape as never-woken and cannot currently be told apart.
///
/// The "carry-forward missing" case is likewise not detectable here: it needs an
/// epoch-summary carry-forward that does not exist, so a run whose match entry
/// is unreachable is indistinguishable from one never woken. This reports the
/// conservative `Ok(None)` rather than inventing a distinction the journal
/// cannot support.
fn resolve_wake_context(journal: &SqliteJournal) -> Result<Option<serde_json::Value>> {
    let entries = journal
        .scan_from(1, usize::MAX)
        .context("resolve wake_context: journal scan failed")?;
    Ok(entries
        .into_iter()
        .find(|entry| entry.entry_type == relayflowd_core::EntryType::SubscriptionMatched)
        .and_then(|entry| entry.payload.get("wake_context").cloned()))
}
