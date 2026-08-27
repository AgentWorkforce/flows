use serde_json::Value;
use sha2::{Digest, Sha256};
use ulid::Ulid;

use crate::{
    entry::{
        AttemptStartedPayload, Budget, CompletionReason, Disposition, EffectRef, EntryType,
        JournalEntry, Pins, RunCompletedPayload, RunCompletionReason, SleepUntilPayload,
        StepCompletedPayload, WaitCompletedPayload, WaitCompletionReason, WaitHumanPayload,
    },
    retry::backoff_delay_ms,
    spec::{RecoveryMode, StepKind, StepSpec, StepType},
    state::{RunState, StepState},
    verify::verify,
};

const LEASE_DURATION_MS: i64 = 30_000;

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
    /// Execution failures bypass verification but still follow retry policy.
    pub failure_reason: Option<CompletionReason>,
}

impl AttemptResult {
    pub fn successful(output: Value, completed_by: impl Into<String>) -> Self {
        Self {
            output,
            budget: Budget::default(),
            completed_by: completed_by.into(),
            end_pins: None,
            effects: Vec::new(),
            failure_reason: None,
        }
    }
}

pub fn next_actions(state: &RunState, now_ms: i64) -> Vec<Action> {
    if state.completion.is_some() {
        return Vec::new();
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
                return vec![Action::ArmTimer { at_ms: wake_at_ms }];
            }
            StepState::Runnable => return start_actions(state, spec, runtime.attempts + 1, now_ms),
            _ => {}
        }
    }
    Vec::new()
}

fn start_actions(state: &RunState, step: &StepSpec, attempt: u32, now_ms: i64) -> Vec<Action> {
    let key = idempotency_key(&state.run_id, &step.id);
    let recovery_mode = match &step.kind {
        StepKind::Agent { recovery_mode, .. } => Some(*recovery_mode),
        _ => None,
    };
    // Pins are runtime facts (Appendix A rule 2): the revision/offset of each
    // declared surface at attempt start. Gate-1 deterministic steps are pure
    // (no pins), and no agent worker is attached yet to observe revisions.
    let pins = Pins::default();
    let executor = if step.step_type() == StepType::Deterministic {
        "kernel"
    } else {
        "unassigned"
    };
    let started = JournalEntry::new(
        EntryType::StepAttemptStarted,
        state.run_id.clone(),
        Some(step.id.clone()),
        Some(attempt),
        now_ms,
        AttemptStartedPayload {
            step_type: step.step_type(),
            idempotency_key: key,
            lease_id: deterministic_ulid(&state.run_id, &step.id, attempt, now_ms, "lease"),
            lease_deadline_ms: now_ms.saturating_add(LEASE_DURATION_MS),
            executor: executor.to_owned(),
            recovery_mode,
            pins,
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
    let verification = result
        .failure_reason
        .is_none()
        .then(|| verify(step, &result.output));
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

pub fn recovery_actions(state: &RunState, now_ms: i64) -> Vec<Action> {
    let mut actions = Vec::new();
    for spec in &state.spec.steps {
        let runtime = &state.steps[&spec.id];
        let StepState::Running {
            attempt,
            lease_deadline_ms,
            ..
        } = runtime.state
        else {
            continue;
        };
        let reason = if now_ms >= lease_deadline_ms {
            CompletionReason::LeaseExpired
        } else {
            CompletionReason::Crashed
        };
        let manual = matches!(
            spec.kind,
            StepKind::Agent {
                recovery_mode: RecoveryMode::Manual,
                ..
            }
        );
        // A dead attempt produced no result, so it consumes no semantic
        // iteration at all: a replacement is permitted as long as completed
        // semantic executions have not exhausted `max_iterations`.
        let may_retry = runtime.semantic_executions < spec.max_iterations;
        let next_attempt_at_ms = (may_retry && !manual).then(|| {
            now_ms.saturating_add(backoff_delay_ms(
                &spec.retry,
                &idempotency_key(&state.run_id, &spec.id),
                attempt,
            ) as i64)
        });
        actions.push(Action::Append(JournalEntry::new(
            EntryType::StepCompleted,
            state.run_id.clone(),
            Some(spec.id.clone()),
            Some(attempt),
            now_ms,
            StepCompletedPayload {
                completion_reason: reason,
                disposition: if manual {
                    Disposition::Park
                } else if may_retry {
                    Disposition::Retry
                } else {
                    Disposition::StepDone
                },
                output: Value::Null,
                verification: None,
                end_pins: None,
                effects: vec![],
                budget: Budget::default(),
                completed_by: "kernel".to_owned(),
                next_attempt_at_ms,
            },
        )));
        if manual {
            actions.push(Action::Append(JournalEntry::new(
                EntryType::WaitHuman,
                state.run_id.clone(),
                Some(spec.id.clone()),
                Some(attempt),
                now_ms,
                WaitHumanPayload {
                    wait_id: deterministic_ulid(&state.run_id, &spec.id, attempt, now_ms, "manual"),
                    prompt: "An agent attempt crashed with a dirty workspace".to_owned(),
                    requested_of: "run-owner".to_owned(),
                    options: Some(vec!["retry".to_owned(), "cancel".to_owned()]),
                    timeout_at_ms: None,
                    diff_ref: Some("pinned-revision..current".to_owned()),
                },
            )));
        } else if let Some(wake_at_ms) = next_attempt_at_ms {
            actions.push(Action::Append(JournalEntry::new(
                EntryType::SleepUntil,
                state.run_id.clone(),
                Some(spec.id.clone()),
                Some(attempt),
                now_ms,
                SleepUntilPayload {
                    wait_id: retry_wait_id(&state.run_id, &spec.id, attempt, wake_at_ms),
                    wake_at_ms,
                    reason: "retry_backoff".to_owned(),
                },
            )));
        }
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

#[cfg(test)]
mod tests;
