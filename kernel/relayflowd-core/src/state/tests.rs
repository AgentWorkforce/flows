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
