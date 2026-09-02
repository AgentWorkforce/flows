use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use ulid::Ulid;

use crate::{
    entry::{
        AttemptStartedPayload, Budget, CompletionReason, Disposition, EffectRef, EntryType,
        JournalEntry, Pins, RunCompletedPayload, RunCompletionReason, SleepUntilPayload,
        StepCompletedPayload, WaitCompletedPayload, WaitCompletionReason,
    },
    retry::backoff_delay_ms,
    spec::{AgentSurfaces, RecoveryMode, StepKind, StepSpec, StepType},
    state::{RunState, StepState},
    verify::verify,
};

const LEASE_DURATION_MS: i64 = 30_000;

mod cancel;
use cancel::cancel_run_actions;
pub use cancel::request_cancel_action;

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Append(JournalEntry),
    ExecDeterministic {
        step: StepSpec,
        attempt: u32,
    },
    Dispatch {
        step: StepSpec,
        attempt: u32,
        worker_class: StepType,
        lease_id: String,
        idempotency_key: String,
        lease_deadline_ms: i64,
        pins: Pins,
        recovery: Option<RecoveryInstruction>,
    },
    ArmTimer {
        at_ms: i64,
    },
    CompleteRun {
        reason: RunCompletionReason,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct AttemptResult {
    pub output: Value,
    pub budget: Budget,
    pub completed_by: String,
    pub end_pins: Option<Pins>,
    pub effects: Vec<EffectRef>,
    pub trajectory_tail: Option<Value>,
    /// Execution failures bypass verification but still follow retry policy.
    pub failure_reason: Option<CompletionReason>,
    /// Why the attempt was rejected, in the vocabulary of whoever rejected it.
    /// A failed completion journals a null `output` — this is the only place a
    /// rejection can name its own cause, so a dropped detail is a lost error.
    pub failure_detail: Option<String>,
}

impl AttemptResult {
    pub fn successful(output: Value, completed_by: impl Into<String>) -> Self {
        Self {
            output,
            budget: Budget::default(),
            completed_by: completed_by.into(),
            end_pins: None,
            effects: Vec::new(),
            trajectory_tail: None,
            failure_reason: None,
            failure_detail: None,
        }
    }
}

/// Agent-only retry context carried to the worker. It is derived entirely
/// from journaled attempt facts, so a resume produces the same instruction.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecoveryInstruction {
    pub mode: RecoveryMode,
    pub restore_pins: Option<Pins>,
    pub previous_completion_reason: Option<CompletionReason>,
    pub trajectory_tail: Option<Value>,
}

pub fn next_actions(state: &RunState, now_ms: i64) -> Vec<Action> {
    if state.completion.is_some() {
        return Vec::new();
    }
    if state.cancel_requested.is_some() {
        return cancel_run_actions(state, now_ms);
    }
    if let Some(failed_step_id) = state.failed_step() {
        return complete_run_actions(
            state,
            RunCompletionReason::StepFailed,
            Some(failed_step_id.to_owned()),
            now_ms,
        );
    }
    if state.all_steps_succeeded() {
        return complete_run_actions(state, RunCompletionReason::Success, None, now_ms);
    }

    // A fold marks every dependency-free step Runnable at once. Preserve the
    // authored spec order while emitting every journal-first start pair from
    // that one state snapshot; dependencies unlocked by these executions are
    // considered only after their completions are folded on the next pass.
    let starts = state
        .spec
        .steps
        .iter()
        .filter_map(|spec| {
            let runtime = &state.steps[&spec.id];
            (runtime.state == StepState::Runnable).then_some((spec, runtime))
        })
        .flat_map(|(spec, runtime)| start_actions(state, spec, runtime.attempts + 1, now_ms))
        .collect::<Vec<_>>();
    if !starts.is_empty() {
        return starts;
    }

    let mut timers = Vec::new();
    for spec in &state.spec.steps {
        let runtime = &state.steps[&spec.id];
        match runtime.state {
            StepState::Backoff {
                attempt,
                wake_at_ms,
            } if wake_at_ms <= now_ms => {
                return vec![Action::Append(JournalEntry::new(
                    EntryType::WaitCompleted,
                    state.run_id.clone(),
                    Some(spec.id.clone()),
                    Some(attempt),
                    now_ms,
                    WaitCompletedPayload {
                        wait_id: retry_wait_id(&state.run_id, &spec.id, attempt, wake_at_ms),
                        completion_reason: WaitCompletionReason::TimerFired,
                        result: Value::Null,
                    },
                ))];
            }
            StepState::Backoff { wake_at_ms, .. } => {
                timers.push(Action::ArmTimer { at_ms: wake_at_ms });
            }
            _ => {}
        }
    }
    timers.sort_by_key(|action| match action {
        Action::ArmTimer { at_ms } => *at_ms,
        _ => unreachable!("the timer collection contains only timers"),
    });
    timers
}

/// Appendix A rule 6 chains pins **per surface**: a surface this step declares
/// that the run has already pinned carries that revision forward. Surfaces the
/// chain has never produced are deliberately left out — the dispatcher sources
/// those from the worker at start (rule 2). Consecutive agent steps therefore
/// need not declare the same surface set.
/// The per-surface chain carry for a step, for hosts that must resolve the
/// worker-sourced gaps before the start entry is journaled. Non-agent steps
/// carry no pins.
pub fn carried_pins_for(chain: Option<&Pins>, step: &StepSpec) -> Pins {
    match &step.kind {
        StepKind::Agent { surfaces, .. } => carried_pins(chain, surfaces),
        _ => Pins::default(),
    }
}

pub(crate) fn carried_pins(chain: Option<&Pins>, surfaces: &AgentSurfaces) -> Pins {
    let Some(chain) = chain else {
        return Pins::default();
    };
    Pins {
        workspace: surfaces
            .workspace
            .iter()
            .filter_map(|declared| {
                chain
                    .workspace
                    .iter()
                    .find(|pin| pin.surface == declared.surface)
                    .cloned()
            })
            .collect(),
        streams: surfaces
            .streams
            .iter()
            .filter_map(|declared| {
                chain
                    .streams
                    .iter()
                    .find(|pin| pin.stream == declared.stream)
                    .cloned()
            })
            .collect(),
    }
}

fn start_actions(state: &RunState, step: &StepSpec, attempt: u32, now_ms: i64) -> Vec<Action> {
    let key = idempotency_key(&state.run_id, &step.id);
    let recovery_mode = match &step.kind {
        StepKind::Agent { recovery_mode, .. } => Some(*recovery_mode),
        _ => None,
    };
    let runtime = &state.steps[&step.id];
    let (pins, recovery) = match &step.kind {
        StepKind::Agent {
            recovery_mode,
            surfaces,
            ..
        } => {
            let retry_pins = match recovery_mode {
                RecoveryMode::Inspect => runtime
                    .last_end_pins
                    .as_ref()
                    .or(runtime.last_start_pins.as_ref()),
                RecoveryMode::Reset | RecoveryMode::Manual => runtime.last_start_pins.as_ref(),
            };
            let pins = match retry_pins {
                Some(pins) => pins.clone(),
                None => carried_pins(state.current_pins.as_ref(), surfaces),
            };
            let recovery = RecoveryInstruction {
                mode: *recovery_mode,
                restore_pins: (runtime.last_completion_reason.is_some()
                    && *recovery_mode == RecoveryMode::Reset)
                    .then(|| pins.clone()),
                previous_completion_reason: runtime.last_completion_reason,
                trajectory_tail: runtime.trajectory_tail.clone(),
            };
            (pins, Some(recovery))
        }
        _ => (Pins::default(), None),
    };
    let executor = if step.step_type() == StepType::Deterministic {
        "kernel"
    } else {
        "unassigned"
    };
    let lease_id = deterministic_ulid(&state.run_id, &step.id, attempt, now_ms, "lease");
    let lease_deadline_ms = now_ms.saturating_add(LEASE_DURATION_MS);
    let started = JournalEntry::new(
        EntryType::StepAttemptStarted,
        state.run_id.clone(),
        Some(step.id.clone()),
        Some(attempt),
        now_ms,
        AttemptStartedPayload {
            step_type: step.step_type(),
            idempotency_key: key.clone(),
            lease_id: lease_id.clone(),
            lease_deadline_ms,
            executor: executor.to_owned(),
            recovery_mode,
            pins: pins.clone(),
            max_iterations: step.max_iterations,
        },
    );
    let execute = match step.step_type() {
        StepType::Deterministic => Action::ExecDeterministic {
            step: step.clone(),
            attempt,
        },
        worker_class => Action::Dispatch {
            step: step.clone(),
            attempt,
            worker_class,
            lease_id,
            idempotency_key: key,
            lease_deadline_ms,
            pins,
            recovery,
        },
    };
    vec![Action::Append(started), execute]
}

/// `semantic_executions` is the number of *completed* semantic executions
/// before this attempt (`StepRuntime::semantic_executions`). The attempt being
/// completed here ran to a result, so it is the `semantic_executions + 1`-th
/// semantic execution; `max_iterations` bounds that count, never the raw
/// attempt number — a crashed attempt must not consume iteration allowance.
pub fn completion_actions(
    run_id: &str,
    step: &StepSpec,
    attempt: u32,
    semantic_executions: u32,
    result: AttemptResult,
    now_ms: i64,
) -> Vec<Action> {
    // A rejected attempt records why it was rejected. `output` is nulled for
    // every non-success, so without this the reason exists only in the
    // taxonomy label and the diagnostic is gone.
    let verification = match &result.failure_reason {
        None => Some(verify(step, &result.output)),
        Some(_) => result
            .failure_detail
            .as_ref()
            .map(|detail| crate::entry::VerificationRecord {
                gate: "execution".to_owned(),
                verdict: crate::entry::VerificationVerdict::Fail,
                detail: detail.clone(),
            }),
    };
    let verified = verification
        .as_ref()
        .is_some_and(|record| record.verdict == crate::entry::VerificationVerdict::Pass);
    let may_retry = semantic_executions.saturating_add(1) < step.max_iterations;
    let (reason, disposition, output, next_attempt_at_ms) = if verified {
        (
            CompletionReason::Success,
            Disposition::StepDone,
            result.output,
            None,
        )
    } else if may_retry {
        let key = idempotency_key(run_id, &step.id);
        let delay = backoff_delay_ms(&step.retry, &key, attempt);
        (
            result
                .failure_reason
                .unwrap_or(CompletionReason::VerificationFailed),
            Disposition::Retry,
            Value::Null,
            Some(now_ms.saturating_add(delay as i64)),
        )
    } else {
        (
            result
                .failure_reason
                .unwrap_or(CompletionReason::RetriesExhausted),
            Disposition::StepDone,
            Value::Null,
            None,
        )
    };

    let completed = JournalEntry::new(
        EntryType::StepCompleted,
        run_id,
        Some(step.id.clone()),
        Some(attempt),
        now_ms,
        StepCompletedPayload {
            completion_reason: reason,
            disposition,
            output,
            verification,
            end_pins: result.end_pins,
            effects: result.effects,
            trajectory_tail: result.trajectory_tail,
            budget: result.budget,
            completed_by: result.completed_by,
            next_attempt_at_ms,
        },
    );
    let mut actions = vec![Action::Append(completed)];
    if let Some(wake_at_ms) = next_attempt_at_ms {
        actions.push(Action::Append(JournalEntry::new(
            EntryType::SleepUntil,
            run_id,
            Some(step.id.clone()),
            Some(attempt),
            now_ms,
            SleepUntilPayload {
                wait_id: retry_wait_id(run_id, &step.id, attempt, wake_at_ms),
                wake_at_ms,
                reason: "retry_backoff".to_owned(),
            },
        )));
        actions.push(Action::ArmTimer { at_ms: wake_at_ms });
    }
    actions
}

pub fn idempotency_key(run_id: &str, step_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(run_id.as_bytes());
    hasher.update(step_id.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn complete_run_actions(
    state: &RunState,
    reason: RunCompletionReason,
    failed_step_id: Option<String>,
    now_ms: i64,
) -> Vec<Action> {
    vec![
        Action::Append(JournalEntry::new(
            EntryType::RunCompleted,
            state.run_id.clone(),
            None,
            None,
            now_ms,
            RunCompletedPayload {
                completion_reason: reason,
                failed_step_id,
                budget_total: state.budget.clone(),
            },
        )),
        Action::CompleteRun { reason },
    ]
}

fn retry_wait_id(run_id: &str, step_id: &str, attempt: u32, at_ms: i64) -> String {
    deterministic_ulid(run_id, step_id, attempt, at_ms, "retry")
}

fn deterministic_ulid(
    run_id: &str,
    step_id: &str,
    attempt: u32,
    at_ms: i64,
    purpose: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(run_id.as_bytes());
    hasher.update(step_id.as_bytes());
    hasher.update(attempt.to_be_bytes());
    hasher.update(purpose.as_bytes());
    let hash = hasher.finalize();
    let random = hash[..10]
        .iter()
        .fold(0_u128, |value, byte| (value << 8) | u128::from(*byte));
    Ulid::from_parts(at_ms.max(0) as u64, random).to_string()
}

mod recovery;
pub use recovery::{abandonment_actions, recovery_actions, recovery_actions_filtered};

#[cfg(test)]
mod parallel_tests;
#[cfg(test)]
mod tests;
