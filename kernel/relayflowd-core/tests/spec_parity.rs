//! The kernel half of the cross-boundary spec-parity gate.
//!
//! `testdata/hello-ladder.spec.canonical.json` is emitted by the SDK compiler
//! (see `packages/sdk/tests/spec-parity.test.ts`). This test proves the kernel parses
//! that exact artifact fail-closed, and that re-serializing it — precisely what
//! the engine hashes when it stamps `spec_hash` in `run.spawned` — reproduces
//! the same canonical bytes and the same sha256 the SDK computed. Together the
//! two tests make the "one spec dialect, one hash" claim a tested fact.

use relayflowd_core::RunSpec;
use serde_json::Value;
use sha2::{Digest, Sha256};

const LADDER_CANONICAL: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../testdata/hello-ladder.spec.canonical.json"
));
const LADDER_SHA256: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../testdata/hello-ladder.spec.sha256"
));

#[test]
fn the_kernel_parses_the_sdk_compiled_spec_and_stamps_the_same_hash() {
    assert_parity(LADDER_CANONICAL, LADDER_SHA256);
}

#[test]
fn the_kernel_parses_the_deterministic_rung_and_stamps_the_same_hash() {
    assert_parity(
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/hello-deterministic.spec.canonical.json"
        )),
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/hello-deterministic.spec.sha256"
        )),
    );
}

#[test]
fn the_kernel_parses_the_rung_b_spec_and_stamps_the_same_hash() {
    assert_parity(
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/hello-llm.spec.canonical.json"
        )),
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/hello-llm.spec.sha256"
        )),
    );
}

#[test]
fn the_kernel_parses_the_rung_c_agent_spec_and_stamps_the_same_hash() {
    assert_parity(
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/hello-agent.spec.canonical.json"
        )),
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/hello-agent.spec.sha256"
        )),
    );
}

#[test]
fn the_kernel_round_trips_declared_agent_transports_and_rejects_unknown_values() {
    for transport in ["direct", "relay"] {
        let value = serde_json::json!({
            "steps": [{
                "id": "agent",
                "type": "agent",
                "instruction": "work",
                "transport": transport,
            }],
        });
        let parsed = RunSpec::parse(&value).expect("declared agent transport must parse");
        parsed
            .validate()
            .expect("declared agent transport must validate");
        assert_eq!(
            serde_json::to_value(parsed).unwrap()["steps"][0]["transport"],
            transport
        );
    }

    let unknown = serde_json::json!({
        "steps": [{
            "id": "agent",
            "type": "agent",
            "instruction": "work",
            "transport": "telepathy",
        }],
    });
    assert!(
        RunSpec::parse(&unknown).is_err(),
        "unknown transport must fail closed"
    );
}

#[test]
fn the_kernel_parses_the_event_triggered_spec_and_stamps_the_same_hash() {
    assert_parity(
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/event-triggered-flow.spec.canonical.json"
        )),
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/event-triggered-flow.spec.sha256"
        )),
    );
}

fn assert_parity(canonical_fixture: &str, expected_hash: &str) {
    let value: Value = serde_json::from_str(canonical_fixture.trim()).unwrap();
    let spec = RunSpec::parse(&value).expect("kernel must parse the SDK's compiled spec");
    spec.validate().expect("the ladder fixture is a valid spec");

    // Re-serialize exactly as the engine does before hashing: Value objects
    // are BTreeMaps, so `to_string` emits sorted keys with no whitespace —
    // the SDK's canonical form.
    let reserialized = serde_json::to_value(&spec).unwrap();
    let canonical = serde_json::to_string(&reserialized).unwrap();
    assert_eq!(
        canonical,
        canonical_fixture.trim(),
        "kernel round-trip must reproduce the SDK's canonical JSON byte-for-byte"
    );

    let hash: String = Sha256::digest(canonical.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(hash, expected_hash.trim(), "spec_hash parity with the SDK");
}

#[test]
fn step_memory_has_identical_canonical_bytes_and_hash() {
    assert_parity(
        include_str!("../../../testdata/step-memory.spec.canonical.json"),
        include_str!("../../../testdata/step-memory.spec.sha256"),
    );
}

#[test]
fn memory_declaration_acceptance_matches_the_sdk_corpus() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../../testdata/memory-spec-cases.json")).unwrap();
    for case in cases {
        let spec = serde_json::json!({"steps":[{"id":"s","type":"deterministic","command":"true","memory":case["memory"]}]});
        let accepted = RunSpec::parse(&spec)
            .and_then(|spec| spec.validate())
            .is_ok();
        assert_eq!(
            accepted,
            case["valid"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn placement_requirements_have_identical_canonical_bytes_and_hash() {
    assert_parity(
        include_str!("../../../testdata/step-placement.spec.canonical.json"),
        include_str!("../../../testdata/step-placement.spec.sha256"),
    );
}

#[test]
fn placement_declaration_acceptance_matches_the_sdk_corpus() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../../testdata/placement-spec-cases.json")).unwrap();
    for case in cases {
        for kind in ["deterministic", "llm", "agent"] {
            let mut step =
                serde_json::json!({"id":"s","type":kind,"requirements":case["requirements"]});
            step[match kind {
                "deterministic" => "command",
                "llm" => "prompt",
                _ => "instruction",
            }] = serde_json::json!("true");
            let accepted = RunSpec::parse(&serde_json::json!({"steps":[step]}))
                .and_then(|s| s.validate())
                .is_ok();
            assert_eq!(
                accepted,
                case["valid"].as_bool().unwrap(),
                "{}: {kind}",
                case["name"]
            );
        }
    }
}

/// flows#357: `cwd` reached the daemon as `unknown field "cwd" at steps[0]`
/// after `flows check` had already passed, because the SDK lowered a field the
/// kernel's closed agent schema did not name. The canonical bytes and hash of a
/// flow that declares it — on two steps and not on a third — are now pinned on
/// both sides of the boundary.
#[test]
fn agent_working_directories_have_identical_canonical_bytes_and_hash() {
    assert_parity(
        include_str!("../../../testdata/agent-cwd.spec.canonical.json"),
        include_str!("../../../testdata/agent-cwd.spec.sha256"),
    );
}

#[test]
fn agent_cwd_declaration_acceptance_matches_the_sdk_corpus() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../../testdata/agent-cwd-cases.json")).unwrap();
    for case in cases {
        let spec = serde_json::json!({"steps":[{
            "id":"s","type":"agent","instruction":"work","cwd":case["cwd"],
        }]});
        let accepted = RunSpec::parse(&spec)
            .and_then(|spec| spec.validate())
            .is_ok();
        assert_eq!(
            accepted,
            case["valid"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
}

/// An absent `cwd` is absent in the re-serialized spec, not `"cwd":null`: every
/// fixture committed before this field existed keeps its bytes and its hash.
#[test]
fn an_undeclared_agent_cwd_is_not_serialized() {
    let value = serde_json::json!({
        "steps": [{"id": "agent", "type": "agent", "instruction": "work"}],
    });
    let parsed = RunSpec::parse(&value).expect("an agent step without cwd must parse");
    parsed.validate().expect("and must validate");
    assert!(
        serde_json::to_value(parsed).unwrap()["steps"][0]
            .get("cwd")
            .is_none()
    );
}

/// `Option<String>` reads an explicit null as absence, which would run the step
/// in the default directory under a spec that declared otherwise. The shape is
/// checked before serde so every non-string spelling fails closed.
#[test]
fn a_non_string_agent_cwd_fails_closed_rather_than_defaulting() {
    for cwd in [
        serde_json::json!(null),
        serde_json::json!(7),
        serde_json::json!(["checkouts/service-a"]),
        serde_json::json!({"path": "checkouts/service-a"}),
        serde_json::json!(true),
    ] {
        let value = serde_json::json!({
            "steps": [{"id": "agent", "type": "agent", "instruction": "work", "cwd": cwd}],
        });
        let error = RunSpec::parse(&value).expect_err("a non-string cwd must fail closed");
        assert!(
            error.to_string().contains("cwd must be a string"),
            "{cwd}: {error}"
        );
    }
}

/// `cwd` is agent-only, and the near-miss spelling is still an unknown field:
/// widening one verb's schema must not quietly widen the others or the name.
#[test]
fn agent_cwd_is_not_accepted_on_other_verbs_or_under_another_name() {
    for step in [
        serde_json::json!({"id":"s","type":"deterministic","command":"true","cwd":"checkouts/a"}),
        serde_json::json!({"id":"s","type":"llm","prompt":"work","cwd":"checkouts/a"}),
        serde_json::json!({"id":"s","type":"agent","instruction":"work","cwdd":"checkouts/a"}),
        serde_json::json!({"id":"s","type":"agent","instruction":"work","worker_cwd":"checkouts/a"}),
    ] {
        assert!(
            RunSpec::parse(&serde_json::json!({"steps": [step.clone()]})).is_err(),
            "{step} must fail closed"
        );
    }
}
