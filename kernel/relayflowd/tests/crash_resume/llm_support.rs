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

impl ProtocolClient {
    pub fn connect(socket: &Path) -> Self {
        let stream = UnixStream::connect(socket).unwrap();
        let reader = BufReader::new(stream.try_clone().unwrap());
        Self {
            stream,
            reader,
            next_id: 1,
            events: Vec::new(),
        }
    }

    pub fn request(&mut self, verb: &str, params: Value) -> Result<Value> {
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
            if frame["ok"] == true {
                return Ok(frame.get("result").cloned().unwrap_or(Value::Null));
            }
            bail!(
                "{}: {}",
                frame["error"]["code"].as_str().unwrap_or("protocol_error"),
                frame["error"]["message"]
                    .as_str()
                    .unwrap_or("missing detail")
            );
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
        if self.reader.read_line(&mut line)? == 0 {
            bail!("protocol connection closed")
        }
        serde_json::from_str(&line).context("decode protocol frame")
    }
}

pub fn attached_worker(fixture: &LlmFixture, id: &str) -> ProtocolClient {
    let mut worker = ProtocolClient::connect(&fixture.socket());
    worker
        .request(
            "worker.attach",
            json!({"worker_id": id, "step_types": ["llm"]}),
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
