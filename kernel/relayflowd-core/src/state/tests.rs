use serde_json::json;

use super::*;
use crate::entry::{Pins, StepCompletedPayload, VerificationRecord, VerificationVerdict};

fn spec() -> RunSpec {
    serde_json::from_value(json!({
        "steps": [
            {"id": "one", "type": "deterministic", "command": "true"},
            {"id": "two", "type": "deterministic", "command": "true", "depends_on": ["one"]}
        ]
    }))
    .unwrap()
}

#[test]
fn completed_output_is_memoized_and_unlocks_dependents() {
    let completion = JournalEntry::new(
        EntryType::StepCompleted,
        "run",
        Some("one".to_owned()),
        Some(1),
        5,
        StepCompletedPayload {
            completion_reason: CompletionReason::Success,
            disposition: Disposition::StepDone,
            output: json!({"exit_code": 0, "stdout_tail": "once"}),
            verification: Some(VerificationRecord {
                gate: "exit_code".to_owned(),
                verdict: VerificationVerdict::Pass,
                detail: "passed".to_owned(),
            }),
            end_pins: Some(Pins::default()),
            effects: vec![],
            trajectory_tail: None,
            budget: Budget::default(),
            completed_by: "kernel".to_owned(),
            next_attempt_at_ms: None,
        },
    );
    let state = RunState::fold("run", spec(), &[completion]).unwrap();
    assert_eq!(
        state.successful_output("one").unwrap()["stdout_tail"],
        "once"
    );
    assert_eq!(state.steps["two"].state, StepState::Runnable);
}

#[test]
fn budget_decimal_strings_add_without_floats() {
    let mut total = Budget::default();
    add_budget(
        &mut total,
        &Budget {
            tokens_in: 2,
            tokens_out: 3,
            dollars: "0.015".to_owned(),
        },
    )
    .unwrap();
    add_budget(
        &mut total,
        &Budget {
            tokens_in: 1,
            tokens_out: 1,
            dollars: "1.2".to_owned(),
        },
    )
    .unwrap();
    assert_eq!(total.dollars, "1.215");
    assert_eq!(total.tokens_in, 3);
}

#[test]
fn end_pin_chain_is_enforced_and_a_broken_chain_is_a_hard_error() {
    let spec = RunSpec::parse(&json!({
        "steps": [
            {
                "id": "edit",
                "type": "agent",
                "instruction": "edit",
                "surfaces": {"workspace": [{"surface": "repo"}]}
            },
            {
                "id": "review",
                "type": "agent",
                "instruction": "review",
                "depends_on": ["edit"],
                "surfaces": {"workspace": [{"surface": "repo"}]}
            }
        ]
    }))
    .unwrap();
    let start_pin = Pins {
        workspace: vec![crate::WorkspacePin {
            surface: "repo".to_owned(),
            revision_id: "rev-a".to_owned(),
        }],
        streams: vec![],
    };
    let end_pin = Pins {
        workspace: vec![crate::WorkspacePin {
            surface: "repo".to_owned(),
            revision_id: "rev-b".to_owned(),
        }],
        streams: vec![],
    };
    let fresh = RunState::fold("run", spec.clone(), &[]).unwrap();
    let crate::Action::Append(mut first_started) = crate::next_actions(&fresh, 1).remove(0) else {
        panic!("first agent start")
    };
    let mut started_payload: crate::AttemptStartedPayload =
        serde_json::from_value(first_started.payload.clone()).unwrap();
    started_payload.pins = start_pin;
    first_started.payload = serde_json::to_value(started_payload).unwrap();
    let mut result = crate::AttemptResult::successful(json!({"edited": true}), "worker");
    result.end_pins = Some(end_pin.clone());
    let crate::Action::Append(first_completed) =
        crate::completion_actions("run", &spec.steps[0], 1, 0, result, 2).remove(0)
    else {
        panic!("first agent completion")
    };
    let state = RunState::fold(
        "run",
        spec.clone(),
        &[first_started.clone(), first_completed.clone()],
    )
    .unwrap();
    let actions = crate::next_actions(&state, 3);
    let crate::Action::Append(correct_start) = &actions[0] else {
        panic!("second agent start")
    };
    let correct: crate::AttemptStartedPayload =
        serde_json::from_value(correct_start.payload.clone()).unwrap();
    assert_eq!(correct.pins, end_pin);

    let mut broken_start = correct_start.clone();
    let mut broken: crate::AttemptStartedPayload =
        serde_json::from_value(broken_start.payload.clone()).unwrap();
    broken.pins.workspace[0].revision_id = "rev-unproduced".to_owned();
    broken_start.payload = serde_json::to_value(broken).unwrap();
    let error =
        RunState::fold("run", spec, &[first_started, first_completed, broken_start]).unwrap_err();
    assert!(matches!(error, StateError::BrokenPinChain { .. }));
}
