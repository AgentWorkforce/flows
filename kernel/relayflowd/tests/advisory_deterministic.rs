//! Repair before failure, end to end (#500 follow-up).
//!
//! `on_non_zero: "record"` is the shape `|| true` was standing in for. The
//! difference this file exists to pin is that the exit code SURVIVES: the
//! journal holds `{exit_code, stdout_tail, stderr_tail}` exactly as the
//! command produced them, a dependent binds that evidence as input instead of
//! re-running the command, and a reader can still tell red from green.

use std::{fs, process::Command};

use relayflowd_core::{EntryType, RunSpec};
use relayflowd_journal::SqliteJournal;
use serde_json::{Value, json};

/// A red probe whose recorded outcome is handed to a repair step.
fn spec(artifact: &std::path::Path, probe_runs: &std::path::Path, record: bool) -> Value {
    let mut probe = json!({
        "id": "probe",
        "type": "deterministic",
        "command": format!(
            "printf x >> '{}'; printf '2 failing'; exit 7",
            probe_runs.display()
        ),
        "verification": {"json_schema": {
            "type": "object",
            "properties": {"exit_code": {"type": "integer"}, "stdout_tail": {"type": "string"}}
        }}
    });
    if record {
        probe["on_non_zero"] = json!("record");
    }
    json!({"steps": [
        probe,
        {
            "id": "repair",
            "type": "deterministic",
            "depends_on": ["probe"],
            "input": {"failure": {"step": "probe"}},
            "command": format!("printf '%s' \"$FLOWS_INPUT\" > '{}'", artifact.display())
        }
    ]})
}

fn run(data: &std::path::Path, spec: &Value) -> std::process::Output {
    let path = data.parent().unwrap().join("spec.json");
    fs::write(&path, serde_json::to_vec(spec).unwrap()).unwrap();
    Command::new(env!("CARGO_BIN_EXE_relayflowd"))
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "run",
            path.to_str().unwrap(),
        ])
        .output()
        .unwrap()
}

fn completion(data: &std::path::Path, step: &str) -> Value {
    let journal = fs::read_dir(data.join("runs"))
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.extension().is_some_and(|extension| extension == "sqlite3"))
        .expect("the run wrote a journal");
    SqliteJournal::open(&journal)
        .unwrap()
        .scan_all()
        .unwrap()
        .into_iter()
        .find(|entry| {
            entry.entry_type == EntryType::StepCompleted && entry.step_id.as_deref() == Some(step)
        })
        .map(|entry| entry.payload)
        .unwrap_or(Value::Null)
}

#[test]
fn a_recorded_red_step_completes_and_hands_its_exit_code_to_the_next_step() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let artifact = root.path().join("input.json");
    let probe_runs = root.path().join("probe-runs");
    let spec = spec(&artifact, &probe_runs, true);
    RunSpec::parse(&spec).unwrap().validate().unwrap();

    let result = run(&data, &spec);
    assert!(
        result.status.success(),
        "a recorded red step must not fail the run: {}",
        String::from_utf8_lossy(&result.stderr)
    );

    // The evidence reached the dependent as journal data, not as a re-run.
    let input: Value = serde_json::from_slice(&fs::read(&artifact).unwrap()).unwrap();
    assert_eq!(input["failure"]["exit_code"], json!(7));
    assert_eq!(input["failure"]["stdout_tail"], json!("2 failing"));
    assert_eq!(fs::read_to_string(&probe_runs).unwrap(), "x");

    // Complete-but-red, and legible as such: the journaled verdict passes so
    // dependents run, while the gate name and detail keep the exit code.
    let probe = completion(&data, "probe");
    assert_eq!(probe["completionReason"], json!("success"));
    assert_eq!(probe["output"]["exit_code"], json!(7));
    assert_eq!(
        probe["verification"]["gate"],
        json!("exit_code:recorded+json_schema")
    );
    assert_eq!(probe["verification"]["verdict"], json!("pass"));
    assert!(
        probe["verification"]["detail"]
            .as_str()
            .is_some_and(|detail| detail.contains('7')),
        "{}",
        probe["verification"]
    );
}

/// The identical flow without the declaration. `record` is opt-in, so an
/// author who does not ask for it keeps the gate that stops a red run.
#[test]
fn the_same_flow_without_the_declaration_still_fails_and_never_reaches_the_dependent() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let artifact = root.path().join("input.json");
    let probe_runs = root.path().join("probe-runs");

    let result = run(&data, &spec(&artifact, &probe_runs, false));
    assert!(!result.status.success());
    assert!(!artifact.exists());
    assert_eq!(completion(&data, "repair"), Value::Null);
    assert_eq!(
        completion(&data, "probe")["verification"]["verdict"],
        json!("fail")
    );
}
