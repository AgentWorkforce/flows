use serde_json::json;

use super::*;
use crate::{entry::AttemptStartedPayload, state::RunState};

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
    let state = RunState::fold("run", spec.clone(), &[started.clone()]).unwrap();
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
