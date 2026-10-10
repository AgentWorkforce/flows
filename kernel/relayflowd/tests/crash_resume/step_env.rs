//! F1: on a shared daemon, each run's `f.run` steps spawn with THAT run's
//! client-supplied environment, never the environment of the CLI that started
//! the daemon or of another attached run -- and the values reach no file.

use std::{fs, path::Path};

use serde_json::{Value, json};

use super::llm_support::{LlmFixture, ProtocolClient, ServerGuard};

/// Prints the label, the daemon-only variable, and the secret's LENGTH: the
/// step's stdout is journaled, so the secret itself must never be printed.
const PROBE: &str =
    r#"printf '%s|%s|%s' "${RUN_LABEL:-unset}" "${DAEMON_ONLY:-unset}" "${#SECRET}""#;

fn start(client: &mut ProtocolClient, env: Option<Value>) -> Value {
    let mut params = json!({"spec": {
        "steps": [{"id": "probe", "type": "deterministic", "command": PROBE}]
    }});
    if let Some(env) = env {
        params["env"] = env;
    }
    client.request("run.start", params).unwrap()
}

fn probe_stdout(client: &mut ProtocolClient, run: &Value) -> String {
    assert_eq!(run["status"], "completed", "{run}");
    let entries = client
        .request("journal.read", json!({"run_id": run["run_id"]}))
        .unwrap();
    entries["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["entry_type"] == "step.completed")
        .map(|entry| {
            entry["payload"]["output"]["stdout_tail"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .expect("probe completed")
}

fn files_containing(dir: &Path, needle: &[u8]) -> Vec<String> {
    let mut hits = vec![];
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            hits.extend(files_containing(&path, needle));
        } else if let Ok(bytes) = fs::read(&path) {
            if bytes.windows(needle.len()).any(|window| window == needle) {
                hits.push(path.display().to_string());
            }
        }
    }
    hits
}

#[test]
fn each_attached_run_spawns_steps_with_its_own_env() {
    let fixture = LlmFixture::completed("step-env");
    let _server = ServerGuard::start_with_env(
        &fixture.data_dir,
        &fixture.socket(),
        &[("DAEMON_ONLY", "from-first-cli"), ("RUN_LABEL", "daemon")],
    );
    let secret_a = "sa-7f3e9c1b";
    let secret_b = "sb-0d4a8e6f2c95";
    let mut first = ProtocolClient::connect(&fixture.socket());
    let mut second = ProtocolClient::connect(&fixture.socket());

    let run_a = start(
        &mut first,
        Some(json!({"RUN_LABEL": "a", "SECRET": secret_a})),
    );
    let run_b = start(
        &mut second,
        Some(json!({"RUN_LABEL": "b", "SECRET": secret_b})),
    );
    // A client that sends no env (pre-`step_env`) keeps the old behavior.
    let legacy = start(&mut second, None);

    // The supplied env replaces the daemon's: DAEMON_ONLY does not leak in.
    assert_eq!(
        probe_stdout(&mut first, &run_a),
        format!("a|unset|{}", secret_a.len())
    );
    assert_eq!(
        probe_stdout(&mut second, &run_b),
        format!("b|unset|{}", secret_b.len())
    );
    assert_eq!(
        probe_stdout(&mut second, &legacy),
        "daemon|from-first-cli|0"
    );

    for secret in [secret_a, secret_b] {
        assert_eq!(
            files_containing(&fixture.data_dir, secret.as_bytes()),
            Vec::<String>::new(),
            "a step env value reached disk"
        );
    }
}

#[test]
fn an_unspawnable_env_is_refused_without_echoing_its_value() {
    let fixture = LlmFixture::completed("step-env-invalid");
    let _server = ServerGuard::start(&fixture);
    let mut client = ProtocolClient::connect(&fixture.socket());
    let frame = client
        .request_frame(
            "run.start",
            json!({
                "spec": {"steps": [{"id": "probe", "type": "deterministic", "command": "true"}]},
                "env": {"K": "s3cret\u{0}tail"}
            }),
        )
        .unwrap();
    assert_eq!(frame["ok"], false, "{frame}");
    assert_eq!(frame["error"]["code"], "bad_request");
    assert!(!frame.to_string().contains("s3cret"), "{frame}");
}

#[test]
fn hello_advertises_step_env() {
    let fixture = LlmFixture::completed("step-env-hello");
    let _server = ServerGuard::start(&fixture);
    let mut client = ProtocolClient::connect(&fixture.socket());
    let hello = client
        .request(
            "hello",
            json!({"protocol": relayflowd_core::PROTOCOL_VERSION, "client": "test"}),
        )
        .unwrap();
    assert!(
        hello["features"]
            .as_array()
            .unwrap()
            .contains(&json!("step_env")),
        "{hello}"
    );
}
