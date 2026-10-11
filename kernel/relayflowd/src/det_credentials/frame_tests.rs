use serde_json::{Value, json};

use super::*;

const K: &str = "5a1f0c9e7b3d2a4f6e8c1b0d9a7f5e3c2b4d6f8a0c1e3b5d7f9a2c4e6b8d0f1a";
const VALUE: &str = "ghs_fixtureDaemonOnly_7Q2w9E4rT1xY";

fn frame() -> Value {
    json!({
        "version": 1,
        "credentials": {"GH_TOKEN": VALUE},
        "capability": K,
        "pins": {
            "root_authority_sha256": "a".repeat(64),
            "display_fields": ["/name"],
            "root_admission_key": format!("authored-root:{}", "b".repeat(64)),
        },
        "withhold": ["OPENAI_API_KEY"],
        "posture": {
            "schema": "relayflow-host-posture-v1", "yamaPtraceScope": 1,
            "cliNoNewPrivs": true, "daemonNoNewPrivs": true,
            "sudoEscalation": "absent", "sharedUserNamespace": false,
            "observedAt": "2026-10-11T00:00:00Z",
        },
    })
}

fn line(value: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(value).unwrap();
    bytes.push(b'\n');
    bytes
}

fn refusal(bytes: &[u8]) -> Refusal {
    read_frame(bytes).unwrap_err()
}

#[test]
fn a_valid_frame_binds_names_values_k_pins_and_withhold() {
    let (binding, attestation) = read_frame(line(&frame()).as_slice()).unwrap();
    assert_eq!(binding.credentials["GH_TOKEN"].expose(), VALUE);
    assert_eq!(binding.capability.bytes()[0], 0x5a);
    assert_eq!(binding.pins.display_fields, ["/name"]);
    assert!(binding.withhold.contains("OPENAI_API_KEY"));
    assert_eq!(attestation.yama_ptrace_scope, 1);
}

#[test]
fn stream_shape_refusals() {
    assert_eq!(refusal(b"").code, "frame_missing");
    assert_eq!(refusal(b"  \n").code, "frame_malformed");
    assert_eq!(refusal(b"{\"version\":1}").code, "frame_malformed");
    let mut big = vec![b' '; MAX_FRAME_BYTES + 10];
    big.push(b'\n');
    assert_eq!(refusal(&big).code, "frame_too_large");
    let mut trailing = line(&frame());
    trailing.extend_from_slice(b"{}\n");
    assert_eq!(refusal(&trailing).code, "frame_trailing_data");
    let mut whitespace = line(&frame());
    whitespace.extend_from_slice(b" \n");
    assert!(read_frame(whitespace.as_slice()).is_ok());
}

#[test]
fn schema_refusals_name_the_field_never_the_value() {
    type Case = (
        &'static str,
        Box<dyn Fn(&mut Value)>,
        &'static str,
        &'static str,
    );
    let cases: Vec<Case> = vec![
        (
            "version",
            Box::new(|f| f["version"] = json!(2)),
            "version_unsupported",
            "version",
        ),
        (
            "extra",
            Box::new(|f| f["extra"] = json!(1)),
            "frame_malformed",
            "extra",
        ),
        (
            "k short",
            Box::new(|f| f["capability"] = json!("ab")),
            "capability_invalid",
            "capability",
        ),
        (
            "k upper",
            Box::new(|f| f["capability"] = json!(K.to_uppercase())),
            "capability_invalid",
            "capability",
        ),
        (
            "no pins",
            Box::new(|f| {
                f.as_object_mut().unwrap().remove("pins");
            }),
            "pin_missing",
            "pins",
        ),
        (
            "no digest",
            Box::new(|f| {
                f["pins"]
                    .as_object_mut()
                    .unwrap()
                    .remove("root_authority_sha256");
            }),
            "pin_missing",
            "pins.root_authority_sha256",
        ),
        (
            "bad key",
            Box::new(|f| f["pins"]["root_admission_key"] = json!("authored-root:x")),
            "pin_invalid",
            "pins.root_admission_key",
        ),
        (
            "bad pointer",
            Box::new(|f| f["pins"]["display_fields"] = json!(["name"])),
            "pin_invalid",
            "pins.display_fields",
        ),
        (
            "short value",
            Box::new(|f| f["credentials"]["GH_TOKEN"] = json!("short")),
            "credential_invalid",
            "GH_TOKEN",
        ),
        (
            "nul value",
            Box::new(|f| f["credentials"]["GH_TOKEN"] = json!("abcdefgh\u{0}ij")),
            "credential_invalid",
            "GH_TOKEN",
        ),
        (
            "bad name",
            Box::new(|f| f["credentials"] = json!({"gh-token": VALUE})),
            "credential_invalid",
            "gh-token",
        ),
        (
            "protected",
            Box::new(|f| f["credentials"] = json!({"PATH": VALUE})),
            "name_protected",
            "PATH",
        ),
        (
            "protected withhold",
            Box::new(|f| f["withhold"] = json!(["LD_PRELOAD"])),
            "name_protected",
            "LD_PRELOAD",
        ),
        (
            "conflict",
            Box::new(|f| f["withhold"] = json!(["GH_TOKEN"])),
            "name_conflict",
            "GH_TOKEN",
        ),
    ];
    for (what, mutate, code, field) in cases {
        let mut value = frame();
        mutate(&mut value);
        let refused = refusal(&line(&value));
        assert_eq!(
            (refused.code, refused.field.as_str()),
            (code, field),
            "{what}"
        );
        assert!(
            !refused.to_string().contains(VALUE) && !refused.to_string().contains(K),
            "{what}"
        );
    }
}
