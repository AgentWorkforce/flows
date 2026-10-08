use serde_json::{Value, json};
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn check(value: &[u8], data_dir: &std::path::Path) -> (i32, Value) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_relayflowd"))
        .arg("--data-dir")
        .arg(data_dir)
        .arg("validate-spec")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(value).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.stderr.is_empty(), "{:?}", output);
    let verdict: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(verdict.get("run_id").is_none());
    assert_eq!(verdict["protocol"], 0);
    assert_eq!(verdict["spec_version"], "0.1.0");
    (output.status.code().unwrap(), verdict)
}

#[test]
fn accepts_without_creating_data_directory_or_journal() {
    let root = tempfile::tempdir().unwrap();
    let absent = root.path().join("absent");
    let source = include_bytes!("../../../testdata/hello-agent.spec.canonical.json");
    let (code, verdict) = check(source, &absent);
    assert_eq!(code, 0);
    assert_eq!(
        verdict,
        json!({"ok": true, "protocol": 0, "spec_version": "0.1.0"})
    );
    assert!(!absent.exists());
    check(source, root.path());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn refuses_unknown_field_with_kernel_location() {
    let root = tempfile::tempdir().unwrap();
    let mut spec: Value = serde_json::from_slice(include_bytes!(
        "../../../testdata/hello-agent.spec.canonical.json"
    ))
    .unwrap();
    spec["steps"][1]["nope"] = json!(true);
    let (code, verdict) = check(&serde_json::to_vec(&spec).unwrap(), root.path());
    assert_eq!(code, 2);
    assert_eq!(verdict["error"]["code"], "invalid_spec");
    assert!(
        verdict["error"]["message"]
            .as_str()
            .unwrap()
            .contains("unknown field \"nope\" at steps[1]")
    );
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn refuses_semantic_errors_and_malformed_json() {
    let root = tempfile::tempdir().unwrap();
    let mut spec: Value = serde_json::from_slice(include_bytes!(
        "../../../testdata/hello-agent.spec.canonical.json"
    ))
    .unwrap();
    spec["steps"][1]["cwd"] = json!("/absolute");
    let (code, verdict) = check(&serde_json::to_vec(&spec).unwrap(), root.path());
    assert_eq!(code, 2);
    assert!(
        verdict["error"]["message"]
            .as_str()
            .unwrap()
            .contains("working directory \"/absolute\"")
    );
    assert_eq!(check(b"{", root.path()).0, 2);
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}
