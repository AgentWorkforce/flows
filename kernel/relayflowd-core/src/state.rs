use std::collections::BTreeMap;

use serde_json::Value;
use thiserror::Error;

use crate::{
    entry::{
        Budget, CompletionReason, Disposition, EntryType, EpochSummaryPayload, JournalEntry,
        RunCompletedPayload, RunCompletionReason, SleepUntilPayload, StepCompletedPayload,
        WaitCompletedPayload, WaitCompletionReason,
    },
    spec::RunSpec,
};

#[derive(Debug, Clone, PartialEq)]
pub enum StepState {
    Pending,
    Runnable,
    Running {
        attempt: u32,
        lease_deadline_ms: i64,
        idempotency_key: String,
    },
    Backoff {
        attempt: u32,
        wake_at_ms: i64,
    },
    Waiting {
        wait_id: String,
    },
    NeedsHuman {
        wait_id: String,
    },
    Done {
        completion_reason: CompletionReason,
        output: Value,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct StepRuntime {
    pub state: StepState,
    pub attempts: u32,
}

#[derive(Debug, Clone)]
pub struct RunState {
    pub run_id: String,
    pub spec: RunSpec,
    pub steps: BTreeMap<String, StepRuntime>,
    pub memo: BTreeMap<String, Value>,
    pub budget: Budget,
    pub completion: Option<RunCompletionReason>,
}

impl RunState {
    pub fn fold(
        run_id: impl Into<String>,
        spec: RunSpec,
        entries: &[JournalEntry],
    ) -> Result<Self, StateError> {
        spec.validate()?;
        let run_id = run_id.into();
        let mut state = Self {
            run_id,
            steps: spec
                .steps
                .iter()
                .map(|step| {
                    (
                        step.id.clone(),
                        StepRuntime {
                            state: StepState::Pending,
                            attempts: 0,
                        },
                    )
                })
                .collect(),
            spec,
            memo: BTreeMap::new(),
            budget: Budget::default(),
            completion: None,
        };

        for entry in entries {
            if entry.run_id != state.run_id {
                return Err(StateError::WrongRun(entry.run_id.clone()));
            }
            match entry.entry_type {
                EntryType::EpochSummary => state.apply_epoch(entry)?,
                EntryType::StepAttemptStarted => {
                    let payload: crate::entry::AttemptStartedPayload = decode(entry)?;
                    let step = state.step_mut(entry)?;
                    let attempt = entry.attempt.ok_or(StateError::MissingAttempt(entry.seq))?;
                    step.attempts = step.attempts.max(attempt);
                    step.state = StepState::Running {
                        attempt,
                        lease_deadline_ms: payload.lease_deadline_ms,
                        idempotency_key: payload.idempotency_key,
                    };
                }
                EntryType::StepCompleted => state.apply_step_completed(entry)?,
                EntryType::SleepUntil => {
                    let payload: SleepUntilPayload = decode(entry)?;
                    let step = state.step_mut(entry)?;
                    step.state = StepState::Backoff {
                        attempt: entry.attempt.unwrap_or(step.attempts),
                        wake_at_ms: payload.wake_at_ms,
                    };
                }
                EntryType::WaitEvent => {
                    let payload: crate::entry::WaitEventPayload = decode(entry)?;
                    state.step_mut(entry)?.state = StepState::Waiting {
                        wait_id: payload.wait_id,
                    };
                }
                EntryType::WaitHuman => {
                    let payload: crate::entry::WaitHumanPayload = decode(entry)?;
                    state.step_mut(entry)?.state = StepState::NeedsHuman {
                        wait_id: payload.wait_id,
                    };
                }
                EntryType::WaitCompleted => {
                    let payload: WaitCompletedPayload = decode(entry)?;
                    let step = state.step_mut(entry)?;
                    step.state = if payload.completion_reason == WaitCompletionReason::Canceled {
                        StepState::Done {
                            completion_reason: CompletionReason::Canceled,
                            output: Value::Null,
                        }
                    } else {
                        StepState::Runnable
                    };
                }
                EntryType::RunCompleted => {
                    let payload: RunCompletedPayload = decode(entry)?;
                    state.completion = Some(payload.completion_reason);
                }
                EntryType::RunSpawned
                | EntryType::StreamAppended
                | EntryType::EffectRecorded
                | EntryType::SegmentClosed => {}
            }
        }
        state.refresh_runnable();
        Ok(state)
    }

    pub fn successful_output(&self, step_id: &str) -> Option<&Value> {
        self.memo.get(step_id)
    }

    pub fn completed_steps(&self) -> usize {
        self.steps
            .values()
            .filter(|step| matches!(step.state, StepState::Done { .. }))
            .count()
    }

    pub fn failed_step(&self) -> Option<&str> {
        self.spec.steps.iter().find_map(|spec| {
            let runtime = self.steps.get(&spec.id)?;
            match runtime.state {
                StepState::Done {
                    completion_reason: CompletionReason::Success,
                    ..
                } => None,
                StepState::Done { .. } => Some(spec.id.as_str()),
                _ => None,
            }
        })
    }

    pub fn all_steps_succeeded(&self) -> bool {
        self.steps.values().all(|step| {
            matches!(
                step.state,
                StepState::Done {
                    completion_reason: CompletionReason::Success,
                    ..
                }
            )
        })
    }

    fn step_mut(&mut self, entry: &JournalEntry) -> Result<&mut StepRuntime, StateError> {
        let id = entry
            .step_id
            .as_deref()
            .ok_or(StateError::MissingStep(entry.seq))?;
        self.steps
            .get_mut(id)
            .ok_or_else(|| StateError::UnknownStep(id.to_owned()))
    }

    fn apply_step_completed(&mut self, entry: &JournalEntry) -> Result<(), StateError> {
        let payload: StepCompletedPayload = decode(entry)?;
        add_budget(&mut self.budget, &payload.budget)?;
        let step_id = entry
            .step_id
            .clone()
            .ok_or(StateError::MissingStep(entry.seq))?;
        let step = self
            .steps
            .get_mut(&step_id)
            .ok_or_else(|| StateError::UnknownStep(step_id.clone()))?;
        let attempt = entry.attempt.ok_or(StateError::MissingAttempt(entry.seq))?;
        step.attempts = step.attempts.max(attempt);
        step.state = match payload.disposition {
            Disposition::StepDone => StepState::Done {
                completion_reason: payload.completion_reason,
                output: payload.output.clone(),
            },
            Disposition::Retry => StepState::Backoff {
                attempt,
                wake_at_ms: payload.next_attempt_at_ms.unwrap_or(entry.at_ms),
            },
            Disposition::Park => StepState::NeedsHuman {
                wait_id: format!("park-{step_id}-{attempt}"),
            },
        };
        if payload.disposition == Disposition::StepDone
            && payload.completion_reason == CompletionReason::Success
        {
            self.memo.insert(step_id, payload.output);
        }
        Ok(())
    }

    fn apply_epoch(&mut self, entry: &JournalEntry) -> Result<(), StateError> {
        let payload: EpochSummaryPayload = decode(entry)?;
        self.memo.clear();
        self.budget = payload.budget_spent;
        for runtime in self.steps.values_mut() {
            *runtime = StepRuntime {
                state: StepState::Pending,
                attempts: 0,
            };
        }
        for (id, done) in payload.steps_done {
            let step = self
                .steps
                .get_mut(&id)
                .ok_or_else(|| StateError::UnknownStep(id.clone()))?;
            step.state = StepState::Done {
                completion_reason: done.completion_reason,
                output: done.output.clone(),
            };
            if done.completion_reason == CompletionReason::Success {
                self.memo.insert(id, done.output);
            }
        }
        for (id, open) in payload.steps_open {
            let step = self
                .steps
                .get_mut(&id)
                .ok_or_else(|| StateError::UnknownStep(id.clone()))?;
            step.attempts = open.attempt;
            step.state = match open.state.as_str() {
                "running" => StepState::Running {
                    attempt: open.attempt,
                    lease_deadline_ms: open.lease_deadline_ms.unwrap_or(entry.at_ms),
                    // The key is deterministic in (run_id, step_id), so an
                    // epoch summary that predates the field still restores it.
                    idempotency_key: open
                        .idempotency_key
                        .clone()
                        .unwrap_or_else(|| crate::machine::idempotency_key(&self.run_id, &id)),
                },
                "backoff" => StepState::Backoff {
                    attempt: open.attempt,
                    wake_at_ms: open.wake_at_ms.unwrap_or(entry.at_ms),
                },
                "needs_human" => StepState::NeedsHuman {
                    wait_id: format!("epoch-{}-{id}", payload.epoch),
                },
                _ => StepState::Pending,
            };
        }
        Ok(())
    }

    fn refresh_runnable(&mut self) {
        for step in &self.spec.steps {
            let is_pending = self
                .steps
                .get(&step.id)
                .is_some_and(|runtime| runtime.state == StepState::Pending);
            if !is_pending {
                continue;
            }
            let dependencies_done = step.depends_on.iter().all(|dependency| {
                self.steps.get(dependency).is_some_and(|runtime| {
                    matches!(
                        runtime.state,
                        StepState::Done {
                            completion_reason: CompletionReason::Success,
                            ..
                        }
                    )
                })
            });
            if dependencies_done {
                self.steps.get_mut(&step.id).expect("known step").state = StepState::Runnable;
            }
        }
    }
}

fn decode<T: serde::de::DeserializeOwned>(entry: &JournalEntry) -> Result<T, StateError> {
    serde_json::from_value(entry.payload.clone()).map_err(|source| StateError::Payload {
        seq: entry.seq,
        source,
    })
}

fn add_budget(total: &mut Budget, value: &Budget) -> Result<(), StateError> {
    total.tokens_in = total.tokens_in.saturating_add(value.tokens_in);
    total.tokens_out = total.tokens_out.saturating_add(value.tokens_out);
    total.dollars = add_decimal_strings(&total.dollars, &value.dollars)?;
    Ok(())
}

fn add_decimal_strings(left: &str, right: &str) -> Result<String, StateError> {
    fn parts(value: &str) -> Result<(u128, usize), StateError> {
        let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
        if whole.is_empty()
            || !whole.bytes().all(|byte| byte.is_ascii_digit())
            || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(StateError::InvalidDollars(value.to_owned()));
        }
        let digits = format!("{whole}{fraction}")
            .parse::<u128>()
            .map_err(|_| StateError::InvalidDollars(value.to_owned()))?;
        Ok((digits, fraction.len()))
    }
    let (left_value, left_scale) = parts(left)?;
    let (right_value, right_scale) = parts(right)?;
    let scale = left_scale.max(right_scale);
    let scaled_left =
        left_value.saturating_mul(10_u128.saturating_pow((scale - left_scale) as u32));
    let scaled_right =
        right_value.saturating_mul(10_u128.saturating_pow((scale - right_scale) as u32));
    let sum = scaled_left.saturating_add(scaled_right);
    if scale == 0 {
        return Ok(sum.to_string());
    }
    let divisor = 10_u128.saturating_pow(scale as u32);
    let fraction = format!("{:0scale$}", sum % divisor, scale = scale);
    Ok(format!("{}.{fraction}", sum / divisor)
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_owned())
}

#[derive(Debug, Error)]
pub enum StateError {
    #[error(transparent)]
    InvalidSpec(#[from] crate::spec::SpecError),
    #[error("journal entry belongs to run {0}")]
    WrongRun(String),
    #[error("journal entry {0} has no step id")]
    MissingStep(i64),
    #[error("journal entry {0} has no attempt")]
    MissingAttempt(i64),
    #[error("journal references unknown step {0}")]
    UnknownStep(String),
    #[error("invalid payload at journal sequence {seq}: {source}")]
    Payload {
        seq: i64,
        #[source]
        source: serde_json::Error,
    },
    #[error("invalid non-negative decimal dollar amount {0:?}")]
    InvalidDollars(String),
}

#[cfg(test)]
mod tests;
