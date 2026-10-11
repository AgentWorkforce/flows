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

// ---- `serve --step-env daemon`: a one-run-per-daemon host --------------
//
// Cloud's hosted sandbox spawns one relayflowd per Cloud run with an
// environment it has already sanitized for deterministic steps (repository
// grant and delivered secrets; no agent login or model routing). The flows CLI
// beside it holds agent-only keys that `f.run` must not inherit, so the daemon
// declines client environments. These tests do NOT claim anything about
// same-user processes reaching the socket or /proc/<pid>/environ.

/// What the host gives relayflowd: a write-capable token and a delivered
/// secret, and nothing agent-only.
const HOST_ENV: &[(&str, &str)] = &[
    ("DAEMON_ONLY", "host-chosen"),
    ("RUN_LABEL", "daemon"),
    ("SECRET", "gh-token-for-steps"),
];
const CLIENT_SECRET: &str = "agent-only-s3cret";

fn hello_features(client: &mut ProtocolClient) -> Vec<Value> {
    let hello = client
        .request(
            "hello",
            json!({"protocol": relayflowd_core::PROTOCOL_VERSION, "client": "test"}),
        )
        .unwrap();
    hello["features"].as_array().unwrap().clone()
}

fn refused_with_env(client: &mut ProtocolClient, verb: &str, run_id: &Value) -> Value {
    let params = if verb == "run.start" {
        json!({
            "spec": {"steps": [{"id": "probe", "type": "deterministic", "command": PROBE}]},
            "env": {"OPENAI_BASE_URL": CLIENT_SECRET, "SECRET": CLIENT_SECRET}
        })
    } else {
        json!({"run_id": run_id, "env": {"SECRET": CLIENT_SECRET}})
    };
    client.request_frame(verb, params).unwrap()
}

#[test]
fn a_daemon_policy_host_keeps_steps_on_its_sanitized_env_and_fences_client_env() {
    let fixture = LlmFixture::completed("step-env-daemon-policy");
    let _server = ServerGuard::start_with_args(
        &fixture.data_dir,
        &fixture.socket(),
        HOST_ENV,
        &["--step-env", "daemon"],
    );
    let mut client = ProtocolClient::connect(&fixture.socket());
    let features = hello_features(&mut client);
    assert!(!features.contains(&json!("step_env")), "{features:?}");
    assert!(features.contains(&json!("reported_cost")), "{features:?}");

    // An SDK that honors `features` (2.0.46+) or predates them sends no env:
    // the step runs in the host's environment, secret included.
    let run = start(&mut client, None);
    let expected = format!("daemon|host-chosen|{}", "gh-token-for-steps".len());
    assert_eq!(probe_stdout(&mut client, &run), expected);

    // A second connection (another run on this daemon) gets the same, not
    // anything a client chooses.
    let mut other = ProtocolClient::connect(&fixture.socket());
    let other_run = start(&mut other, None);
    assert_eq!(probe_stdout(&mut other, &other_run), expected);

    // A client that sends env anyway -- non-conforming, or spoofing another
    // run's id on resume -- is refused by name: no silent fallback, no value
    // echoed, nothing written.
    for (verb, target) in [
        ("run.start", &Value::Null),
        ("run.resume", &run["run_id"]),
        ("run.resume", &other_run["run_id"]),
    ] {
        let frame = refused_with_env(&mut client, verb, target);
        assert_eq!(frame["ok"], false, "{verb}: {frame}");
        assert_eq!(
            frame["error"]["code"], "step_env_disabled",
            "{verb}: {frame}"
        );
        assert!(!frame.to_string().contains(CLIENT_SECRET), "{frame}");
    }
    assert_eq!(
        files_containing(&fixture.data_dir, CLIENT_SECRET.as_bytes()),
        Vec::<String>::new(),
        "a refused env value reached disk"
    );
}

#[test]
fn only_the_command_line_selects_the_daemon_policy() {
    // The daemon's environment may carry delivered workspace secrets, so no
    // variable -- whatever its name -- can switch the policy; the default stays
    // the shared-daemon F1 contract.
    let fixture = LlmFixture::completed("step-env-env-cannot-select");
    let _server = ServerGuard::start_with_env(
        &fixture.data_dir,
        &fixture.socket(),
        &[("RELAYFLOWD_STEP_ENV", "daemon"), ("STEP_ENV", "daemon")],
    );
    let mut client = ProtocolClient::connect(&fixture.socket());
    assert!(hello_features(&mut client).contains(&json!("step_env")));
}

#[test]
fn an_unknown_step_env_value_refuses_to_serve() {
    let fixture = LlmFixture::completed("step-env-bad-flag");
    let status = std::process::Command::new(env!("CARGO_BIN_EXE_relayflowd"))
        .args([
            "--data-dir",
            fixture.data_dir.to_str().unwrap(),
            "serve",
            "--step-env",
            "deamon",
        ])
        .status()
        .unwrap();
    assert!(
        !status.success(),
        "a mistyped policy must not start a daemon"
    );
}

#[test]
fn the_daemon_policy_survives_a_restart_because_the_host_respawns_it() {
    let fixture = LlmFixture::completed("step-env-daemon-restart");
    let args = ["--step-env", "daemon"];
    let mut server =
        ServerGuard::start_with_args(&fixture.data_dir, &fixture.socket(), HOST_ENV, &args);
    let mut client = ProtocolClient::connect(&fixture.socket());
    let run = start(&mut client, None);
    let expected = format!("daemon|host-chosen|{}", "gh-token-for-steps".len());
    assert_eq!(probe_stdout(&mut client, &run), expected);
    server.kill();

    // The policy is not state: it is the host's argv, given again on respawn.
    let _server =
        ServerGuard::start_with_args(&fixture.data_dir, &fixture.socket(), HOST_ENV, &args);
    let mut client = ProtocolClient::connect(&fixture.socket());
    assert!(!hello_features(&mut client).contains(&json!("step_env")));
    let resumed = client
        .request("run.resume", json!({"run_id": run["run_id"]}))
        .unwrap();
    assert_eq!(resumed["status"], "completed", "{resumed}");
    let frame = refused_with_env(&mut client, "run.resume", &run["run_id"]);
    assert_eq!(frame["error"]["code"], "step_env_disabled", "{frame}");
    let after = start(&mut client, None);
    assert_eq!(probe_stdout(&mut client, &after), expected);
}
