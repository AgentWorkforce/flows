use serde_json::Value;

use super::{Action, complete_run_actions, retry_wait_id};
use crate::{
    Budget, CompletionReason, Disposition, EntryType, JournalEntry, RunCancelRequestedPayload,
    RunCompletionReason, RunState, StepCompletedPayload, StepState, WaitCompletedPayload,
    WaitCompletionReason,
};

/// Persist cancellation intent before any work is closed. Repeating the
/// request is a no-op both while cancellation is in progress and after the
/// terminal fact exists.
pub fn request_cancel_action(
    state: &RunState,
    requested_by: impl Into<String>,
    now_ms: i64,
) -> Option<Action> {
    if state.completion.is_some() || state.cancel_requested.is_some() {
        return None;
    }
    Some(Action::Append(JournalEntry::new(
        EntryType::RunCancelRequested,
        state.run_id.clone(),
        None,
        None,
        now_ms,
        RunCancelRequestedPayload {
            requested_by: requested_by.into(),
        },
    )))
}

pub(super) fn cancel_run_actions(state: &RunState, now_ms: i64) -> Vec<Action> {
    let mut actions = Vec::new();
    for step in &state.spec.steps {
        let runtime = &state.steps[&step.id];
        match &runtime.state {
            StepState::Running { attempt, .. } => {
                actions.push(Action::Append(JournalEntry::new(
                    EntryType::StepCompleted,
                    state.run_id.clone(),
                    Some(step.id.clone()),
                    Some(*attempt),
                    now_ms,
                    StepCompletedPayload {
                        human_intervention: false,
                        step_spec_hash: None,
                        input_hash: None,
                        reused_from: None,
                        completion_reason: CompletionReason::Canceled,
                        disposition: Disposition::StepDone,
                        output: Value::Null,
                        verification: None,
                        end_pins: None,
                        effects: Vec::new(),
                        trajectory_tail: None,
                        budget: Budget::default(),
                        completed_by: "kernel".to_owned(),
                        next_attempt_at_ms: None,
                    },
                )));
            }
            StepState::Waiting { wait_id } | StepState::NeedsHuman { wait_id } => {
                actions.push(Action::Append(JournalEntry::new(
                    EntryType::WaitCompleted,
                    state.run_id.clone(),
                    Some(step.id.clone()),
                    Some(runtime.attempts),
                    now_ms,
                    WaitCompletedPayload {
                        wait_id: wait_id.clone(),
                        completion_reason: WaitCompletionReason::Canceled,
                        result: Value::Null,
                    },
                )));
            }
            StepState::Backoff {
                attempt,
                wake_at_ms,
            } => {
                actions.push(Action::Append(JournalEntry::new(
                    EntryType::WaitCompleted,
                    state.run_id.clone(),
                    Some(step.id.clone()),
                    Some(*attempt),
                    now_ms,
                    WaitCompletedPayload {
                        wait_id: retry_wait_id(&state.run_id, &step.id, *attempt, *wake_at_ms),
                        completion_reason: WaitCompletionReason::Canceled,
                        result: Value::Null,
                    },
                )));
            }
            StepState::Pending | StepState::Runnable | StepState::Done { .. } => {}
        }
    }
    actions.extend(complete_run_actions(
        state,
        RunCompletionReason::Canceled,
        None,
        now_ms,
    ));
    actions
}
