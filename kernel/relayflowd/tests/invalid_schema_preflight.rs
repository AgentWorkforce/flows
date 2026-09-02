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

#[test]
fn invalid_json_schema_is_refused_before_journal_or_command() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("command-ran");
    let socket = directory.path().join("relayflowd.sock");
    let schema: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../testdata/json-schema-invalid.json"
    )))
    .unwrap();
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
    let _guard = ChildGuard(child);
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
    reader.read_line(&mut response).unwrap();
    let response: Value = serde_json::from_str(&response).unwrap();

    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "invalid_spec");
    assert!(
        !marker.exists(),
        "invalid spec must not execute its command"
    );
    assert!(!directory.path().join("relayflowd.sqlite3").exists());
    assert!(!directory.path().join("runs").exists());
}
