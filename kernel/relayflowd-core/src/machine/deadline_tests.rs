//! An agent CLI deadline is a transport failure. It keeps the dirty pins and
//! the trajectory tail, and the next attempt inspects that workspace even
//! when the step declared `reset`.

use serde_json::{Value, json};

use super::*;
use crate::{entry::AttemptStartedPayload, state::RunState};

fn deadline_spec(mode: &str) -> crate::RunSpec {
    crate::RunSpec::parse(&json!({
        "steps": [{
            "id": "agent",
            "type": "agent",
            "instruction": "edit the workspace",
            "recovery_mode": mode,
            "max_iterations": 1,
            "retry": {
                "initial_backoff_ms": 0,
                "max_backoff_ms": 0,
                "multiplier": 1,
                "jitter_percent": 0,
                "max_transport_retries": 1
            },
            "surfaces": {"workspace": [{"surface": "repo"}]}
        }]
    }))
    .unwrap()
}

fn pins(revision_id: &str) -> Pins {
    Pins {
        workspace: vec![crate::WorkspacePin {
            surface: "repo".to_owned(),
            revision_id: revision_id.to_owned(),
        }],
        streams: vec![],
    }
}

fn timeout_result(end: &Pins) -> AttemptResult {
    AttemptResult {
        human_intervention: false,
        output: Value::Null,
        budget: Budget::default(),
        completed_by: "worker".to_owned(),
        end_pins: Some(end.clone()),
        effects: vec![],
        trajectory_tail: Some(json!({"artifacts": {"count": 1, "paths": ["kept.txt"]}})),
        failure_reason: Some(CompletionReason::Timeout),
        failure_detail: Some("CLI invocation timed out after 800ms.".to_owned()),
        reported_cost: None,
    }
}

fn started(spec: &crate::RunSpec, revision: &str) -> JournalEntry {
    let state = RunState::fold("run", spec.clone(), &[]).unwrap();
    let Action::Append(mut entry) = next_actions(&state, 10).remove(0) else {
        panic!("agent start must be journaled")
    };
    let mut payload: AttemptStartedPayload = serde_json::from_value(entry.payload.clone()).unwrap();
    payload.pins = pins(revision);
    entry.payload = serde_json::to_value(payload).unwrap();
    entry
}

fn appends(actions: Vec<Action>) -> Vec<JournalEntry> {
    actions
        .into_iter()
        .filter_map(|action| match action {
            Action::Append(entry) => Some(entry),
            _ => None,
        })
        .collect()
}

#[test]
fn agent_deadline_retries_once_into_the_dirty_workspace() {
    let spec = deadline_spec("reset");
    let clean = pins("rev-clean");
    let dirty = pins("rev-clean+deadbeef");
    let first = started(&spec, "rev-clean");
    let running = RunState::fold("run", spec.clone(), std::slice::from_ref(&first)).unwrap();
    let declared: AttemptStartedPayload = serde_json::from_value(first.payload.clone()).unwrap();
    assert_eq!(declared.recovery_mode, Some(RecoveryMode::Reset));

    let first_actions = completion_actions(
        "run",
        &spec.steps[0],
        1,
        running.steps["agent"].semantic_executions,
        Some(&clean),
        timeout_result(&dirty),
        20,
    );
    let Action::Append(completed) = &first_actions[0] else {
        panic!("deadline must journal a completion")
    };
    let payload: StepCompletedPayload = serde_json::from_value(completed.payload.clone()).unwrap();
    assert_eq!(payload.completion_reason, CompletionReason::Timeout);
    assert_eq!(payload.disposition, Disposition::Retry);
    assert_eq!(payload.end_pins.as_ref(), Some(&dirty));
    assert_eq!(
        payload.trajectory_tail,
        Some(json!({"artifacts": {"count": 1, "paths": ["kept.txt"]}}))
    );

    let mut entries = vec![first];
    entries.extend(appends(first_actions));
    let backoff = RunState::fold("run", spec.clone(), &entries).unwrap();
    assert_eq!(backoff.steps["agent"].semantic_executions, 0);
    assert_eq!(backoff.steps["agent"].last_end_pins.as_ref(), Some(&dirty));
    let wake_at = payload
        .next_attempt_at_ms
        .expect("transport retry arms a timer");
    let Action::Append(woken) = next_actions(&backoff, wake_at).remove(0) else {
        panic!("retry timer must fire")
    };
    entries.push(woken);
    let ready = RunState::fold("run", spec.clone(), &entries).unwrap();
    let retry = next_actions(&ready, wake_at);
    let Action::Append(second_started) = &retry[0] else {
        panic!("continuation must journal its start")
    };
    let second_started: AttemptStartedPayload =
        serde_json::from_value(second_started.payload.clone()).unwrap();
    let Action::Dispatch {
        pins: dispatched,
        recovery,
        ..
    } = &retry[1]
    else {
        panic!("continuation must dispatch")
    };
    let recovery = recovery.as_ref().expect("agent dispatch carries recovery");
    assert_eq!(second_started.recovery_mode, Some(RecoveryMode::Reset));
    assert_eq!(recovery.mode, RecoveryMode::Inspect);
    assert!(recovery.restore_pins.is_none());
    assert_eq!(dispatched, &dirty);
    assert_eq!(second_started.pins, dirty);
    assert_eq!(
        recovery.previous_completion_reason,
        Some(CompletionReason::Timeout)
    );
    assert_eq!(
        recovery.trajectory_tail,
        Some(json!({"artifacts": {"count": 1, "paths": ["kept.txt"]}}))
    );
    entries.extend(appends(retry));
    RunState::fold("run", spec.clone(), &entries)
        .expect("the dirty start pin is the deadline's pin chain");

    let second = completion_actions(
        "run",
        &spec.steps[0],
        2,
        ready.steps["agent"].semantic_executions,
        Some(&dirty),
        timeout_result(&dirty),
        40,
    );
    let Action::Append(sealed) = &second[0] else {
        panic!("a second deadline must journal a completion")
    };
    let sealed: StepCompletedPayload = serde_json::from_value(sealed.payload.clone()).unwrap();
    assert_eq!(sealed.completion_reason, CompletionReason::Timeout);
    assert_eq!(sealed.disposition, Disposition::StepDone);
    assert_eq!(sealed.next_attempt_at_ms, None);
}

#[test]
fn agent_deadline_with_no_transport_budget_settles() {
    let mut spec = deadline_spec("reset");
    spec.steps[0].retry.max_transport_retries = 0;
    let actions = completion_actions(
        "run",
        &spec.steps[0],
        1,
        0,
        None,
        timeout_result(&pins("rev-clean+deadbeef")),
        10,
    );
    let Action::Append(completed) = &actions[0] else {
        panic!("a deadline with no transport budget must still journal")
    };
    let payload: StepCompletedPayload = serde_json::from_value(completed.payload.clone()).unwrap();
    assert_eq!(payload.completion_reason, CompletionReason::Timeout);
    assert_eq!(payload.disposition, Disposition::StepDone);
}

#[test]
fn manual_agent_deadline_parks() {
    let spec = deadline_spec("manual");
    let actions = completion_actions(
        "run",
        &spec.steps[0],
        1,
        0,
        Some(&pins("rev-clean")),
        timeout_result(&pins("rev-clean+deadbeef")),
        10,
    );
    let Action::Append(completed) = &actions[0] else {
        panic!("manual deadline must journal a completion")
    };
    let payload: StepCompletedPayload = serde_json::from_value(completed.payload.clone()).unwrap();
    assert_eq!(payload.completion_reason, CompletionReason::Timeout);
    assert_eq!(payload.disposition, Disposition::Park);
}

#[test]
fn manual_deadline_answer_inspects_the_dirty_pins() {
    let spec = deadline_spec("manual");
    let clean = pins("rev-clean");
    let dirty = pins("rev-clean+deadbeef");
    let first = started(&spec, "rev-clean");
    let running = RunState::fold("run", spec.clone(), std::slice::from_ref(&first)).unwrap();
    let parked = completion_actions(
        "run",
        &spec.steps[0],
        1,
        running.steps["agent"].semantic_executions,
        Some(&clean),
        timeout_result(&dirty),
        20,
    );
    let Action::Append(completed) = &parked[0] else {
        panic!("manual deadline must journal a completion")
    };
    let payload: StepCompletedPayload = serde_json::from_value(completed.payload.clone()).unwrap();
    assert_eq!(payload.disposition, Disposition::Park);
    assert_eq!(payload.end_pins.as_ref(), Some(&dirty));

    let mut entries = vec![first];
    entries.extend(appends(parked));
    let waiting = RunState::fold("run", spec.clone(), &entries).unwrap();
    assert!(matches!(
        waiting.steps["agent"].state,
        StepState::NeedsHuman { .. }
    ));

    entries.push(JournalEntry::new(
        EntryType::WaitCompleted,
        "run",
        Some("agent".to_owned()),
        Some(1),
        30,
        WaitCompletedPayload {
            wait_id: "answered".to_owned(),
            completion_reason: WaitCompletionReason::HumanResponded,
            result: json!("retry"),
        },
    ));
    let ready = RunState::fold("run", spec.clone(), &entries).unwrap();
    let retry = next_actions(&ready, 30);
    let Action::Append(second_started) = &retry[0] else {
        panic!("the answered park must journal a start")
    };
    let second_started: AttemptStartedPayload =
        serde_json::from_value(second_started.payload.clone()).unwrap();
    let Action::Dispatch {
        pins: dispatched,
        recovery,
        ..
    } = &retry[1]
    else {
        panic!("the answered park must dispatch")
    };
    let recovery = recovery.as_ref().expect("agent dispatch carries recovery");
    assert_eq!(second_started.recovery_mode, Some(RecoveryMode::Manual));
    assert_eq!(recovery.mode, RecoveryMode::Inspect);
    assert!(recovery.restore_pins.is_none());
    assert_eq!(dispatched, &dirty);
    assert_eq!(second_started.pins, dirty);
    entries.extend(appends(retry));
    RunState::fold("run", spec.clone(), &entries)
        .expect("the dirty start pin is the pin chain after a manual answer");
}

#[test]
fn deterministic_command_timeout_stays_terminal() {
    let spec = crate::RunSpec::parse(&json!({
        "steps": [{
            "id": "hello",
            "type": "deterministic",
            "command": "printf hello",
            "max_iterations": 5,
            "retry": {
                "initial_backoff_ms": 0,
                "max_backoff_ms": 0,
                "multiplier": 1,
                "jitter_percent": 0,
                "max_transport_retries": 1
            }
        }]
    }))
    .unwrap();
    let mut result = AttemptResult::successful(json!({"exit_code": -1}), "kernel");
    result.failure_reason = Some(CompletionReason::Timeout);
    result.failure_detail = Some("command timed out".to_owned());
    let actions = completion_actions("run", &spec.steps[0], 1, 0, None, result, 10);
    let Action::Append(completed) = &actions[0] else {
        panic!("a command timeout must journal a completion")
    };
    let payload: StepCompletedPayload = serde_json::from_value(completed.payload.clone()).unwrap();
    assert_eq!(payload.completion_reason, CompletionReason::Timeout);
    assert_eq!(payload.disposition, Disposition::StepDone);
}
