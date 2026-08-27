use std::collections::BTreeMap;

use relayflowd_core::{Budget, RunCompletionReason, RunState};
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
    pub steps: BTreeMap<String, String>,
    pub budget: Budget,
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
            .steps
            .iter()
            .map(|(id, runtime)| (id.clone(), format!("{:?}", runtime.state)))
            .collect(),
        budget: state.budget.clone(),
    }
}
