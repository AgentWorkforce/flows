//! Recovery: what a resume does with attempts that were in flight when the
//! process died, and what an abandoned attempt is journaled as. Split from
//! `machine.rs` so neither file carries two subjects at once.

use serde_json::Value;

use super::{Action, deterministic_ulid, retry_wait_id};
use crate::{
    entry::{
        Budget, CompletionReason, Disposition, EntryType, JournalEntry, Pins, SleepUntilPayload,
        StepCompletedPayload, WaitHumanPayload,
    },
    spec::{RecoveryMode, StepKind},
    state::{RunState, StepState},
};

pub fn recovery_actions(state: &RunState, now_ms: i64) -> Vec<Action> {
    recovery_actions_filtered(state, now_ms, &|_, _| false)
}

/// Recovery for a live server: `lease_is_active(step_id, attempt)` reports an
/// attempt whose worker still holds a valid, heartbeating lease. Those attempts
/// are left running; only genuinely dead attempts (worker detached, or lease
/// deadline passed) are abandoned.
pub fn recovery_actions_filtered(
    state: &RunState,
    now_ms: i64,
    lease_is_active: &dyn Fn(&str, u32) -> bool,
) -> Vec<Action> {
    // Durable cancellation intent wins over crash classification. The cancel
    // path closes the same lease as canceled; recovery must not get there
    // first and rewrite the reason merely because the process restarted.
    if state.cancel_requested.is_some() {
        return Vec::new();
    }
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
        if lease_is_active(&spec.id, attempt) {
            continue;
        }
        let reason = if now_ms >= lease_deadline_ms {
            CompletionReason::LeaseExpired
        } else {
            CompletionReason::Crashed
        };
        actions.extend(abandonment_actions(
            state, &spec.id, attempt, reason, now_ms,
        ));
    }
    actions
}

/// Record one dead leased attempt without charging a semantic iteration.
/// Used both by journal recovery and by a live protocol session noticing its
/// attached worker has disappeared.
pub fn abandonment_actions(
    state: &RunState,
    step_id: &str,
    attempt: u32,
    reason: CompletionReason,
    now_ms: i64,
) -> Vec<Action> {
    let Some(spec) = state.spec.step(step_id) else {
        return Vec::new();
    };
    let Some(runtime) = state.steps.get(step_id) else {
        return Vec::new();
    };
    if !matches!(runtime.state, StepState::Running { attempt: active, .. } if active == attempt) {
        return Vec::new();
    }
    let manual = matches!(
        spec.kind,
        StepKind::Agent {
            recovery_mode: RecoveryMode::Manual,
            ..
        }
    );
    let may_retry = runtime.semantic_executions < spec.max_iterations;
    // No retry delay for a dead leased attempt. This function records an
    // attempt that died WITHOUT producing a result a gate could judge -- which
    // is why, as the doc comment above says, it does not charge a semantic
    // iteration either. Rate-limiting it is the same category error: the
    // backoff curve exists to damp a step that keeps failing on its own merits,
    // not one whose worker was killed.
    //
    // Leaving the delay in place also made recovery order a race, which is
    // issue #155. The dead lane sat in `Backoff` with `wake_at_ms` a few
    // milliseconds in the future; the scheduler's `due_waits` only fires once
    // that passes, and `due_waits` is returned ahead of any `starts`. So
    // whether the recovered lane or an idle sibling claimed the one free worker
    // depended purely on when the next pass landed relative to that deadline:
    //
    //   PROBE pass now=1788503129020
    //     states=[("lane-b", Backoff { wake_at_ms: 1788503129025 }),
    //             ("lane-a", Runnable)]  due_waits=0
    //
    // Five milliseconds decided it, and `worker_capacity.rs:149` saw `lane-a`
    // instead of the retried `lane-b` in roughly 15% of runs.
    let next_attempt_at_ms = (may_retry && !manual).then_some(now_ms);
    let mut actions = vec![Action::Append(JournalEntry::new(
        EntryType::StepCompleted,
        state.run_id.clone(),
        Some(step_id.to_owned()),
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
            trajectory_tail: None,
            budget: Budget::default(),
            completed_by: "kernel".to_owned(),
            next_attempt_at_ms,
        },
    ))];
    if manual {
        actions.push(Action::Append(JournalEntry::new(
            EntryType::WaitHuman,
            state.run_id.clone(),
            Some(step_id.to_owned()),
            Some(attempt),
            now_ms,
            WaitHumanPayload {
                wait_id: deterministic_ulid(&state.run_id, step_id, attempt, now_ms, "manual"),
                prompt: format!(
                    "agent step {step_id} of run {} ended {reason:?} with a dirty workspace; \
                     a human must inspect it before another attempt",
                    state.run_id
                ),
                requested_of: "run-owner".to_owned(),
                options: Some(vec!["retry".to_owned(), "cancel".to_owned()]),
                timeout_at_ms: None,
                diff_ref: dirty_diff_ref(runtime.last_start_pins.as_ref()),
            },
        )));
    } else if let Some(wake_at_ms) = next_attempt_at_ms {
        actions.push(Action::Append(JournalEntry::new(
            EntryType::SleepUntil,
            state.run_id.clone(),
            Some(step_id.to_owned()),
            Some(attempt),
            now_ms,
            SleepUntilPayload {
                wait_id: retry_wait_id(&state.run_id, step_id, attempt, wake_at_ms),
                wake_at_ms,
                reason: "retry_backoff".to_owned(),
            },
        )));
    }
    actions
}

/// Appendix A rule 4: the `manual` park hands the human a diff of the pinned
/// revision vs. current state. The reference names each pinned surface and the
/// revision the attempt started from — the only revision the kernel knows.
/// Without journaled start pins there is nothing to diff against.
fn dirty_diff_ref(start_pins: Option<&Pins>) -> Option<String> {
    let pins = start_pins?;
    if pins.workspace.is_empty() {
        return None;
    }
    Some(
        pins.workspace
            .iter()
            .map(|pin| format!("{}@{}..current", pin.surface, pin.revision_id))
            .collect::<Vec<_>>()
            .join(","),
    )
}
