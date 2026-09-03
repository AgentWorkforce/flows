use serde_json::{Value, json};

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

const DEEP_DEPENDENCY_GRAPH_LENGTH: usize = 10_000;

fn sdk_boundary_dependency_graph(cyclic: bool) -> RunSpec {
    let steps = (0..DEEP_DEPENDENCY_GRAPH_LENGTH)
        .map(|index| {
            let mut step = json!({
                "id": format!("s{index}"),
                "type": "deterministic",
                "command": "true",
            });
            if index + 1 < DEEP_DEPENDENCY_GRAPH_LENGTH {
                step["depends_on"] = json!([format!("s{}", index + 1)]);
            } else if cyclic {
                step["depends_on"] = json!(["s0"]);
            }
            step
        })
        .collect::<Vec<Value>>();

    RunSpec::parse(&json!({
        "version": "0.1.0",
        "steps": steps,
    }))
    .expect("the SDK-to-kernel boundary shape must parse")
}

#[test]
fn sdk_boundary_accepts_a_valid_10_000_step_reverse_chain() {
    assert_eq!(sdk_boundary_dependency_graph(false).validate(), Ok(()));
}

#[test]
fn sdk_boundary_rejects_a_10_000_step_cycle_with_a_typed_error() {
    assert_eq!(
        sdk_boundary_dependency_graph(true).validate(),
        Err(SpecError::DependencyCycle("s0".to_owned()))
    );
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
        "cli": "claude",
        "triggers": [{"id": "hourly", "executor": "worker-a"}],
        "steps": [
            {"id": "a", "type": "deterministic", "command": "true", "timeout_ms": 5000},
            {"id": "b", "type": "llm", "prompt": "plan", "model": "claude-sonnet-5",
             "cli": "codex",
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
    assert_eq!(spec.cli.as_deref(), Some("claude"));
    assert_eq!(spec.triggers[0].executor, "worker-a");
}

#[test]
fn external_surface_paths_must_have_one_canonical_spelling() {
    for path in [
        "/provider/./item",
        "/provider/../item",
        "/provider//item",
        "/provider/item/",
        " pr://github/example",
    ] {
        let spec = RunSpec::parse(&json!({
            "steps": [{
                "id": "agent",
                "type": "agent",
                "instruction": "write",
                "surfaces": {"external": [path]}
            }]
        }))
        .unwrap();
        assert!(
            matches!(
                spec.validate(),
                Err(SpecError::InvalidExternalSurface { path: invalid, .. }) if invalid == path
            ),
            "accepted non-canonical surface {path:?}"
        );
    }
    for path in ["/provider/item", "pr://github/example", "provider/item"] {
        let spec = RunSpec::parse(&json!({
            "steps": [{
                "id": "agent",
                "type": "agent",
                "instruction": "write",
                "surfaces": {"external": [path]}
            }]
        }))
        .unwrap();
        assert!(
            spec.validate().is_ok(),
            "rejected canonical surface {path:?}"
        );
    }
    assert!(external_surface_contains(
        "/provider/item",
        "/provider/item/child"
    ));
    assert!(!external_surface_contains(
        "/provider/item",
        "/provider/other"
    ));
    assert!(!external_surface_contains(
        "/provider/item",
        "/provider/./item"
    ));
}

#[test]
fn workspace_mounts_and_worktrees_must_have_one_canonical_spelling() {
    for surface in [
        "/mount/./repo",
        "/mount/repo/../repo",
        "/mount//repo",
        "/mount/repo/",
        " worktrees/repo",
        "worktrees/./repo",
    ] {
        let spec = RunSpec::parse(&json!({
            "steps": [{
                "id": "agent",
                "type": "agent",
                "instruction": "write",
                "surfaces": {"workspace": [{"surface": surface}]}
            }]
        }))
        .unwrap();
        assert!(
            matches!(
                spec.validate(),
                Err(SpecError::InvalidWorkspaceSurface { surface: invalid, .. })
                    if invalid == surface
            ),
            "accepted non-canonical workspace surface {surface:?}"
        );
    }
    for surface in ["/mount/repo", "worktrees/repo", "repo"] {
        let spec = RunSpec::parse(&json!({
            "steps": [{
                "id": "agent",
                "type": "agent",
                "instruction": "write",
                "surfaces": {"workspace": [{"surface": surface}]}
            }]
        }))
        .unwrap();
        assert!(spec.validate().is_ok(), "rejected {surface:?}");
    }
}

#[test]
fn preflight_data_is_fail_closed() {
    let malformed = RunSpec::parse(&json!({
        "triggers": [{"id": "hourly", "executor": "worker-a", "worker": "guessed"}],
        "steps": [{"id": "a", "type": "llm", "prompt": "p", "cli": ""}]
    }));
    assert!(
        matches!(malformed, Err(SpecError::Malformed(ref message)) if message.contains("unknown field `worker`")),
        "{malformed:?}"
    );

    let empty_flow_cli = RunSpec::parse(&json!({
        "cli": "",
        "steps": [{"id": "a", "type": "deterministic", "command": "true"}]
    }))
    .unwrap();
    assert_eq!(empty_flow_cli.validate(), Err(SpecError::EmptyCli));

    for (id, executor) in [("", "worker-a"), ("hourly", "")] {
        let invalid_trigger = RunSpec::parse(&json!({
            "triggers": [{"id": id, "executor": executor}],
            "steps": [{"id": "a", "type": "deterministic", "command": "true"}]
        }))
        .unwrap();
        assert_eq!(
            invalid_trigger.validate(),
            Err(SpecError::InvalidTrigger(id.to_owned()))
        );
    }

    let duplicate_trigger = RunSpec::parse(&json!({
        "triggers": [
            {"id": "hourly", "executor": "worker-a"},
            {"id": "hourly", "executor": "worker-b"}
        ],
        "steps": [{"id": "a", "type": "deterministic", "command": "true"}]
    }))
    .unwrap();
    assert_eq!(
        duplicate_trigger.validate(),
        Err(SpecError::DuplicateTrigger("hourly".to_owned()))
    );

    let empty_cli = RunSpec::parse(&json!({
        "steps": [{"id": "a", "type": "llm", "prompt": "p", "cli": ""}]
    }))
    .unwrap();
    assert_eq!(
        empty_cli.validate(),
        Err(SpecError::EmptyStepCli("a".to_owned()))
    );
}
