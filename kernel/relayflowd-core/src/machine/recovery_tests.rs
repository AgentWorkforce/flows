//! `manual` recovery for a dead attempt the WORKER reported (`step.complete`
//! with `crashed` / `lease_expired`), and repair of a park torn between its
//! two journal appends. Split from `tests.rs` so the general completion /
//! scheduling cases stay in one file and recovery has its own.

use serde_json::json;

use super::{
    tests::{AppendAction, agent_spec, started_agent, workspace_pins},
    *,
};
use crate::state::{RunState, park_placeholder_wait_id};

/// Regression (#501 review): `RecoveryMode::Manual` was honoured only when the
/// KERNEL noticed a dead lease (`abandonment_actions`). A worker that reported
/// its own transport loss through `step.complete` went through
/// `completion_actions`, which retried every budget-eligible `crashed` or
/// `lease_expired` without reading the recovery mode — so the same dead
/// attempt parked or redispatched depending on who noticed it first.
/// Appendix A rule 4 makes `manual` a park, whichever path records the death.
#[test]
fn manual_recovery_parks_a_worker_reported_transport_loss_instead_of_redispatching() {
    for reason in [CompletionReason::Crashed, CompletionReason::LeaseExpired] {
        let spec = agent_spec("manual");
        let started = started_agent(&spec, workspace_pins("rev-clean"));
        let running = RunState::fold("run", spec.clone(), std::slice::from_ref(&started)).unwrap();
        let runtime = &running.steps["agent"];
        let mut result = AttemptResult::successful(Value::Null, "worker");
        result.failure_reason = Some(reason);
        result.failure_detail = Some("direct transport closed by signal".to_owned());
        result.trajectory_tail = Some(json!({"transport": {"cause": "signal_close"}}));
        // The worker's own claim about where the workspace ended up. The diff
        // the human is handed must be anchored on the journaled START pin, not
        // on this.
        result.end_pins = Some(workspace_pins("rev-dirty"));
        let actions = completion_actions(
            "run",
            &spec.steps[0],
            1,
            runtime.semantic_executions,
            runtime.last_start_pins.as_ref(),
            result,
            20,
        );
        assert_eq!(
            actions.len(),
            2,
            "{reason:?}: a park is a completion plus a wait.human and nothing else \
             (no retry timer): {actions:?}"
        );
        let completed: StepCompletedPayload =
            serde_json::from_value(actions[0].clone().into_append().payload).unwrap();
        assert_eq!(completed.completion_reason, reason);
        assert_eq!(completed.disposition, Disposition::Park);
        assert_eq!(completed.next_attempt_at_ms, None);
        // The worker's evidence still travels with the completion; parking is
        // not a reason to discard the account of what went wrong.
        assert_eq!(
            completed.trajectory_tail,
            Some(json!({"transport": {"cause": "signal_close"}}))
        );
        assert_eq!(
            completed.verification.as_ref().map(|record| record.verdict),
            Some(crate::VerificationVerdict::Fail)
        );
        let wait = actions[1].clone().into_append();
        assert_eq!(wait.entry_type, EntryType::WaitHuman);
        assert_eq!(wait.step_id.as_deref(), Some("agent"));
        assert_eq!(wait.attempt, Some(1));
        let human: crate::entry::WaitHumanPayload =
            serde_json::from_value(wait.payload.clone()).unwrap();
        assert_eq!(human.diff_ref.as_deref(), Some("repo@rev-clean..current"));
        assert_eq!(
            human.options,
            Some(vec!["retry".to_owned(), "cancel".to_owned()])
        );
        assert!(
            human.prompt.contains("agent") && human.prompt.contains("run"),
            "the prompt must name the step and run it parked: {}",
            human.prompt
        );

        let mut entries = vec![started];
        entries.extend(actions.into_iter().map(Action::into_append));
        let parked = RunState::fold("run", spec, &entries).unwrap();
        assert!(
            matches!(parked.steps["agent"].state, StepState::NeedsHuman { .. }),
            "{reason:?}: the step must be parked on a human, got {:?}",
            parked.steps["agent"].state
        );
        assert_eq!(
            parked.steps["agent"].semantic_executions, 0,
            "a transport loss must not consume a semantic iteration"
        );
        assert!(
            next_actions(&parked, 30).is_empty(),
            "{reason:?}: a parked manual step must never be redispatched"
        );
    }
}

/// The park above is specific to `manual`. The same worker-reported crash
/// under `reset` still takes the bounded transport retry, so the two modes
/// stay distinguishable at the completion.
#[test]
fn reset_recovery_still_retries_a_worker_reported_transport_loss() {
    let spec = agent_spec("reset");
    let started = started_agent(&spec, workspace_pins("rev-clean"));
    let running = RunState::fold("run", spec.clone(), std::slice::from_ref(&started)).unwrap();
    let runtime = &running.steps["agent"];
    let mut result = AttemptResult::successful(Value::Null, "worker");
    result.failure_reason = Some(CompletionReason::Crashed);
    result.failure_detail = Some("direct transport closed by signal".to_owned());
    let actions = completion_actions(
        "run",
        &spec.steps[0],
        1,
        runtime.semantic_executions,
        runtime.last_start_pins.as_ref(),
        result,
        20,
    );
    let completed: StepCompletedPayload =
        serde_json::from_value(actions[0].clone().into_append().payload).unwrap();
    assert_eq!(completed.disposition, Disposition::Retry);
    assert!(
        actions
            .iter()
            .all(|action| !matches!(action, Action::Append(entry) if entry.entry_type == EntryType::WaitHuman)),
        "reset must not park: {actions:?}"
    );
}

/// A `manual` park is two appends — `step.completed` (`park`), then the
/// `wait.human` a human answers — and each append is its own transaction. A
/// process death between them used to leave the step folded to the placeholder
/// wait id with nothing answerable: a permanent park. Recovery must journal
/// the missing wait exactly once, for BOTH producers of a park.
#[test]
fn recovery_journals_the_wait_human_a_torn_manual_park_never_wrote() {
    let spec = agent_spec("manual");
    let started = started_agent(&spec, workspace_pins("rev-clean"));
    let running = RunState::fold("run", spec.clone(), std::slice::from_ref(&started)).unwrap();
    let runtime = &running.steps["agent"];

    let mut reported = AttemptResult::successful(Value::Null, "worker");
    reported.failure_reason = Some(CompletionReason::LeaseExpired);
    reported.failure_detail = Some("direct transport closed by signal".to_owned());
    let worker_reported = completion_actions(
        "run",
        &spec.steps[0],
        1,
        runtime.semantic_executions,
        runtime.last_start_pins.as_ref(),
        reported,
        20,
    )
    .remove(0)
    .into_append();
    let abandoned = abandonment_actions(&running, "agent", 1, CompletionReason::Crashed, 20)
        .remove(0)
        .into_append();

    for (producer, park, reason) in [
        (
            "worker-reported",
            worker_reported,
            CompletionReason::LeaseExpired,
        ),
        ("abandoned lease", abandoned, CompletionReason::Crashed),
    ] {
        // Only the park landed; the wait.human did not.
        let torn = RunState::fold("run", spec.clone(), &[started.clone(), park.clone()]).unwrap();
        assert_eq!(
            torn.steps["agent"].state,
            StepState::NeedsHuman {
                wait_id: park_placeholder_wait_id("agent", 1)
            },
            "{producer}: the torn prefix folds to the placeholder"
        );
        assert!(
            next_actions(&torn, 30).is_empty(),
            "{producer}: a torn park must not dispatch"
        );

        let repaired = recovery_actions(&torn, 30);
        assert_eq!(
            repaired.len(),
            1,
            "{producer}: recovery journals exactly the missing wait: {repaired:?}"
        );
        let wait = repaired[0].clone().into_append();
        assert_eq!(wait.entry_type, EntryType::WaitHuman);
        assert_eq!(wait.step_id.as_deref(), Some("agent"));
        assert_eq!(wait.attempt, Some(1));
        let human: crate::entry::WaitHumanPayload =
            serde_json::from_value(wait.payload.clone()).unwrap();
        assert_eq!(human.diff_ref.as_deref(), Some("repo@rev-clean..current"));
        assert!(
            human.prompt.contains(&format!("{reason:?}")),
            "{producer}: the rebuilt prompt names the journaled reason: {}",
            human.prompt
        );

        // Healed: the real wait id replaces the placeholder, and recovery has
        // nothing further to add — the repair is idempotent across resumes.
        let healed = RunState::fold("run", spec.clone(), &[started.clone(), park, wait]).unwrap();
        assert_eq!(
            healed.steps["agent"].state,
            StepState::NeedsHuman {
                wait_id: human.wait_id
            },
            "{producer}: the journaled wait names the parked step"
        );
        assert!(
            recovery_actions(&healed, 40).is_empty(),
            "{producer}: a healed park must not be repaired twice"
        );
        assert!(next_actions(&healed, 40).is_empty());
    }
}
