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
