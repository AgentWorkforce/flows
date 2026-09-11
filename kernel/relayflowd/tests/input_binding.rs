use std::{
    fs,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use relayflowd_core::{EntryType, RunSpec};
use relayflowd_journal::SqliteJournal;
use serde_json::{Value, json};

fn spec() -> Value {
    json!({"steps": [
        {"id": "source", "type": "deterministic", "command": "printf original",
         "verification": {"json_schema": {"type": "object", "properties": {"stdout_tail": {"type": "string"}}}}},
        {"id": "sink", "type": "deterministic", "depends_on": ["source"],
         "input": {"message": {"step": "source", "path": ["stdout_tail"]}},
         "command": "printf '%s' \"$FLOWS_INPUT\""}
    ]})
}

#[test]
fn binding_schema_is_additive_and_fails_closed() {
    let valid = spec();
    RunSpec::parse(&valid).unwrap().validate().unwrap();
    assert!(
        !serde_json::to_value(RunSpec::parse(&valid).unwrap()).unwrap()["steps"][0]
            .as_object()
            .unwrap()
            .contains_key("input")
    );
    for binding in [
        Value::Null,
        json!([]),
        json!({"message": {"step": "source", "path": null}}),
        json!({"message": {"step": "source", "typo": []}}),
    ] {
        let mut bad = valid.clone();
        bad["steps"][1]["input"] = binding;
        assert!(RunSpec::parse(&bad).is_err(), "{bad}");
    }
    for (target, replacement) in [
        ("/steps/1/input/message/step", json!("missing")),
        ("/steps/1/input/message/step", json!("sink")),
        ("/steps/1/input/message/path", json!(["absent"])),
        ("/steps/1/depends_on", json!([])),
        ("/steps/0/verification", json!({})),
    ] {
        let mut bad = valid.clone();
        *bad.pointer_mut(target).unwrap() = replacement;
        assert!(RunSpec::parse(&bad).unwrap().validate().is_err(), "{bad}");
    }
}

#[test]
fn sigkill_before_consumer_resolves_original_journal_output_without_reexecuting_source() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let marker = root.path().join("source-count");
    let artifact = root.path().join("input.json");
    let spec_path = root.path().join("spec.json");
    let mut value = spec();
    value["steps"][0]["command"] = json!(format!(
        "printf x >> '{}'; printf original",
        marker.display()
    ));
    value["steps"][1]["command"] = json!(format!(
        "printf '%s' \"$FLOWS_INPUT\" > '{}'",
        artifact.display()
    ));
    fs::write(&spec_path, serde_json::to_vec(&value).unwrap()).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_relayflowd"))
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "run",
            spec_path.to_str().unwrap(),
            "--pause-before-step",
            "sink",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let journal_path = loop {
        let journals = data.join("runs");
        let found = fs::read_dir(&journals).ok().and_then(|entries| {
            entries.flatten().find_map(|entry| {
                let path = entry.path();
                if path
                    .extension()
                    .is_none_or(|extension| extension != "sqlite3")
                {
                    return None;
                }
                SqliteJournal::open(&path)
                    .ok()
                    .and_then(|journal| journal.scan_all().ok())
                    .and_then(|entries| {
                        entries
                            .iter()
                            .any(|entry| {
                                entry.entry_type == EntryType::StepCompleted
                                    && entry.step_id.as_deref() == Some("source")
                            })
                            .then_some(path)
                    })
            })
        });
        if let Some(path) = found {
            break path;
        }
        if Instant::now() > deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("source did not reach its journaled completion");
        }
        thread::sleep(Duration::from_millis(10));
    };
    child.kill().unwrap(); // SIGKILL, not a graceful SDK stop.
    child.wait().unwrap();
    assert!(!artifact.exists());
    let journal = SqliteJournal::open(&journal_path).unwrap();
    let run_id = journal.run_id().to_owned();
    drop(journal);
    // The authored file is deliberately unusable; resume has only the journal.
    fs::write(&spec_path, "{}").unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_relayflowd"))
        .args(["--data-dir", data.to_str().unwrap(), "resume", &run_id])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(fs::read_to_string(marker).unwrap(), "x");
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(artifact).unwrap()).unwrap(),
        json!({"message": "original"})
    );
    let entries = SqliteJournal::open(&journal_path)
        .unwrap()
        .scan_all()
        .unwrap();
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.entry_type == EntryType::StepCompleted
                && entry.step_id.as_deref() == Some("source"))
            .count(),
        1
    );
}
