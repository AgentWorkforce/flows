use relayflowd_core::{
    Action, AttemptResult, EntryType, RunSpec, RunState, completion_actions, memoization::*,
};
use serde_json::{Value, json};

#[test]
fn canonical_corpus_agrees_with_typescript_and_key_permutations() {
    for corpus in [
        include_str!("../../../testdata/canonical/step-canonical-cases.json"),
        include_str!("../../../testdata/canonical/input-canonical-cases.json"),
    ] {
        for case in serde_json::from_str::<Vec<Value>>(corpus).unwrap() {
            assert_eq!(
                canonicalize(&case["value"]),
                case["canonical"].as_str().unwrap(),
                "{}",
                case["name"]
            );
            assert_eq!(
                canonical_hash(&case["value"]),
                case["sha256"].as_str().unwrap(),
                "{}",
                case["name"]
            );
            if let Some(object) = case["value"].as_object() {
                let reverse = object
                    .iter()
                    .rev()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                assert_eq!(
                    canonical_hash(&Value::Object(reverse)),
                    canonical_hash(&case["value"])
                );
            }
        }
    }
}

fn state() -> RunState {
    let spec =
        RunSpec::parse(&json!({"name":"flow","steps":[{"id":"a","type":"llm","prompt":"hello"}]}))
            .unwrap();
    RunState::fold("new", spec, &[]).unwrap()
}
fn source(state: &RunState) -> relayflowd_core::JournalEntry {
    let step = &state.spec.steps[0];
    let Action::Append(mut entry) = completion_actions(
        "old",
        step,
        1,
        0,
        AttemptResult::successful(json!("answer"), "worker"),
        1,
    )
    .remove(0) else {
        panic!()
    };
    entry.seq = 7;
    entry.payload["step_spec_hash"] = step_spec_hash(step).into();
    entry.payload["input_hash"] = canonical_hash(&json!({})).into();
    entry.payload["budget"] = json!({"tokens_in":10,"tokens_out":20,"dollars":"1.25"});
    entry
}
#[test]
fn match_reuses_output_with_provenance_and_zero_cost_without_dispatch() {
    let state = state();
    let actions = next_actions_with_reuse(&state, &candidates(&[source(&state)]).unwrap(), 20);
    assert_eq!(actions.len(), 1);
    let Action::Append(entry) = &actions[0] else {
        panic!()
    };
    assert_eq!(entry.entry_type, EntryType::StepCompleted);
    assert_eq!(entry.payload["output"], "answer");
    assert_eq!(
        entry.payload["reused_from"],
        json!({"run_id":"old","step_id":"a","seq":7})
    );
    assert_eq!(entry.payload["budget"]["tokens_in"], 0);
    let folded = RunState::fold("new", state.spec, &[entry.clone()]).unwrap();
    assert!(folded.all_steps_succeeded());
}
#[test]
fn changed_spec_or_input_dispatches_and_legacy_or_failed_records_miss() {
    let state = state();
    for field in ["step_spec_hash", "input_hash"] {
        let mut prior = source(&state);
        prior.payload[field] = "different".into();
        assert!(
            next_actions_with_reuse(&state, &[prior], 20)
                .iter()
                .any(|a| matches!(a, Action::Dispatch { .. }))
        );
    }
    let mut legacy = source(&state);
    legacy
        .payload
        .as_object_mut()
        .unwrap()
        .remove("step_spec_hash");
    assert!(candidates(&[legacy]).unwrap().is_empty());
    let mut failed = source(&state);
    failed.payload["completionReason"] = "worker_error".into();
    assert!(candidates(&[failed]).unwrap().is_empty());
}

#[test]
fn distinct_large_kernel_integers_do_not_alias_through_float_rounding() {
    assert_ne!(
        canonical_hash(&json!(9_007_199_254_740_992_u64)),
        canonical_hash(&json!(9_007_199_254_740_993_u64))
    );
}
