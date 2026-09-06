use serde_json::json;

use super::*;
use crate::{Clock, SimClock, entry::AttemptStartedPayload, state::RunState};

fn retrying_spec() -> crate::RunSpec {
    serde_json::from_value(json!({
        "steps": [{
            "id": "hello",
            "type": "deterministic",
            "command": "printf hello",
            "max_iterations": 2,
            "retry": {"initial_backoff_ms": 100, "max_backoff_ms": 100, "multiplier": 2, "jitter_percent": 0},
            "verification": {"output_contains": "hello"}
        }]
    }))
    .unwrap()
}

#[test]
fn machine_starts_runnable_step_with_stable_effect_key() {
    let state = RunState::fold("run", retrying_spec(), &[]).unwrap();
    let actions = next_actions(&state, 10);
    let Action::Append(started) = &actions[0] else {
        panic!("first action must persist the lease")
    };
    let payload: AttemptStartedPayload = serde_json::from_value(started.payload.clone()).unwrap();
    assert_eq!(payload.idempotency_key, idempotency_key("run", "hello"));
    assert!(matches!(
        actions[1],
        Action::ExecDeterministic { attempt: 1, .. }
    ));
}

#[test]
fn verification_failure_schedules_a_durable_retry() {
    let spec = retrying_spec();
    let actions = completion_actions(
        "run",
        &spec.steps[0],
        1,
        0,
        AttemptResult::successful(json!({"exit_code": 0, "stdout_tail": "wrong"}), "kernel"),
        1_000,
    );
    let Action::Append(completed) = &actions[0] else {
        panic!()
    };
    let payload: StepCompletedPayload = serde_json::from_value(completed.payload.clone()).unwrap();
    assert_eq!(
        payload.completion_reason,
        CompletionReason::VerificationFailed
    );
    assert_eq!(payload.disposition, Disposition::Retry);
    assert_eq!(payload.next_attempt_at_ms, Some(1_100));
    assert!(matches!(
        actions[1],
        Action::Append(JournalEntry {
            entry_type: EntryType::SleepUntil,
            ..
        })
    ));
}

#[test]
fn every_failed_run_terminates_with_declared_completion_reasons() {
    let failure_reasons = [
        CompletionReason::VerificationFailed,
        CompletionReason::RetriesExhausted,
        CompletionReason::LeaseExpired,
        CompletionReason::Crashed,
        CompletionReason::Timeout,
        CompletionReason::WorkerError,
        CompletionReason::BudgetExceeded,
        CompletionReason::Canceled,
    ];

    for reason in failure_reasons {
        let spec = retrying_spec();
        let mut step = spec.steps[0].clone();
        step.max_iterations = 1;
        let mut result = AttemptResult::successful(Value::Null, "test");
        result.failure_reason = Some(reason);
        result.failure_detail = Some("declared test failure".to_owned());
        let Action::Append(completed) =
            completion_actions("run", &step, 1, 0, result, 10).remove(0)
        else {
            panic!("failed attempt must append a typed completion");
        };
        let payload: StepCompletedPayload = serde_json::from_value(completed.payload.clone())
            .expect("failed completion must deserialize to the closed payload");
        assert_eq!(payload.completion_reason, reason);

        let mut failed_spec = spec;
        failed_spec.steps[0] = step;
        let state = RunState::fold("run", failed_spec, &[completed]).unwrap();
        let Action::Append(run_completed) = next_actions(&state, 20).remove(0) else {
            panic!("failed step must terminate the run in its journal");
        };
        let terminal: RunCompletedPayload = serde_json::from_value(run_completed.payload)
            .expect("run completion reason must be a declared enum value");
        assert_eq!(terminal.completion_reason, RunCompletionReason::StepFailed);
    }
}

#[test]
fn successful_memo_is_never_scheduled_again() {
    let spec = retrying_spec();
    let Action::Append(completed) = completion_actions(
        "run",
        &spec.steps[0],
        1,
        0,
        AttemptResult::successful(json!({"exit_code": 0, "stdout_tail": "hello"}), "kernel"),
        1_000,
    )
    .remove(0) else {
        panic!()
    };
    let state = RunState::fold("run", spec, &[completed]).unwrap();
    let actions = next_actions(&state, 2_000);
    assert!(matches!(
        actions[0],
        Action::Append(JournalEntry {
            entry_type: EntryType::RunCompleted,
            ..
        })
    ));
    assert!(
        !actions
            .iter()
            .any(|action| matches!(action, Action::ExecDeterministic { .. }))
    );
}

#[test]
fn cancel_request_closes_the_active_lease_before_the_terminal_fact() {
    let clock = SimClock::new(10);
    let spec = crate::RunSpec::parse(&json!({
        "steps": [{"id": "model", "type": "llm", "prompt": "answer"}]
    }))
    .unwrap();
    let fresh = RunState::fold("run", spec.clone(), &[]).unwrap();
    let Action::Append(started) = next_actions(&fresh, clock.now_ms()).remove(0) else {
        panic!("the attempt lease must be durable");
    };
    let running = RunState::fold("run", spec.clone(), std::slice::from_ref(&started)).unwrap();
    clock.advance(10);
    let Action::Append(requested) =
        request_cancel_action(&running, "operator", clock.now_ms()).unwrap()
    else {
        panic!("cancel must first persist its request");
    };
    assert_eq!(requested.entry_type, EntryType::RunCancelRequested);

    let canceling = RunState::fold("run", spec, &[started, requested]).unwrap();
    clock.advance(10);
    let actions = next_actions(&canceling, clock.now_ms());
    let Action::Append(closed) = &actions[0] else {
        panic!("the active attempt must be closed first");
    };
    let closed: StepCompletedPayload = serde_json::from_value(closed.payload.clone()).unwrap();
    assert_eq!(closed.completion_reason, CompletionReason::Canceled);
    assert_eq!(closed.disposition, Disposition::StepDone);
    let Action::Append(terminal) = &actions[1] else {
        panic!("the run fact must follow the lease closure");
    };
    assert_eq!(terminal.entry_type, EntryType::RunCompleted);
    let terminal: RunCompletedPayload = serde_json::from_value(terminal.payload.clone()).unwrap();
    assert_eq!(terminal.completion_reason, RunCompletionReason::Canceled);
}

#[test]
fn repeated_cancel_request_is_idempotent() {
    let spec = retrying_spec();
    let state = RunState::fold("run", spec.clone(), &[]).unwrap();
    let Action::Append(requested) = request_cancel_action(&state, "operator", 10).unwrap() else {
        panic!();
    };
    let canceling = RunState::fold("run", spec.clone(), std::slice::from_ref(&requested)).unwrap();
    assert!(request_cancel_action(&canceling, "operator", 11).is_none());
    let terminal_entries = next_actions(&canceling, 12)
        .into_iter()
        .filter_map(|action| match action {
            Action::Append(entry) => Some(entry),
            _ => None,
        })
        .collect::<Vec<_>>();
    let terminal = RunState::fold("run", spec, &[requested, terminal_entries[0].clone()]).unwrap();
    assert!(request_cancel_action(&terminal, "operator", 13).is_none());
}

#[test]
fn durable_cancel_request_outranks_crash_recovery() {
    let clock = SimClock::new(10);
    let spec = crate::RunSpec::parse(&json!({
        "steps": [{"id": "model", "type": "llm", "prompt": "answer"}]
    }))
    .unwrap();
    let fresh = RunState::fold("run", spec.clone(), &[]).unwrap();
    let Action::Append(started) = next_actions(&fresh, clock.now_ms()).remove(0) else {
        panic!("the attempt lease must be durable");
    };
    let running = RunState::fold("run", spec.clone(), std::slice::from_ref(&started)).unwrap();
    clock.advance(10);
    let Action::Append(requested) =
        request_cancel_action(&running, "operator", clock.now_ms()).unwrap()
    else {
        panic!("the cancel request must be durable");
    };
    let canceling = RunState::fold("run", spec, &[started, requested]).unwrap();

    assert!(recovery_actions(&canceling, clock.now_ms()).is_empty());
    let Action::Append(closed) = &next_actions(&canceling, clock.now_ms())[0] else {
        panic!("cancellation must close the active lease");
    };
    let closed: StepCompletedPayload = serde_json::from_value(closed.payload.clone()).unwrap();
    assert_eq!(closed.completion_reason, CompletionReason::Canceled);
}

#[test]
fn crashed_attempt_does_not_consume_an_iteration() {
    // max_iterations 2: crash attempt 1, verification-fail the replacement
    // (attempt 2) — one semantic iteration must remain, so the step retries
    // instead of exhausting after a single semantic result.
    let spec = retrying_spec();
    let fresh = RunState::fold("run", spec.clone(), &[]).unwrap();
    let Action::Append(started) = next_actions(&fresh, 10).remove(0) else {
        panic!("attempt 1 must journal its lease");
    };

    // kill -9 between steps: attempt 1 is Running with no result. Recovery
    // must record the dead attempt as a retry, not a consumed iteration.
    let state = RunState::fold("run", spec.clone(), std::slice::from_ref(&started)).unwrap();
    assert_eq!(state.steps["hello"].semantic_executions, 0);
    let recovery = recovery_actions(&state, 1_000);
    let Action::Append(crashed) = &recovery[0] else {
        panic!("recovery must journal the dead attempt");
    };
    let crash_payload: StepCompletedPayload =
        serde_json::from_value(crashed.payload.clone()).unwrap();
    assert_eq!(crash_payload.disposition, Disposition::Retry);

    // The replacement (attempt 2) completes but fails verification. Raw
    // attempt number 2 == max_iterations, yet only one semantic execution has
    // happened — the step must still have an iteration remaining.
    let state = RunState::fold("run", spec.clone(), &[started, crashed.clone()]).unwrap();
    assert_eq!(state.steps["hello"].semantic_executions, 0);
    let actions = completion_actions(
        "run",
        &spec.steps[0],
        2,
        state.steps["hello"].semantic_executions,
        AttemptResult::successful(json!({"exit_code": 0, "stdout_tail": "wrong"}), "kernel"),
        2_000,
    );
    let Action::Append(completed) = &actions[0] else {
        panic!("completion must journal");
    };
    let payload: StepCompletedPayload = serde_json::from_value(completed.payload.clone()).unwrap();
    assert_eq!(
        payload.completion_reason,
        CompletionReason::VerificationFailed
    );
    assert_eq!(payload.disposition, Disposition::Retry);
    assert!(payload.next_attempt_at_ms.is_some());
}

#[test]
fn all_backing_off_steps_return_timers() {
    let spec = crate::RunSpec::parse(&json!({
        "steps": [
            {
                "id": "first",
                "type": "deterministic",
                "command": "false",
                "max_iterations": 2,
                "retry": {"initial_backoff_ms": 200, "max_backoff_ms": 200, "multiplier": 1, "jitter_percent": 0}
            },
            {
                "id": "second",
                "type": "deterministic",
                "command": "false",
                "max_iterations": 2,
                "retry": {"initial_backoff_ms": 100, "max_backoff_ms": 100, "multiplier": 1, "jitter_percent": 0}
            }
        ]
    }))
    .unwrap();
    let result = AttemptResult {
        output: Value::Null,
        budget: Budget::default(),
        completed_by: "kernel".to_owned(),
        end_pins: None,
        effects: Vec::new(),
        trajectory_tail: None,
        failure_reason: Some(CompletionReason::WorkerError),
        failure_detail: Some("stub rejection".to_owned()),
    };
    let mut entries = Vec::new();
    for step in &spec.steps {
        entries.extend(
            completion_actions("run", step, 1, 0, result.clone(), 1_000)
                .into_iter()
                .filter_map(|action| match action {
                    Action::Append(entry) => Some(entry),
                    _ => None,
                }),
        );
    }

    let state = RunState::fold("run", spec, &entries).unwrap();
    assert_eq!(
        next_actions(&state, 1_050),
        vec![
            Action::ArmTimer { at_ms: 1_100 },
            Action::ArmTimer { at_ms: 1_200 },
        ]
    );
}

fn agent_spec(mode: &str) -> crate::RunSpec {
    crate::RunSpec::parse(&json!({
        "steps": [{
            "id": "agent",
            "type": "agent",
            "instruction": "edit the workspace",
            "recovery_mode": mode,
            "max_iterations": 2,
            "retry": {"initial_backoff_ms": 0, "max_backoff_ms": 0, "multiplier": 1, "jitter_percent": 0},
            "surfaces": {"workspace": [{"surface": "repo"}]}
        }]
    }))
    .unwrap()
}

fn workspace_pins(revision_id: &str) -> Pins {
    Pins {
        workspace: vec![crate::WorkspacePin {
            surface: "repo".to_owned(),
            revision_id: revision_id.to_owned(),
        }],
        streams: vec![],
    }
}

fn started_agent(spec: &crate::RunSpec, pins: Pins) -> JournalEntry {
    let state = RunState::fold("run", spec.clone(), &[]).unwrap();
    let Action::Append(mut started) = next_actions(&state, 10).remove(0) else {
        panic!("agent start must be journaled")
    };
    let mut payload: AttemptStartedPayload =
        serde_json::from_value(started.payload.clone()).unwrap();
    payload.pins = pins;
    started.payload = serde_json::to_value(payload).unwrap();
    started
}

#[test]
fn reset_recovery_dispatches_the_original_pinned_revision() {
    let spec = agent_spec("reset");
    let pinned = workspace_pins("rev-clean");
    let started = started_agent(&spec, pinned.clone());
    let running = RunState::fold("run", spec.clone(), std::slice::from_ref(&started)).unwrap();
    let recovered = recovery_actions(&running, 20);
    let entries = vec![
        started,
        recovered[0].clone().into_append(),
        recovered[1].clone().into_append(),
    ];
    let backoff = RunState::fold("run", spec.clone(), &entries).unwrap();
    let Action::Append(timer_fired) = next_actions(&backoff, 20).remove(0) else {
        panic!("retry timer must fire")
    };
    let mut ready_entries = entries;
    ready_entries.push(timer_fired);
    let ready = RunState::fold("run", spec, &ready_entries).unwrap();
    let actions = next_actions(&ready, 20);
    let Action::Dispatch { pins, recovery, .. } = &actions[1] else {
        panic!("replacement attempt must dispatch")
    };
    assert_eq!(pins, &pinned);
    assert_eq!(
        recovery.as_ref().unwrap().restore_pins.as_ref(),
        Some(&pinned)
    );
    assert_eq!(
        recovery.as_ref().unwrap().previous_completion_reason,
        Some(CompletionReason::Crashed)
    );
}

#[test]
fn inspect_recovery_injects_the_dirty_pin_completion_reason_and_tail() {
    let spec = agent_spec("inspect");
    let clean = workspace_pins("rev-clean");
    let dirty = workspace_pins("rev-dirty");
    let started = started_agent(&spec, clean);
    let running = RunState::fold("run", spec.clone(), std::slice::from_ref(&started)).unwrap();
    let result = AttemptResult {
        output: Value::Null,
        budget: Budget::default(),
        completed_by: "worker".to_owned(),
        end_pins: Some(dirty.clone()),
        effects: vec![],
        trajectory_tail: Some(json!(["edited file"])),
        failure_reason: Some(CompletionReason::WorkerError),
        failure_detail: Some("stub rejection".to_owned()),
    };
    let completed = completion_actions(
        "run",
        &spec.steps[0],
        1,
        running.steps["agent"].semantic_executions,
        result,
        20,
    );
    let mut entries = vec![started];
    entries.extend(completed.into_iter().filter_map(|action| match action {
        Action::Append(entry) => Some(entry),
        _ => None,
    }));
    let backoff = RunState::fold("run", spec.clone(), &entries).unwrap();
    let Action::Append(timer_fired) = next_actions(&backoff, 20).remove(0) else {
        panic!("retry timer must fire")
    };
    entries.push(timer_fired);
    let ready = RunState::fold("run", spec, &entries).unwrap();
    let actions = next_actions(&ready, 20);
    let Action::Dispatch { pins, recovery, .. } = &actions[1] else {
        panic!("inspect retry must dispatch")
    };
    let recovery = recovery.as_ref().unwrap();
    assert_eq!(pins, &dirty);
    assert_eq!(
        recovery.previous_completion_reason,
        Some(CompletionReason::WorkerError)
    );
    assert_eq!(recovery.trajectory_tail, Some(json!(["edited file"])));
    assert!(recovery.restore_pins.is_none());
}

#[test]
fn manual_recovery_parks_needs_human_and_never_redispatches() {
    let spec = agent_spec("manual");
    let started = started_agent(&spec, workspace_pins("rev-clean"));
    let running = RunState::fold("run", spec.clone(), std::slice::from_ref(&started)).unwrap();
    let recovered = recovery_actions(&running, 20);
    let Action::Append(wait) = &recovered[1] else {
        panic!(
            "manual recovery must park on wait.human: {:?}",
            recovered[1]
        )
    };
    assert_eq!(wait.entry_type, EntryType::WaitHuman);
    // Appendix A rule 4: the human is handed a diff of the *pinned* revision vs.
    // current state, so the reference must name the surface and the revision the
    // attempt actually started from — not a constant.
    let human: crate::entry::WaitHumanPayload =
        serde_json::from_value(wait.payload.clone()).unwrap();
    assert_eq!(human.diff_ref.as_deref(), Some("repo@rev-clean..current"));
    assert!(
        human.prompt.contains("agent") && human.prompt.contains("run"),
        "the prompt must name the step and run it parked: {}",
        human.prompt
    );
    let mut entries = vec![started];
    entries.extend(recovered.into_iter().filter_map(|action| match action {
        Action::Append(entry) => Some(entry),
        _ => None,
    }));
    let parked = RunState::fold("run", spec, &entries).unwrap();
    assert!(matches!(
        parked.steps["agent"].state,
        StepState::NeedsHuman { .. }
    ));
    assert!(next_actions(&parked, 30).is_empty());
}

trait AppendAction {
    fn into_append(self) -> JournalEntry;
}

impl AppendAction for Action {
    fn into_append(self) -> JournalEntry {
        match self {
            Action::Append(entry) => entry,
            _ => panic!("expected journal append"),
        }
    }
}

/// Regression, 2026-09-06 (#195): a WORKER-reported failure carries no
/// `failure_detail` — that field is set only for kernel-side rejections — and
/// the completion used to map over it, journaling `verification: null`. The
/// reason then survived only as the taxonomy label, which is precisely what the
/// branch was written to prevent, and `output` is nulled for every non-success
/// so nothing else carried it either.
///
/// Every other row in this file sets `failure_detail: Some(..)`, so the whole
/// suite exercised the arm that worked and none of it touched the arm that did
/// not. This asserts the arm that did not.
#[test]
fn worker_reported_failure_without_detail_still_records_a_verification() {
    let spec: crate::RunSpec = serde_json::from_value(json!({
        "version": "0.1.0",
        "steps": [
            {
                "id": "only",
                "type": "deterministic",
                "command": "false",
                "max_iterations": 1
            }
        ]
    }))
    .unwrap();
    let result = AttemptResult {
        output: Value::Null,
        budget: Budget::default(),
        completed_by: "worker".to_owned(),
        end_pins: None,
        effects: Vec::new(),
        trajectory_tail: None,
        failure_reason: Some(CompletionReason::WorkerError),
        // The point of the case: the worker reported a failure and sent no
        // detail with it.
        failure_detail: None,
    };
    let entries: Vec<_> = completion_actions("run", &spec.steps[0], 1, 0, result, 1_000)
        .into_iter()
        .filter_map(|action| match action {
            Action::Append(entry) => Some(entry),
            _ => None,
        })
        .collect();

    let completed = entries
        .iter()
        .find(|entry| entry.entry_type == EntryType::StepCompleted)
        .expect("a step.completed entry");
    let payload: StepCompletedPayload =
        serde_json::from_value(serde_json::to_value(&completed.payload).unwrap()).unwrap();

    let record = payload
        .verification
        .expect("a worker-reported failure must journal WHY, not just its taxonomy label");
    assert_eq!(record.verdict, crate::VerificationVerdict::Fail);
    assert_eq!(record.gate, "execution");
    // The reason itself has to appear, or the record is present but empty of
    // information and the diagnostic is still gone.
    assert!(
        record.detail.contains("WorkerError"),
        "detail should name the reported reason, got {:?}",
        record.detail
    );
    // And the taxonomy label must still be the reason the worker gave, not
    // overwritten by the verification bookkeeping.
    assert_eq!(payload.completion_reason, CompletionReason::WorkerError);
}
