use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{net::UnixStream, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};

use super::support::{kill_group, wait_until};

pub struct LlmFixture {
    _directory: TempDir,
    pub data_dir: PathBuf,
    pub marker: PathBuf,
    pub gate: PathBuf,
    pub step_pid: PathBuf,
    pub spec_path: PathBuf,
    spec: Value,
}

impl LlmFixture {
    pub fn new(name: &str, block_finish: bool) -> Self {
        let directory = tempdir().unwrap();
        let data_dir = directory.path().join("data");
        let marker = directory.path().join("effects.txt");
        let gate = directory.path().join("gate");
        let step_pid = directory.path().join("finish.pid");
        let spec_path = directory.path().join("run.json");
        let finish = if block_finish {
            format!(
                "printf '%s' \"$$\" > '{pid}'; while [ ! -f '{gate}' ]; do sleep 0.02; done; printf 'finish\\n' >> '{marker}'",
                pid = step_pid.to_string_lossy(),
                gate = gate.to_string_lossy(),
                marker = marker.to_string_lossy(),
            )
        } else {
            format!("printf 'finish\\n' >> '{}'", marker.to_string_lossy())
        };
        let spec = json!({
            "name": format!("llm-{name}"),
            "steps": [
                {
                    "id": "first",
                    "type": "deterministic",
                    "command": ["/bin/sh", "-c", format!("printf 'first\\n' >> '{}'", marker.to_string_lossy())]
                },
                {
                    "id": "model",
                    "type": "llm",
                    "depends_on": ["first"],
                    "prompt": "return {answer: 4}",
                    "model": "deterministic-stub",
                    "max_iterations": 2,
                    "retry": {
                        "initial_backoff_ms": 20,
                        "max_backoff_ms": 20,
                        "multiplier": 1,
                        "jitter_percent": 0
                    },
                    "verification": {
                        "json_schema": {
                            "type": "object",
                            "required": ["answer"],
                            "properties": {"answer": {"type": "integer"}}
                        }
                    }
                },
                {
                    "id": "finish",
                    "type": "deterministic",
                    "depends_on": ["model"],
                    "command": ["/bin/sh", "-c", finish]
                }
            ],
            "budget": {"max_tokens_in": 100, "max_tokens_out": 100, "max_dollars": "1"}
        });
        fs::write(&spec_path, serde_json::to_vec(&spec).unwrap()).unwrap();
        Self {
            _directory: directory,
            data_dir,
            marker,
            gate,
            step_pid,
            spec_path,
            spec,
        }
    }

    pub fn parallel(name: &str) -> Self {
        let mut fixture = Self::new(name, false);
        fixture.spec = json!({
            "name": format!("llm-{name}"),
            "steps": [
                {
                    "id": "lane-b",
                    "type": "llm",
                    "prompt": "research b",
                    "model": "deterministic-stub",
                    "max_iterations": 2,
                    "retry": {"initial_backoff_ms": 0, "max_backoff_ms": 0, "multiplier": 1, "jitter_percent": 0}
                },
                {
                    "id": "lane-a",
                    "type": "llm",
                    "prompt": "research a",
                    "model": "deterministic-stub",
                    "max_iterations": 2,
                    "retry": {"initial_backoff_ms": 0, "max_backoff_ms": 0, "multiplier": 1, "jitter_percent": 0}
                }
            ],
            "budget": {"max_tokens_in": 100, "max_tokens_out": 100, "max_dollars": "1"}
        });
        fs::write(
            &fixture.spec_path,
            serde_json::to_vec(&fixture.spec).unwrap(),
        )
        .unwrap();
        fixture
    }

    pub fn completed(name: &str) -> Self {
        let mut fixture = Self::new(name, false);
        fixture.spec = json!({
            "name": format!("completed-{name}"),
            "steps": [{"id": "done", "type": "deterministic", "command": "true"}]
        });
        fs::write(
            &fixture.spec_path,
            serde_json::to_vec(&fixture.spec).unwrap(),
        )
        .unwrap();
        fixture
    }

    pub fn parallel_terminal(name: &str) -> Self {
        let mut fixture = Self::parallel(name);
        for step in fixture.spec["steps"].as_array_mut().unwrap() {
            step["max_iterations"] = json!(1);
        }
        fs::write(
            &fixture.spec_path,
            serde_json::to_vec(&fixture.spec).unwrap(),
        )
        .unwrap();
        fixture
    }

    pub fn parallel_agents(name: &str, overlapping: bool) -> Self {
        let mut fixture = Self::new(name, false);
        let lane_a_surface = if overlapping { "repo-b" } else { "repo-a" };
        let join_workspace = if overlapping {
            json!([{"surface": "repo-b"}])
        } else {
            json!([{"surface": "repo-b"}, {"surface": "repo-a"}])
        };
        fixture.spec = json!({
            "name": format!("agent-parallel-{name}"),
            "steps": [
                {
                    "id": "lane-b",
                    "type": "agent",
                    "instruction": "b",
                    "surfaces": {"workspace": [{"surface": "repo-b"}]}
                },
                {
                    "id": "lane-a",
                    "type": "agent",
                    "instruction": "a",
                    "surfaces": {"workspace": [{"surface": lane_a_surface}]}
                },
                {
                    "id": "join",
                    "type": "agent",
                    "instruction": "join",
                    "depends_on": ["lane-b", "lane-a"],
                    "surfaces": {"workspace": join_workspace}
                }
            ]
        });
        fs::write(
            &fixture.spec_path,
            serde_json::to_vec(&fixture.spec).unwrap(),
        )
        .unwrap();
        fixture
    }

    fn socket(&self) -> PathBuf {
        self.data_dir.join("relayflowd.sock")
    }
}

pub struct ServerGuard(Option<Child>);

impl ServerGuard {
    pub fn start(fixture: &LlmFixture) -> Self {
        Self::start_at(&fixture.data_dir, &fixture.socket())
    }

    pub fn start_at(data_dir: &Path, socket: &Path) -> Self {
        let child = Command::new(env!("CARGO_BIN_EXE_relayflowd"))
            .args(["--data-dir", data_dir.to_str().unwrap(), "serve"])
            .process_group(0)
            .spawn()
            .unwrap();
        wait_until("llm protocol socket", || {
            UnixStream::connect(socket).is_ok()
        });
        Self(Some(child))
    }

    pub fn kill(&mut self) {
        let mut child = self.0.take().expect("server is running");
        kill_group(child.id());
        let _ = child.wait();
    }
}

impl Drop for ServerGuard {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
            let _ = child.wait();
        }
    }
}

pub struct ProtocolClient {
    stream: UnixStream,
    reader: BufReader<UnixStream>,
    next_id: u64,
    events: Vec<Value>,
}

/// Ceiling on any single protocol read in a test.
///
/// The whole `crash_resume` target runs in about 38 seconds, so this is far
/// longer than any legitimate wait; it exists only to convert "never" into a
/// failure. See `read_frame` for why that matters.
const READ_TIMEOUT: Duration = Duration::from_secs(60);

impl ProtocolClient {
    pub fn connect(socket: &Path) -> Self {
        let stream = UnixStream::connect(socket).unwrap();
        let read_half = stream.try_clone().unwrap();
        // Without this a frame that never arrives blocks forever. These tests
        // SIGKILL a daemon and resume it, so "the dispatch never comes" is a
        // reachable state, not a hypothetical -- and an unbounded read turns it
        // into a silent hang that produces NO output at all. On GitHub runners
        // that consumed the entire 30-minute step three times (#174), and the
        // only evidence left behind was the harness's own
        // "has been running for over 60 seconds" line.
        read_half
            .set_read_timeout(Some(READ_TIMEOUT))
            .expect("set protocol read timeout");
        let reader = BufReader::new(read_half);
        Self {
            stream,
            reader,
            next_id: 1,
            events: Vec::new(),
        }
    }

    pub fn request(&mut self, verb: &str, params: Value) -> Result<Value> {
        let frame = self.request_frame(verb, params)?;
        if frame["ok"] == true {
            return Ok(frame.get("result").cloned().unwrap_or(Value::Null));
        }
        bail!(
            "{}: {}",
            frame["error"]["code"].as_str().unwrap_or("protocol_error"),
            frame["error"]["message"]
                .as_str()
                .unwrap_or("missing detail")
        )
    }

    pub fn request_error_code(&mut self, verb: &str, params: Value) -> String {
        let frame = self.request_frame(verb, params).unwrap();
        assert_eq!(frame["ok"], false, "{verb} unexpectedly succeeded");
        frame["error"]["code"].as_str().unwrap().to_owned()
    }

    fn request_frame(&mut self, verb: &str, params: Value) -> Result<Value> {
        let id = format!("test-{}", self.next_id);
        self.next_id += 1;
        serde_json::to_writer(
            &mut self.stream,
            &json!({"id": id, "verb": verb, "params": params}),
        )?;
        self.stream.write_all(b"\n")?;
        self.stream.flush()?;
        loop {
            let frame = self.read_frame()?;
            if frame.get("event").is_some() {
                self.events.push(frame);
                continue;
            }
            if frame["id"] != id {
                continue;
            }
            return Ok(frame);
        }
    }

    pub fn event(&mut self, name: &str) -> Result<Value> {
        loop {
            if let Some(index) = self.events.iter().position(|frame| frame["event"] == name) {
                return Ok(self.events.remove(index)["data"].clone());
            }
            let frame = self.read_frame()?;
            if frame["event"] == name {
                return Ok(frame["data"].clone());
            }
            if frame.get("event").is_some() {
                self.events.push(frame);
            }
        }
    }

    pub fn set_read_timeout(&self, timeout: Option<Duration>) {
        self.stream.set_read_timeout(timeout).unwrap();
    }

    fn read_frame(&mut self) -> Result<Value> {
        let mut line = String::new();
        match self.reader.read_line(&mut line) {
            Ok(0) => bail!("protocol connection closed"),
            Ok(_) => {}
            // Name the timeout rather than letting it surface as a bare I/O
            // error. A test that stops here is waiting for a frame the daemon
            // never sent, and that sentence is the entire diagnosis.
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                bail!(
                    "timed out after {READ_TIMEOUT:?} waiting for a protocol frame; \
                     the daemon sent nothing (see #174)"
                )
            }
            Err(error) => return Err(error.into()),
        }
        serde_json::from_str(&line).context("decode protocol frame")
    }
}

pub fn attached_worker(fixture: &LlmFixture, id: &str) -> ProtocolClient {
    let mut worker = ProtocolClient::connect(&fixture.socket());
    worker
        .request(
            "worker.attach",
            json!({"worker_id": id, "step_types": ["llm"], "capacity": 8}),
        )
        .unwrap();
    worker
}

pub fn start_run(fixture: &LlmFixture) -> String {
    let mut control = ProtocolClient::connect(&fixture.socket());
    let result = control
        .request("run.start", json!({"spec": fixture.spec.clone()}))
        .unwrap();
    assert_eq!(result["status"], "parked");
    result["run_id"].as_str().unwrap().to_owned()
}

pub fn complete(worker: &mut ProtocolClient, dispatch: &Value, output: Value) -> Result<Value> {
    worker.request(
        "step.complete",
        json!({
            "run_id": dispatch["run_id"],
            "step_id": dispatch["step_id"],
            "attempt": dispatch["attempt"],
            "idempotency_key": dispatch["idempotency_key"],
            "completionReason": "success",
            "output": output,
            "usage": {"tokens_in": 11, "tokens_out": 4, "dollars": "0.002"}
        }),
    )
}

pub fn spawn_resume(fixture: &LlmFixture, run_id: &str) -> Child {
    Command::new(env!("CARGO_BIN_EXE_relayflowd"))
        .args([
            "--data-dir",
            fixture.data_dir.to_str().unwrap(),
            "resume",
            run_id,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}
