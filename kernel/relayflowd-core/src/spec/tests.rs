use serde_json::json;

use super::*;

#[test]
fn zero_agent_flow_is_valid() {
    let spec = RunSpec::parse(&json!({
        "steps": [{"id": "hello", "type": "deterministic", "command": "printf hello"}]
    }))
    .unwrap();
    assert_eq!(spec.steps[0].max_iterations, 1);
    assert!(spec.validate().is_ok());
}

#[test]
fn cycles_are_rejected() {
    let spec = RunSpec::parse(&json!({
        "steps": [
            {"id": "a", "type": "deterministic", "command": "true", "depends_on": ["b"]},
            {"id": "b", "type": "deterministic", "command": "true", "depends_on": ["a"]}
        ]
    }))
    .unwrap();
    assert!(matches!(
        spec.validate(),
        Err(SpecError::DependencyCycle(_))
    ));
}

#[test]
fn a_misspelled_verification_gate_key_is_a_parse_error_not_a_dropped_gate() {
    // The fail-open refutation case: "output_contain" (typo) must never
    // silently deserialize to an empty VerificationSpec.
    let result = RunSpec::parse(&json!({
        "steps": [{
            "id": "hello",
            "type": "deterministic",
            "command": "printf hello",
            "verification": {"output_contain": "hello"}
        }]
    }));
    assert!(
        matches!(result, Err(SpecError::Malformed(ref message)) if message.contains("output_contain")),
        "{result:?}"
    );
}

#[test]
fn a_misspelled_step_level_key_is_a_parse_error() {
    // `#[serde(flatten)]` would silently eat "verifcation"; RunSpec::parse
    // must not.
    let result = RunSpec::parse(&json!({
        "steps": [{
            "id": "hello",
            "type": "deterministic",
            "command": "printf hello",
            "verifcation": {"output_contains": "hello"}
        }]
    }));
    assert_eq!(
        result,
        Err(SpecError::UnknownField {
            at: "steps[0]".to_owned(),
            field: "verifcation".to_owned(),
        })
    );
}

#[test]
fn unknown_root_and_nested_fields_are_rejected() {
    assert!(RunSpec::parse(&json!({"steps": [], "extra": true})).is_err());
    assert!(
        RunSpec::parse(&json!({
            "steps": [{
                "id": "a", "type": "agent", "instruction": "do",
                "surfaces": {"workspaces": [{"surface": "repo/"}]}
            }]
        }))
        .is_err()
    );
}

#[test]
fn spec_version_is_semver_and_gated() {
    let spec = RunSpec::parse(&json!({
        "version": "9.9.9",
        "steps": [{"id": "a", "type": "deterministic", "command": "true"}]
    }))
    .unwrap();
    assert_eq!(
        spec.validate(),
        Err(SpecError::UnsupportedVersion("9.9.9".to_owned()))
    );
}

#[test]
fn the_full_ladder_parses_in_the_one_dialect() {
    let spec = RunSpec::parse(&json!({
        "version": "0.1.0",
        "name": "ladder",
        "steps": [
            {"id": "a", "type": "deterministic", "command": "true", "timeout_ms": 5000},
            {"id": "b", "type": "llm", "prompt": "plan", "model": "claude-sonnet-5",
             "depends_on": ["a"], "verification": {"json_schema": {"type": "object"}}},
            {"id": "c", "type": "agent", "instruction": "edit", "depends_on": ["b"],
             "recovery_mode": "inspect",
             "surfaces": {"workspace": [{"surface": "repo/"}], "streams": [{"stream": "results"}],
                          "external": ["pr://github/example"]},
             "permissions": {"access_preset": "readwrite", "file_globs": ["src/**"]}}
        ],
        "budget": {"max_tokens_out": 2000, "max_dollars": "1.50"}
    }))
    .unwrap();
    assert!(spec.validate().is_ok());
    assert_eq!(spec.steps[2].step_type(), StepType::Agent);
}
