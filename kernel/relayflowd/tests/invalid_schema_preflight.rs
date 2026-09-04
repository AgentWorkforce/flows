#![cfg(unix)]

use std::{
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde_json::{Value, json};

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Refusal {
    response: Value,
    marker_exists: bool,
    registry_exists: bool,
    runs_exists: bool,
    daemon_alive: bool,
}

/// Submit a spec whose only step declares `schema` as its gate, and report what
/// the daemon did with it — including whether the daemon is still running,
/// which is the assertion an unbounded schema used to fail with SIGABRT.
fn submit_gate(schema: Value) -> Refusal {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("command-ran");
    let socket = directory.path().join("relayflowd.sock");
    let spec = json!({
        "steps": [{
            "id": "schema",
            "type": "deterministic",
            "command": format!("touch {}", marker.display()),
            "verification": {"json_schema": schema}
        }]
    });

    let child = Command::new(env!("CARGO_BIN_EXE_relayflowd"))
        .args(["--data-dir", directory.path().to_str().unwrap(), "serve"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut guard = ChildGuard(child);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !socket.exists() {
        assert!(
            Instant::now() < deadline,
            "relayflowd socket was not created"
        );
        thread::sleep(Duration::from_millis(10));
    }

    let mut stream = UnixStream::connect(&socket).unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    writeln!(
        stream,
        "{}",
        json!({"id": "hello", "verb": "hello", "params": {"protocol": 0, "client": "invalid-schema-test"}})
    )
    .unwrap();
    let mut hello = String::new();
    reader.read_line(&mut hello).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&hello).unwrap()["ok"], true);

    let request = json!({"id": "start", "verb": "run.start", "params": {"spec": spec}});
    writeln!(stream, "{request}").unwrap();
    let mut response = String::new();
    let read = reader.read_line(&mut response).unwrap();
    assert!(
        read > 0,
        "the daemon closed the connection without answering run.start — \
         this is the SIGABRT signature the declaration bound exists to prevent"
    );
    let response: Value = serde_json::from_str(&response).unwrap();

    thread::sleep(Duration::from_millis(100));
    let daemon_alive = guard.0.try_wait().unwrap().is_none();

    Refusal {
        response,
        marker_exists: marker.exists(),
        registry_exists: directory.path().join("relayflowd.sqlite3").exists(),
        runs_exists: directory.path().join("runs").exists(),
        daemon_alive,
    }
}

fn assert_refused_before_any_effect(refusal: &Refusal) {
    assert_eq!(refusal.response["ok"], false);
    assert_eq!(refusal.response["error"]["code"], "invalid_spec");
    assert!(
        !refusal.marker_exists,
        "invalid spec must not execute its command"
    );
    assert!(!refusal.registry_exists);
    assert!(!refusal.runs_exists, "invalid spec must not create a journal");
    assert!(
        refusal.daemon_alive,
        "the daemon must survive an invalid declaration"
    );
}

#[test]
fn invalid_json_schema_is_refused_before_journal_or_command() {
    let schema: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../testdata/json-schema-invalid.json"
    )))
    .unwrap();
    assert_refused_before_any_effect(&submit_gate(schema));
}

/// The declaration bound, at the protocol boundary. Before it existed this
/// schema compiled, the journal was created, the step's command ran, and then
/// `verify` recursed until the daemon aborted with SIGABRT — leaving a run
/// stuck `running` that re-executed its effect on every resume.
#[test]
fn unbounded_json_schema_is_refused_before_journal_or_command() {
    let corpus: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../testdata/json-schema-bound-cases.json"
    )))
    .unwrap();
    let marker = corpus["marker"].as_str().unwrap();
    for case in corpus["refused"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let refusal = submit_gate(case["schema"].clone());
        assert_refused_before_any_effect(&refusal);
        let message = refusal.response["error"]["message"]
            .as_str()
            .unwrap_or_default();
        assert!(
            message.contains(marker),
            "{name}: expected a named {marker:?} refusal, got {message}"
        );
    }
}

/// Legitimate recursion must still run. Without this the bound could pass its
/// own refusal test by refusing everything.
#[test]
fn legitimately_recursive_json_schema_still_starts() {
    let corpus: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../testdata/json-schema-bound-cases.json"
    )))
    .unwrap();
    for case in corpus["accepted"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let refusal = submit_gate(case["schema"].clone());
        assert_eq!(
            refusal.response["ok"], true,
            "{name}: must be accepted, got {}",
            refusal.response
        );
        assert!(refusal.daemon_alive, "{name}: daemon must survive");
    }
}
