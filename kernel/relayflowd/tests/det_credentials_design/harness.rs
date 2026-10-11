//! Harness for the trusted det-step credential design fixture.
//!
//! Everything a test observes is captured as bytes so the "no value leaks"
//! assertions are made on what actually crossed each boundary:
//! - every byte written to and read from the daemon socket (`Capture`),
//! - the daemon's own stdout/stderr (`Daemon::output`),
//! - every file under the data dir (journal, registry, checkpoints).

use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::unix::{net::UnixStream, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};

pub const PROPOSAL: &str = "docs/proposals/trusted-det-step-credentials.md";

/// The daemon-only credential the host binds (Cloud: the Babysitter token).
pub const BOUND: &str = "GH_TOKEN";
pub const BOUND_VALUE: &str = "ghs_fixtureDaemonOnly_7Q2w9E4rT1xY";
/// The root run's kernel admission key, as the host declares it.
pub const ROOT_KEY: &str = "authored-root:fixture-owned-root-0001";

/// Agent-only keys the CLI env carries (cloud relayflow-v2-step-env.ts
/// AGENT_ENV_KEYS) and the host withholds from deterministic steps.
pub const AGENT_ONLY: &[(&str, &str)] = &[
    ("ANTHROPIC_API_KEY", "sk-ant-fixtureAgentOnly-5Tz8Lm2Q"),
    ("OPENAI_API_KEY", "sk-fixtureAgentOnly-openai-3Kd1Vb7"),
    ("CLAUDE_CODE_OAUTH_TOKEN", "fixture-oauth-agent-only-9HqW4e"),
];

/// A delivered secret and repository-grant variables: they are in BOTH Cloud
/// envs and must keep reaching deterministic steps.
pub const DELIVERED: (&str, &str) = ("DELIVERED_SECRET", "delivered-fixture-value-81Jx");
pub const REPOSITORY: &[(&str, &str)] = &[
    ("GH_CONFIG_DIR", "/fixture/gh-config"),
    ("GIT_CONFIG_NOSYSTEM", "1"),
];

/// Prints a checksum of the bound credential, never the credential: a step's
/// stdout is journaled.
pub const PROBE: &str =
    r#"if [ -n "${GH_TOKEN+x}" ]; then printf '%s' "$GH_TOKEN" | cksum; else printf unset; fi"#;

pub type Capture = Arc<Mutex<Vec<u8>>>;

pub struct Fixture {
    _directory: TempDir,
    pub data_dir: PathBuf,
    /// Outside the data dir: where env dumps and gates live.
    pub scratch: PathBuf,
    pub wire: Capture,
}

impl Fixture {
    pub fn new() -> Self {
        let directory = tempdir().unwrap();
        let data_dir = directory.path().join("data");
        let scratch = directory.path().join("scratch");
        fs::create_dir_all(&scratch).unwrap();
        Self {
            _directory: directory,
            data_dir,
            scratch,
            wire: Capture::default(),
        }
    }

    pub fn socket(&self) -> PathBuf {
        relayflowd::socket_path::derive_socket_path(&self.data_dir).unwrap()
    }

    pub fn connect(&self) -> Wire {
        Wire::connect(&self.socket(), self.wire.clone())
    }
}

/// The host's declaration (proposal §4.1): names only, in argv.
pub struct Binding {
    pub credentials: Vec<&'static str>,
    pub root: &'static str,
    pub withhold: Vec<&'static str>,
}

/// What Cloud's bootstrap would declare for a Babysitter run.
pub fn cloud_binding() -> Binding {
    Binding {
        credentials: vec![BOUND],
        root: ROOT_KEY,
        withhold: AGENT_ONLY.iter().map(|(name, _)| *name).collect(),
    }
}

impl Binding {
    fn args(&self) -> Vec<String> {
        let mut args = vec![];
        for name in &self.credentials {
            args.extend(["--det-credential".to_owned(), (*name).to_owned()]);
        }
        args.extend(["--det-credential-root".to_owned(), self.root.to_owned()]);
        for name in &self.withhold {
            args.extend(["--det-withhold".to_owned(), (*name).to_owned()]);
        }
        args
    }
}

pub struct Daemon {
    child: Option<Child>,
    output: Capture,
}

impl Daemon {
    /// Start `relayflowd serve` the way a trusted host would: a clean spawn
    /// env holding the bound value by name, and the binding in argv.
    pub fn start(fixture: &Fixture, binding: Option<&Binding>, env: &[(&str, &str)]) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_relayflowd"));
        command
            .args(["--data-dir", fixture.data_dir.to_str().unwrap(), "serve"])
            .args(binding.map(Binding::args).unwrap_or_default())
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", &fixture.scratch)
            // The socket path derives from these (socket_path.rs runtime_dir);
            // Cloud's base env keeps them too.
            .envs(
                ["XDG_RUNTIME_DIR", "TMPDIR"]
                    .into_iter()
                    .filter_map(|name| std::env::var_os(name).map(|value| (name, value))),
            )
            .envs(env.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        let mut child = command.spawn().unwrap();
        let output = Capture::default();
        for pipe in [
            Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>,
            Box::new(child.stderr.take().unwrap()),
        ] {
            let sink = output.clone();
            thread::spawn(move || drain(pipe, sink));
        }
        let socket = fixture.socket();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if UnixStream::connect(&socket).is_ok() {
                return Self {
                    child: Some(child),
                    output,
                };
            }
            if let Some(status) = child.try_wait().unwrap() {
                thread::sleep(Duration::from_millis(50));
                let said = String::from_utf8_lossy(&output.lock().unwrap()).into_owned();
                panic!(
                    "DESIGN FIXTURE: relayflowd exited ({status}) instead of serving with the \
                     trusted det-step credential binding. This kernel does not implement {PROPOSAL} \
                     yet. Daemon said: {said}"
                );
            }
            assert!(
                Instant::now() < deadline,
                "relayflowd never bound its socket"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    pub fn kill(&mut self) {
        if let Some(mut child) = self.child.take() {
            // SAFETY: kill(2) on a process group touches no memory.
            unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
            let _ = child.wait();
        }
    }

    pub fn output(&self) -> Vec<u8> {
        self.output.lock().unwrap().clone()
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        self.kill();
    }
}

fn drain(mut pipe: Box<dyn Read + Send>, sink: Capture) {
    let mut buffer = [0u8; 4096];
    while let Ok(read) = pipe.read(&mut buffer) {
        if read == 0 {
            break;
        }
        sink.lock().unwrap().extend_from_slice(&buffer[..read]);
    }
}

/// A protocol connection that records every byte in both directions.
pub struct Wire {
    stream: UnixStream,
    reader: BufReader<UnixStream>,
    next_id: u64,
    events: Vec<Value>,
    capture: Capture,
}

impl Wire {
    fn connect(socket: &Path, capture: Capture) -> Self {
        let stream = UnixStream::connect(socket).unwrap();
        let read_half = stream.try_clone().unwrap();
        read_half
            .set_read_timeout(Some(Duration::from_secs(30)))
            .unwrap();
        Self {
            stream,
            reader: BufReader::new(read_half),
            next_id: 1,
            events: vec![],
            capture,
        }
    }

    pub fn frame(&mut self, verb: &str, params: Value) -> Result<Value> {
        let id = format!("fixture-{}", self.next_id);
        self.next_id += 1;
        let mut line = serde_json::to_vec(&json!({"id": id, "verb": verb, "params": params}))?;
        line.push(b'\n');
        self.capture.lock().unwrap().extend_from_slice(&line);
        self.stream.write_all(&line)?;
        loop {
            let frame = self.read()?;
            if frame.get("event").is_some() {
                self.events.push(frame);
            } else if frame["id"] == id {
                return Ok(frame);
            }
        }
    }

    pub fn request(&mut self, verb: &str, params: Value) -> Result<Value> {
        let frame = self.frame(verb, params)?;
        if frame["ok"] == true {
            return Ok(frame["result"].clone());
        }
        bail!("{}: {}", frame["error"]["code"], frame["error"]["message"])
    }

    /// The refusal code of a request that must be refused.
    pub fn refusal(&mut self, verb: &str, params: Value) -> String {
        let frame = self.frame(verb, params).unwrap();
        assert_eq!(frame["ok"], false, "{verb} was not refused: {frame}");
        frame["error"]["code"].as_str().unwrap().to_owned()
    }

    pub fn event(&mut self, name: &str) -> Value {
        if let Some(index) = self.events.iter().position(|frame| frame["event"] == name) {
            return self.events.remove(index)["data"].clone();
        }
        loop {
            let frame = self.read().unwrap();
            if frame["event"] == name {
                return frame["data"].clone();
            }
            self.events.push(frame);
        }
    }

    fn read(&mut self) -> Result<Value> {
        let mut line = String::new();
        if self
            .reader
            .read_line(&mut line)
            .context("read protocol frame")?
            == 0
        {
            bail!("protocol connection closed");
        }
        self.capture
            .lock()
            .unwrap()
            .extend_from_slice(line.as_bytes());
        serde_json::from_str(&line).context("decode protocol frame")
    }
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

/// A step that writes its whole process environment to a file outside the
/// data dir, so the test can inspect names and value bytes directly.
pub fn dump(id: &str, path: &Path, credentials: &[&str]) -> Value {
    det(id, &format!("env > '{}'", path.display()), credentials)
}

pub fn after(mut step: Value, dependency: &str) -> Value {
    step["depends_on"] = json!([dependency]);
    step
}

/// The env the Cloud CLI sends as `run.start.env`: delivered and repository
/// variables, agent-only keys, and never the daemon-only credential.
pub fn cli_env() -> Value {
    let mut env = json!({
        "PATH": std::env::var("PATH").unwrap_or_default(),
        "RUN_LABEL": "root",
        "RELAY_SECRET_ENV_NAMES": format!("[\"{}\"]", DELIVERED.0),
    });
    for (name, value) in AGENT_ONLY
        .iter()
        .chain(REPOSITORY)
        .chain(std::iter::once(&DELIVERED))
    {
        env[*name] = json!(value);
    }
    env
}

pub fn start(
    wire: &mut Wire,
    steps: Vec<Value>,
    admission_key: Option<&str>,
    env: Option<Value>,
) -> Result<Value> {
    let mut params = json!({"spec": {"name": "det-credentials-design", "steps": steps}});
    if let Some(key) = admission_key {
        params["admission_key"] = json!(key);
    }
    if let Some(env) = env {
        params["env"] = env;
    }
    wire.request("run.start", params)
}

pub fn entries(wire: &mut Wire, run_id: &Value) -> Vec<Value> {
    wire.request("journal.read", json!({"run_id": run_id}))
        .unwrap()["entries"]
        .as_array()
        .unwrap()
        .clone()
}

pub fn stdout_of(wire: &mut Wire, run_id: &Value, step_id: &str) -> String {
    entries(wire, run_id)
        .iter()
        .find(|entry| entry["entry_type"] == "step.completed" && entry["step_id"] == step_id)
        .and_then(|entry| entry["payload"]["output"]["stdout_tail"].as_str())
        .unwrap_or_else(|| panic!("step {step_id} has no completed stdout"))
        .trim()
        .to_owned()
}

/// `cksum` of a value, as `PROBE` prints it inside the step.
pub fn fingerprint(value: &str) -> String {
    let mut child = Command::new("cksum")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(value.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

pub fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle.as_bytes())
}

pub fn files_containing(dir: &Path, needle: &str) -> Vec<String> {
    let mut hits = vec![];
    let Ok(listing) = fs::read_dir(dir) else {
        return hits;
    };
    for entry in listing {
        let path = entry.unwrap().path();
        if path.is_dir() {
            hits.extend(files_containing(&path, needle));
        } else if fs::read(&path).is_ok_and(|bytes| contains(&bytes, needle)) {
            hits.push(path.display().to_string());
        }
    }
    hits
}

/// The run the registry admitted under `key` (server-written, durable).
pub fn admitted_run_id(data_dir: &Path, key: &str) -> String {
    let registry = rusqlite::Connection::open(data_dir.join("relayflowd.sqlite3")).unwrap();
    registry
        .query_row(
            "SELECT run_id FROM run_admissions WHERE admission_key = ?1",
            [key],
            |row| row.get(0),
        )
        .unwrap()
}

pub fn wait_for(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(20));
    }
}
