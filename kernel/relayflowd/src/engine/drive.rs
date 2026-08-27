use std::{thread, time::Duration};

use anyhow::{Result, bail};
use relayflowd_core::{
    Action, Clock, RunCompletionReason, RunSpec, RunState, completion_actions, next_actions,
};
use relayflowd_journal::SqliteJournal;

use super::{DriveOptions, Engine, RunOutcome, RunStatus, outcome_from_state};
use crate::{exec_det, worker::StepDispatch};

impl<C: Clock> Engine<C> {
    pub(super) fn drive(
        &self,
        mut journal: SqliteJournal,
        spec: RunSpec,
        options: DriveOptions,
    ) -> Result<RunOutcome> {
        let initial_completed = self.load_state(&journal, spec.clone())?.completed_steps();
        let mut pause_consumed = false;
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
            if !pause_consumed && should_pause(&state, &options) {
                pause_consumed = true;
                thread::sleep(Duration::from_secs(300));
            }
            // No worker can take the next out-of-band step: park. `parked` means
            // "nothing is coming until something changes"; `waiting_worker` means
            // "a worker holds this lease" and makes `resume` block for it. An
            // agent worker that cannot pin every surface the step declares is not
            // a compatible worker either — parking keeps the failure a declared
            // state instead of an untyped error raised after `run.start`.
            if let Some(step) = runnable_out_of_band_step(&state)
                && !self.step_is_dispatchable(&state, step)
            {
                self.registry()?.set_status(&state.run_id, "parked", None)?;
                return Ok(parked_outcome(&state, RunStatus::Parked));
            }

            let actions = next_actions(&state, self.clock.now_ms());
            if actions.is_empty() {
                self.park_idle_run(&state)?;
                return Ok(parked_outcome(&state, RunStatus::Parked));
            }
            for action in actions {
                match action {
                    Action::Append(mut entry) => {
                        self.prepare_start_entry(&state, &mut entry)?;
                        self.assign_executor(&mut entry)?;
                        self.append(&mut journal, &entry)?;
                    }
                    Action::ExecDeterministic { step, attempt } => {
                        let result = exec_det::execute(&step);
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
                        let started_state = self.load_state(&journal, spec.clone())?;
                        let pins = started_state.steps[&step.id]
                            .last_start_pins
                            .clone()
                            .unwrap_or_default();
                        let assigned = self
                            .dispatcher
                            .as_ref()
                            .map(|dispatcher| {
                                dispatcher.dispatch(StepDispatch {
                                    run_id: state.run_id.clone(),
                                    step_id: step.id.clone(),
                                    attempt,
                                    step_type: worker_class,
                                    spec: step,
                                    lease_id,
                                    idempotency_key,
                                    pins,
                                    recovery,
                                    lease_deadline_ms,
                                })
                            })
                            .transpose()?
                            .unwrap_or(false);
                        self.registry()?.set_status(
                            &state.run_id,
                            if assigned { "waiting_worker" } else { "parked" },
                            Some(lease_deadline_ms),
                        )?;
                        return Ok(parked_outcome(&state, RunStatus::Parked));
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
        }
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

    fn step_is_dispatchable(&self, state: &RunState, step: &relayflowd_core::StepSpec) -> bool {
        let step_type = step.step_type();
        let available = self
            .dispatcher
            .as_ref()
            .is_some_and(|dispatcher| dispatcher.available(step_type));
        if !available || step_type != relayflowd_core::StepType::Agent {
            return available;
        }
        self.agent_pins_available(state, step)
    }

    fn park_idle_run(&self, state: &RunState) -> Result<()> {
        let active_lease =
            state
                .spec
                .steps
                .iter()
                .find_map(|step| match state.steps[&step.id].state {
                    relayflowd_core::StepState::Running {
                        lease_deadline_ms, ..
                    } if step.step_type() != relayflowd_core::StepType::Deterministic => {
                        Some(lease_deadline_ms)
                    }
                    _ => None,
                });
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

/// The step `next_actions` will start next, when it needs an out-of-band
/// worker. `next_actions` starts at most one step per pass, so there is at most
/// one such step to preflight.
fn runnable_out_of_band_step(state: &RunState) -> Option<&relayflowd_core::StepSpec> {
    state.spec.steps.iter().find(|step| {
        matches!(
            state.steps[&step.id].state,
            relayflowd_core::StepState::Runnable
        ) && step.step_type() != relayflowd_core::StepType::Deterministic
    })
}

fn should_pause(state: &RunState, options: &DriveOptions) -> bool {
    if options.pause_before_completion && state.all_steps_succeeded() {
        return true;
    }
    let Some(step_id) = options.pause_before_step.as_deref() else {
        return false;
    };
    state.spec.steps.iter().find_map(|step| {
        matches!(
            state.steps[&step.id].state,
            relayflowd_core::StepState::Runnable
        )
        .then_some(step.id.as_str())
    }) == Some(step_id)
}
