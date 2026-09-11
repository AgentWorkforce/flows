use std::collections::BTreeMap;

use serde_json::Value;
use thiserror::Error;

use crate::{
    entry::{
        Budget, CompletionReason, Disposition, EntryType, EpochSummaryPayload, JournalEntry, Pins,
        RunCancelRequestedPayload, RunCompletedPayload, RunCompletionReason, SleepUntilPayload,
        StepCompletedPayload, WaitCompletedPayload, WaitCompletionReason,
    },
    spec::{RunSpec, StepKind},
};

mod budget;
#[cfg(test)]
use budget::add_budget;
mod memory;
mod pins;
mod routing;

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
    /// Highest attempt number observed (crashed and completed alike).
    pub attempts: u32,
    /// Completed *semantic* executions — attempts that finished and produced
    /// a verifiable result. Crashed/lease-expired attempts died without a
    /// result, so they do not count; `max_iterations` bounds this counter,
    /// never the raw attempt number.
    pub semantic_executions: u32,
    /// Agent recovery facts retained across the retry backoff. They are
    /// reconstructed solely from journal entries on every resume.
    pub last_start_pins: Option<Pins>,
    pub last_end_pins: Option<Pins>,
    pub last_completion_reason: Option<CompletionReason>,
    pub trajectory_tail: Option<Value>,
    pub memory: Option<crate::MemoryInjectedPayload>,
}

#[derive(Debug, Clone)]
pub struct RunState {
    pub run_id: String,
    pub spec: RunSpec,
    pub steps: BTreeMap<String, StepRuntime>,
    pub memo: BTreeMap<String, Value>,
    pub budget: Budget,
    pub wallclock_ms: u64,
    pub budget_day: Option<i64>,
    pub daily_budget: Budget,
    pub daily_wallclock_ms: u64,
    pub completion: Option<RunCompletionReason>,
    /// Durable cancellation intent. Once present, scheduling can only close
    /// live work and append the terminal canceled fact.
    pub cancel_requested: Option<RunCancelRequestedPayload>,
    /// Appendix A rule 6 chain head: the last successful agent completion.
    pub current_pins: Option<Pins>,
    pub routing: BTreeMap<String, crate::RoutingDecision>,
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
                            semantic_executions: 0,
                            last_start_pins: None,
                            last_end_pins: None,
                            last_completion_reason: None,
                            trajectory_tail: None,
                            memory: None,
                        },
                    )
                })
                .collect(),
            spec,
            memo: BTreeMap::new(),
            budget: Budget::default(),
            wallclock_ms: 0,
            budget_day: None,
            daily_budget: Budget::default(),
            daily_wallclock_ms: 0,
            completion: None,
            cancel_requested: None,
            current_pins: None,
            routing: BTreeMap::new(),
        };

        if let Some(prior) = state
            .spec
            .budget
            .as_ref()
            .and_then(|b| b.prior_spend.as_ref())
        {
            state.budget = Budget {
                tokens_in: prior.tokens_in,
                tokens_out: prior.tokens_out,
                dollars: prior.dollars.clone(),
            };
            state.wallclock_ms = prior.wallclock_ms;
            state.budget_day = prior.day;
            state.daily_budget = state.budget.clone();
            state.daily_wallclock_ms = prior.wallclock_ms;
        }
        for entry in entries {
            if entry.run_id != state.run_id {
                return Err(StateError::WrongRun(entry.run_id.clone()));
            }
            if state.completion.is_some() {
                return Err(StateError::EntryAfterRunCompleted { seq: entry.seq });
            }
            match entry.entry_type {
                EntryType::EpochSummary => state.apply_epoch(entry)?,
                EntryType::StepRouted => state.apply_routing(entry)?,
                EntryType::StepAttemptStarted => {
                    let payload: crate::entry::AttemptStartedPayload = decode(entry)?;
                    state.validate_start_pins(entry, &payload)?;
                    let step = state.step_mut(entry)?;
                    let attempt = entry.attempt.ok_or(StateError::MissingAttempt(entry.seq))?;
                    step.attempts = step.attempts.max(attempt);
                    step.state = StepState::Running {
                        attempt,
                        lease_deadline_ms: payload.lease_deadline_ms,
                        idempotency_key: payload.idempotency_key,
                    };
                    step.last_start_pins = Some(payload.pins);
                }
                EntryType::MemoryInjected => state.apply_memory_injected(entry)?,
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
                EntryType::RunCancelRequested => {
                    state.cancel_requested = Some(decode(entry)?);
                }
                EntryType::RunSpawned
                | EntryType::EventReceived
                | EntryType::SubscriptionRegistered
                | EntryType::SubscriptionMatched
                // SubscriptionStale is an observability event about the
                // trigger PLANE, not a state transition inside this run's
                // state machine — it never affects run/step state, so state
                // folding ignores it here.
                | EntryType::SubscriptionStale
                | EntryType::ChannelAppended
                | EntryType::ChannelDelivered
                | EntryType::ChannelAcknowledged
                | EntryType::StreamAppended
                | EntryType::EffectRecorded
                | EntryType::EffectConfirmed
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
        self.charge_budget(
            &payload.budget,
            entry.payload["spend"]["wallclock_ms"].as_u64().unwrap_or(0),
            entry.at_ms,
        )?;
        let step_id = entry
            .step_id
            .clone()
            .ok_or(StateError::MissingStep(entry.seq))?;
        let is_agent = matches!(
            self.spec.step(&step_id).map(|step| &step.kind),
            Some(StepKind::Agent { .. })
        );
        if is_agent
            && payload.disposition == Disposition::StepDone
            && payload.completion_reason == CompletionReason::Success
            && payload.end_pins.is_none()
        {
            return Err(StateError::MissingEndPins(step_id));
        }
        let step = self
            .steps
            .get_mut(&step_id)
            .ok_or_else(|| StateError::UnknownStep(step_id.clone()))?;
        let attempt = entry.attempt.ok_or(StateError::MissingAttempt(entry.seq))?;
        step.attempts = step.attempts.max(attempt);
        if is_agent {
            step.last_end_pins = payload.end_pins.clone();
            step.last_completion_reason = Some(payload.completion_reason);
            step.trajectory_tail = payload.trajectory_tail.clone();
        }
        if !matches!(
            payload.completion_reason,
            CompletionReason::Crashed | CompletionReason::LeaseExpired
        ) {
            // The attempt ran to completion and produced a result the gate
            // could judge; only these consume `max_iterations` allowance.
            step.semantic_executions = step.semantic_executions.saturating_add(1);
        }
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
            if is_agent
                || matches!(
                    self.spec.step(&step_id).map(|s| &s.kind),
                    Some(StepKind::Deterministic { .. })
                )
            {
                self.current_pins =
                    pins::chain_forward(self.current_pins.take(), payload.end_pins.clone());
            }
            self.memo.insert(step_id, payload.output);
        }
        Ok(())
    }

    fn apply_epoch(&mut self, entry: &JournalEntry) -> Result<(), StateError> {
        let payload: EpochSummaryPayload = decode(entry)?;
        self.validate_routing(&payload.routing)?;
        self.routing = payload.routing;
        self.memo.clear();
        if self.spec.budget.is_some() && self.budget_day.is_some() && self.budget != payload.budget_spent {
            return Err(StateError::BudgetSummaryMismatch);
        }
        self.budget = payload.budget_spent;
        for runtime in self.steps.values_mut() {
            *runtime = StepRuntime {
                state: StepState::Pending,
                attempts: 0,
                semantic_executions: 0,
                last_start_pins: None,
                last_end_pins: None,
                last_completion_reason: None,
                trajectory_tail: None,
                memory: None,
            };
        }
        // No epoch writer populates `pinned_revisions` yet, and a workspace-only
        // reconstruction would silently drop stream pins and break the very chain
        // `validate_start_pins` enforces. Until epochs carry full pins, an epoch
        // resets the chain head rather than half-restoring it.
        self.current_pins = None;
        for (id, memory) in payload.memory {
            self.validate_memory_payload(&id, &memory)?;
            self.steps
                .get_mut(&id)
                .ok_or_else(|| StateError::UnknownStep(id.clone()))?
                .memory = Some(memory);
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
            // The epoch summary predates the semantic counter; assume every
            // prior attempt was semantic. Conservative: a squashed journal can
            // grant fewer iterations than the live one, never more.
            step.semantic_executions = open.attempt.saturating_sub(1);
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

#[derive(Debug, Error)]
pub enum StateError {
    #[error("invalid routing decision for step {step}: {detail}")]
    InvalidRouting { step: String, detail: String },
    #[error("invalid memory fact for step {step}: {detail}")]
    InvalidMemory { step: String, detail: String },
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
    #[error("journal entry {seq} appears after terminal run.completed")]
    EntryAfterRunCompleted { seq: i64 },
    #[error("agent step {0} completed successfully without end pins")]
    MissingEndPins(String),
    #[error(
        "agent step {step} broke its pin chain from {chain_source}: expected {expected:?}, got {actual:?}"
    )]
    BrokenPinChain {
        step: String,
        chain_source: String,
        expected: Box<Pins>,
        actual: Box<Pins>,
    },
    #[error("invalid payload at journal sequence {seq}: {source}")]
    Payload {
        seq: i64,
        #[source]
        source: serde_json::Error,
    },
    #[error("invalid non-negative decimal dollar amount {0:?}")]
    InvalidDollars(String),
    #[error("epoch budget differs from recorded spend")]
    BudgetSummaryMismatch,
    #[error("budget token total overflow")]
    BudgetOverflow,
}

#[cfg(test)]
mod tests;
