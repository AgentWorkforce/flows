use std::collections::BTreeMap;

use relayflowd_core::{Budget, RunCompletionReason, RunState, StepState, StepType};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    Completed,
    Failed,
    Interrupted,
    Parked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunOutcome {
    pub run_id: String,
    pub status: RunStatus,
    pub completion_reason: Option<RunCompletionReason>,
    pub completed_steps: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunSnapshot {
    pub run_id: String,
    pub status: RunStatus,
    pub steps: BTreeMap<String, StepSnapshot>,
    pub budget: Budget,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StepSnapshot {
    #[serde(rename = "type")]
    pub step_type: StepType,
    pub state: StepStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_deadline_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    Runnable,
    Running,
    Backoff,
    Waiting,
    NeedsHuman,
    Done,
}

pub(super) fn outcome_from_state(state: &RunState, reason: RunCompletionReason) -> RunOutcome {
    RunOutcome {
        run_id: state.run_id.clone(),
        status: if reason == RunCompletionReason::Success {
            RunStatus::Completed
        } else {
            RunStatus::Failed
        },
        completion_reason: Some(reason),
        completed_steps: state.completed_steps(),
    }
}

pub(super) fn snapshot_from_state(state: &RunState) -> RunSnapshot {
    RunSnapshot {
        run_id: state.run_id.clone(),
        status: match state.completion {
            Some(RunCompletionReason::Success) => RunStatus::Completed,
            Some(_) => RunStatus::Failed,
            None if state.steps.values().any(|step| {
                matches!(step.state, relayflowd_core::StepState::NeedsHuman { .. })
            }) =>
            {
                RunStatus::Parked
            }
            None => RunStatus::Running,
        },
        steps: state
            .spec
            .steps
            .iter()
            .map(|step| {
                let runtime = &state.steps[&step.id];
                let (step_state, lease_deadline_ms) = match runtime.state {
                    StepState::Pending => (StepStatus::Pending, None),
                    StepState::Runnable => (StepStatus::Runnable, None),
                    StepState::Running {
                        lease_deadline_ms, ..
                    } => (StepStatus::Running, Some(lease_deadline_ms)),
                    StepState::Backoff { .. } => (StepStatus::Backoff, None),
                    StepState::Waiting { .. } => (StepStatus::Waiting, None),
                    StepState::NeedsHuman { .. } => (StepStatus::NeedsHuman, None),
                    StepState::Done { .. } => (StepStatus::Done, None),
                };
                (
                    step.id.clone(),
                    StepSnapshot {
                        step_type: step.step_type(),
                        state: step_state,
                        lease_deadline_ms,
                    },
                )
            })
            .collect(),
        budget: state.budget.clone(),
    }
}
