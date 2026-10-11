//! The proposal's interface, as the fixture drives it (proposal §4-§6):
//! the host's stdin frame, the root authority pin, challenge-response
//! authentication with K, child linkage, withholding, and spec/env builders.
//! None of this exists in the kernel yet.

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::harness::{Fixture, Wire};

/// The daemon-only credential the host binds (Cloud: the Babysitter token).
pub const BOUND: &str = "GH_TOKEN";
pub const BOUND_VALUE: &str = "ghs_fixtureDaemonOnly_7Q2w9E4rT1xY";
/// The root's kernel admission key: host-RESERVED so it cannot be squatted.
/// It gives idempotent admission only and is never authentication.
pub const ROOT_KEY: &str =
    "authored-root:00f1a7e5f1a7e5f1a7e5f1a7e5f1a7e5f1a7e5f1a7e5f1a7e5f1a7e5f1a7e5f1";
/// K: 32 random bytes (hex) per daemon lifetime, in the frame and on the
/// legitimate CLI's fd 3 only. It never crosses the socket.
pub const ROOT_SECRET: &str = "5a1f0c9e7b3d2a4f6e8c1b0d9a7f5e3c2b4d6f8a0c1e3b5d7f9a2c4e6b8d0f1a";
/// The new K a Cloud resume mints; the old K must be refused after restore.
pub const ROOT_SECRET_AFTER_RESTART: &str =
    "c3e5a7b9d1f2e4c6a8b0d2f4e6c8a0b2d4f6e8a1c3e5b7d9f0a2c4e6b8d1f3a5";
/// The journal proof purpose; a worker peer proves `worker-peer:<J>` where J
/// is the journal session id the daemon minted for that journal (§4.3.1).
pub const JOURNAL: &str = "journal";

pub fn peer_purpose(journal_session: &str) -> String {
    format!("worker-peer:{journal_session}")
}

/// Agent-only keys the CLI env carries and the host withholds: static agent
/// login (cloud relayflow-v2-step-env.ts AGENT_ENV_KEYS), a house-proxy
/// pickup key (:249) and the serialized house credential.
pub const AGENT_ONLY: &[(&str, &str)] = &[
    ("ANTHROPIC_API_KEY", "sk-ant-fixtureAgentOnly-5Tz8Lm2Q"),
    ("OPENAI_API_KEY", "sk-fixtureAgentOnly-openai-3Kd1Vb7"),
    ("CLAUDE_CODE_OAUTH_TOKEN", "fixture-oauth-agent-only-9HqW4e"),
    ("XAI_API_KEY", "xai-fixtureHousePickup-2Rw7Kp4"),
    (
        "HOUSE_PROXY_CREDENTIAL",
        "fixture-house-proxy-credential-8Vn3",
    ),
];
/// Ordinary names in BOTH Cloud envs: they keep the per-run env path (F1).
pub const DELIVERED: (&str, &str) = ("DELIVERED_SECRET", "delivered-fixture-value-81Jx");
pub const REPOSITORY: &[(&str, &str)] = &[
    ("GH_CONFIG_DIR", "/fixture/gh-config"),
    ("GIT_CONFIG_NOSYSTEM", "1"),
];
/// Prints a checksum of the bound credential, never the credential.
pub const PROBE: &str =
    r#"if [ -n "${GH_TOKEN+x}" ]; then printf '%s' "$GH_TOKEN" | cksum; else printf unset; fi"#;

/// The host's declaration. argv carries only `--det-frame-stdin`; everything
/// else is in one stdin frame (proposal §4.1).
pub struct Binding {
    pub credentials: Vec<(&'static str, &'static str)>,
    /// The exact root the host pins, and the display fields excluded from it.
    pub root_spec: Option<Value>,
    pub display_fields: Vec<&'static str>,
    pub secret: Option<&'static str>,
    /// False models a host that asks for a frame and sends none.
    pub send_frame: bool,
    pub withhold: Vec<&'static str>,
    /// Replaces the default (supported) posture attestation.
    pub posture: Option<Value>,
    /// The host's argv `--det-withhold` set; `None` means the same names as
    /// the frame's `withhold`.
    pub argv_withhold: Option<Vec<&'static str>>,
}

/// What Cloud's bootstrap would declare for a Babysitter run rooted at `root`.
pub fn cloud_binding(root: &Value) -> Binding {
    Binding {
        credentials: vec![(BOUND, BOUND_VALUE)],
        root_spec: Some(root.clone()),
        display_fields: vec![],
        secret: Some(ROOT_SECRET),
        send_frame: true,
        withhold: AGENT_ONLY.iter().map(|(name, _)| *name).collect(),
        posture: None,
        argv_withhold: None,
    }
}

impl Binding {
    pub(super) fn args(&self) -> Vec<String> {
        let mut args: Vec<String> = ["--det-frame-stdin", "--det-ack-fd", "3"]
            .map(str::to_owned)
            .to_vec();
        let withhold = self.argv_withhold.as_ref().unwrap_or(&self.withhold);
        if !withhold.is_empty() {
            args.extend(["--det-withhold".to_owned(), withhold.join(",")]);
        }
        args
    }

    /// One JSON line. Fields the test leaves out model a host that omitted them.
    pub(super) fn frame(&self) -> Option<String> {
        if !self.send_frame {
            return None;
        }
        let mut pins =
            json!({"root_admission_key": ROOT_KEY, "display_fields": self.display_fields});
        if let Some(root) = &self.root_spec {
            pins["root_authority_sha256"] = json!(authority_sha256(root, &self.display_fields));
        }
        // The host's posture attestation (wire §1.2), consistent with how the
        // harness starts the daemon (no_new_privs) and this machine's Yama.
        let yama: i64 = std::fs::read_to_string("/proc/sys/kernel/yama/ptrace_scope")
            .map_or(0, |text| text.trim().parse().unwrap_or(0));
        let posture = self.posture.clone().unwrap_or(json!({
            "schema": "relayflow-host-posture-v1", "yamaPtraceScope": yama,
            "cliNoNewPrivs": true, "daemonNoNewPrivs": true, "sudoEscalation": "absent",
            "sharedUserNamespace": false, "observedAt": "2026-10-11T00:00:00Z",
        }));
        let mut frame =
            json!({"version": 1, "pins": pins, "withhold": self.withhold, "posture": posture});
        if let Some(secret) = self.secret {
            frame["capability"] = json!(secret);
        }
        frame["credentials"] = self
            .credentials
            .iter()
            .map(|(name, value)| ((*name).to_owned(), json!(value)))
            .collect();
        Some(format!("{frame}\n"))
    }
}

/// The published normalization (proposal §4.3): every step `instruction`
/// that parses as a JSON object is replaced by that object, then each
/// display field (a JSON pointer) is removed; the digest is sha256 of the
/// kernel's canonical JSON. On main the kernel cannot even parse a spec with
/// det `credentials`, which this reports as the interface being absent.
pub fn authority_sha256(spec: &Value, display_fields: &[&str]) -> String {
    let parsed = relayflowd_core::RunSpec::parse(spec).unwrap_or_else(|error| {
        panic!(
            "DESIGN FIXTURE: this kernel cannot parse the pinned root spec, so the deterministic \
             `credentials` field from {} is absent: {error}",
            super::harness::PROPOSAL
        )
    });
    let mut value = serde_json::to_value(parsed).unwrap();
    for step in value["steps"].as_array_mut().unwrap() {
        if let Some(Ok(Value::Object(object))) = step
            .get("instruction")
            .and_then(Value::as_str)
            .map(serde_json::from_str::<Value>)
        {
            step["instruction"] = Value::Object(object);
        }
    }
    for pointer in display_fields {
        let (parent, field) = pointer.rsplit_once('/').unwrap();
        if let Some(Value::Object(object)) = value.pointer_mut(parent) {
            object.remove(field);
        }
    }
    relayflowd_core::memoization::canonical_hash(&value)
}

fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}

/// HMAC-SHA256 (RFC 2104), hex.
fn hmac(key: &[u8], message: &[u8]) -> String {
    let mut block = [0u8; 64];
    block[..key.len()].copy_from_slice(key);
    let pad = |byte: u8| block.iter().map(|k| k ^ byte).collect::<Vec<_>>();
    let inner = Sha256::new()
        .chain_update(pad(0x36))
        .chain_update(message)
        .finalize();
    let outer = Sha256::new()
        .chain_update(pad(0x5c))
        .chain_update(inner)
        .finalize();
    outer.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The proof for one nonce: HMAC-SHA256(K, "relayflowd-auth-v1" 0x00
/// purpose 0x00 nonce), hex (proposal §4.3.1).
pub fn proof(secret: &str, purpose: &str, nonce: &str) -> String {
    let message = format!("relayflowd-auth-v1\0{purpose}\0{nonce}");
    hmac(&hex_bytes(secret), message.as_bytes())
}

/// A fresh single-use nonce from `hello` (proposal §4.3.1).
pub fn nonce(wire: &mut Wire) -> String {
    let hello = hello(wire);
    hello["auth_nonce"]
        .as_str()
        .unwrap_or_else(|| panic!("hello carries no auth_nonce: {hello}"))
        .to_owned()
}

pub fn hello(wire: &mut Wire) -> Value {
    wire.request(
        "hello",
        json!({"protocol": relayflowd_core::PROTOCOL_VERSION, "client": "design-fixture"}),
    )
    .unwrap()
}

pub fn prove_params(purpose: &str, mac: &str) -> Value {
    json!({"purpose": purpose, "mac": mac})
}

/// Authenticate THIS connection for `purpose` (challenge-response; K never
/// crosses the socket). Returns the daemon's result.
pub fn authenticate(wire: &mut Wire, secret: &str, purpose: &str) -> anyhow::Result<Value> {
    let nonce = nonce(wire);
    let mac = proof(secret, purpose, &nonce);
    wire.request("auth.prove", prove_params(purpose, &mac))
}

/// Authenticate a journal connection; returns its daemon-minted session id J.
pub fn authenticate_journal(wire: &mut Wire, secret: &str) -> String {
    let accepted = authenticate(wire, secret, JOURNAL).unwrap();
    accepted["journal_session"]
        .as_str()
        .unwrap_or_else(|| panic!("auth.prove returned no journal_session: {accepted}"))
        .to_owned()
}

/// This process's pid and `/proc/self/stat` start time: the authored-child
/// identity the delegation is bound to (SO_PEERCRED check, proposal §4.3.6).
pub fn self_identity() -> (u32, u64) {
    let stat = std::fs::read_to_string("/proc/self/stat").unwrap();
    let after_comm = &stat[stat.rfind(')').unwrap() + 2..];
    let start_time = after_comm.split(' ').nth(19).unwrap().parse().unwrap();
    (std::process::id(), start_time)
}

/// Owner J mints a delegation of the CURRENT root-body attempt for one
/// authored child (pid, start time). Amendment A1: the daemon returns only
/// the non-secret `delegation_id`; D is derived, never sent.
pub fn delegate(journal: &mut Wire, lease: &Value, child: (u32, u64)) -> anyhow::Result<String> {
    let issued = journal.request(
        "session.delegate",
        json!({"root_run_id": lease["run_id"], "step": lease["step_id"],
               "attempt_id": lease["attempt"], "delegate_pid": child.0,
               "delegate_start_time": child.1,
               "ops": ["child.start", "child.resume", "child.read"]}),
    )?;
    Ok(issued["delegation_id"].as_str().unwrap().to_owned())
}

/// D = HMAC-SHA256(K, "relayflowd-delegation-v1" 0x00 delegation_id), hex:
/// the parent derives it and hands it to the child in its stdin request.
pub fn delegation_secret(secret: &str, delegation_id: &str) -> String {
    hmac(
        &hex_bytes(secret),
        format!("relayflowd-delegation-v1\0{delegation_id}").as_bytes(),
    )
}

/// The authored child's bind: `auth.delegate {delegation_id, mac}` with
/// mac = HMAC-SHA256(D, nonce "authored-child"). The child never holds K.
pub fn bind_delegate(wire: &mut Wire, d: &str, delegation_id: &str) -> anyhow::Result<Value> {
    let nonce = nonce(wire);
    let mac = hmac(&hex_bytes(d), format!("{nonce}authored-child").as_bytes());
    wire.request(
        "auth.delegate",
        json!({"delegation_id": delegation_id, "mac": mac}),
    )
}

/// `run.start` the pinned root under the reserved key, on a journal
/// connection that is already authenticated.
pub fn run_root(wire: &mut Wire, root: &Value, env: Value) -> anyhow::Result<Value> {
    wire.request(
        "run.start",
        json!({"spec": root, "admission_key": ROOT_KEY, "env": env}),
    )
}

/// Authenticate as a journal connection, then start the pinned root.
pub fn start_root(
    wire: &mut Wire,
    root: &Value,
    secret: &str,
    env: Value,
) -> anyhow::Result<Value> {
    authenticate(wire, secret, JOURNAL)?;
    run_root(wire, root, env)
}

/// An ordinary (unentitled unless lineage says otherwise) `run.start`.
pub fn start(
    wire: &mut Wire,
    steps: Vec<Value>,
    admission_key: Option<&str>,
    env: Option<Value>,
) -> anyhow::Result<Value> {
    let mut params = json!({"spec": spec(steps)});
    if let Some(key) = admission_key {
        params["admission_key"] = json!(key);
    }
    if let Some(env) = env {
        params["env"] = env;
    }
    wire.request("run.start", params)
}

/// The published child key derivation (packages/sdk/src/authored-admission.ts:4-10).
pub fn child_key(parent_run_id: &str, child_id: &str) -> String {
    let digest = Sha256::digest(format!("{parent_run_id}\0{child_id}").as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("authored-child:{hex}")
}

/// A child `run.start` paired with the exact live lease it runs under.
pub fn child(lease: &Value, child_id: &str, env: &Value) -> Value {
    json!({
        "spec": spec(vec![probe("p", &[BOUND])]),
        "parent": {"run_id": lease["run_id"], "step_id": lease["step_id"],
                   "attempt": lease["attempt"], "child_id": child_id},
        "admission_key": child_key(lease["run_id"].as_str().unwrap(), child_id),
        "env": env,
    })
}

/// An agent worker. `peer = Some((K, J))` authenticates it as the worker
/// peer paired with journal session J; `None` is unauthenticated.
pub fn attach_agent_worker(fixture: &Fixture, id: &str, peer: Option<(&str, &str)>) -> Wire {
    let mut worker = fixture.connect();
    if let Some((secret, journal_session)) = peer {
        authenticate(&mut worker, secret, &peer_purpose(journal_session)).unwrap();
    }
    worker
        .request(
            "worker.attach",
            // An agent worker must report a surface pin (server.rs attach rule).
            json!({"worker_id": id, "step_types": ["agent"],
                   "pins": {"workspace": [], "streams": [{"stream": "agent-notes", "read_offset": 0}]}}),
        )
        .unwrap();
    worker
}

pub fn complete_agent(worker: &mut Wire, dispatch: &Value) -> Value {
    worker
        .request(
            "step.complete",
            json!({
                "run_id": dispatch["run_id"], "step_id": dispatch["step_id"],
                "attempt": dispatch["attempt"], "idempotency_key": dispatch["idempotency_key"],
                "completionReason": "success", "output": {"status": "ok"},
                "usage": {"tokens_in": 1, "tokens_out": 1, "dollars": "0.001"},
                "started_pins": dispatch["pins"], "end_pins": dispatch["pins"]
            }),
        )
        .unwrap()
}

pub fn det(id: &str, command: &str, credentials: &[&str]) -> Value {
    let mut step = json!({"id": id, "type": "deterministic", "command": command});
    if !credentials.is_empty() {
        step["credentials"] = json!(credentials);
    }
    step
}

pub fn probe(id: &str, credentials: &[&str]) -> Value {
    det(id, PROBE, credentials)
}

/// Writes the step's whole env to a file OUTSIDE the data dir.
pub fn dump(id: &str, path: &std::path::Path, credentials: &[&str]) -> Value {
    det(id, &format!("env > '{}'", path.display()), credentials)
}

pub fn after(mut step: Value, dependency: &str) -> Value {
    step["depends_on"] = json!([dependency]);
    step
}

pub fn agent_step(id: &str) -> Value {
    json!({"id": id, "type": "agent", "instruction": "diagnose", "max_iterations": 1})
}

pub fn spec(steps: Vec<Value>) -> Value {
    json!({
        "name": "det-credentials-design",
        "steps": steps,
        "budget": {"max_tokens_in": 100, "max_tokens_out": 100, "max_dollars": "1"}
    })
}

/// The graph the host's static resolver computes for the fixture flow:
/// `(path, sourceSha256)` per reachable module, root first.
pub fn resolved_graph() -> Vec<(&'static str, String)> {
    vec![
        ("/state/submitted-source.flow.ts", "a".repeat(64)),
        ("/state/lib/github.ts", "c".repeat(64)),
    ]
}

/// A root shaped like the SDK's authored root (authored-root.ts:478-488):
/// one agent step whose instruction is canonical JSON metadata
/// (authored-root.ts:85-104) over `sources`, the claimed module graph.
pub fn authored_root(flow_name: &str, sources: &[(&str, String)], input: Value) -> Value {
    let surface = json!({"packageName": "@relayflows/surface", "version": "next"});
    let records: Vec<Value> = sources
        .iter()
        .map(|(path, sha)| json!({"path": path, "sourceSha256": sha, "surface": surface}))
        .collect();
    let metadata = json!({
        "kind": "relayflows.authored-root", "flowName": flow_name,
        "flowPath": sources[0].0, "sourceSha256": sources[0].1, "surface": surface,
        "sources": records, "extensions": [], "inputPresent": true, "input": input,
    });
    json!({
        "name": format!("authored-root/{flow_name}"),
        "steps": [{"id": "authored-root", "type": "agent", "max_iterations": 1,
                   "recovery_mode": "reset",
                   "instruction": relayflowd_core::memoization::canonicalize(&metadata)}],
        "budget": {"max_tokens_in": 100, "max_tokens_out": 100, "max_dollars": "1"}
    })
}

/// The env a NONCONFORMING raw client sends: everything, agent keys included.
pub fn raw_cli_env() -> Value {
    let mut env = Map::new();
    env.insert(
        "PATH".into(),
        json!(std::env::var("PATH").unwrap_or_default()),
    );
    env.insert("RUN_LABEL".into(), json!("root"));
    env.insert(
        "RELAY_SECRET_ENV_NAMES".into(),
        json!(format!("[\"{}\"]", DELIVERED.0)),
    );
    for (name, value) in AGENT_ONLY
        .iter()
        .chain(REPOSITORY)
        .chain(std::iter::once(&DELIVERED))
    {
        env.insert((*name).into(), json!(value));
    }
    Value::Object(env)
}

/// The env a CONFORMING client sends: `raw_cli_env` minus every name the
/// daemon's `hello` lists in `det_withheld` (proposal §4.5).
pub fn conforming_cli_env(wire: &mut Wire) -> Value {
    let hello = hello(wire);
    let withheld = hello["det_withheld"]
        .as_array()
        .unwrap_or_else(|| panic!("hello lists no det_withheld: {hello}"))
        .clone();
    let mut env = raw_cli_env();
    for name in withheld {
        env.as_object_mut().unwrap().remove(name.as_str().unwrap());
    }
    env
}
