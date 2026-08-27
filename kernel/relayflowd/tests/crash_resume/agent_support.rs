use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    process::{Child, Command, Stdio},
};

use anyhow::Result;
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};

use super::llm_support::{ProtocolClient, ServerGuard};

pub struct AgentFixture {
    _directory: TempDir,
    pub data_dir: PathBuf,
    pub marker: PathBuf,
    pub provider_calls: PathBuf,
    pub finish_gate: PathBuf,
    pub finish_pid: PathBuf,
    pub spec_path: PathBuf,
    spec: Value,
}

impl AgentFixture {
    pub fn new(name: &str, recovery_mode: &str) -> Self {
        Self::build(name, recovery_mode, false)
    }

    pub fn blocking_finish(name: &str, recovery_mode: &str) -> Self {
        Self::build(name, recovery_mode, true)
    }

    fn build(name: &str, recovery_mode: &str, block_finish: bool) -> Self {
        let directory = tempdir().unwrap();
        let data_dir = directory.path().join("data");
        let marker = directory.path().join("effects.txt");
        let provider_calls = directory.path().join("provider-calls.txt");
        let finish_gate = directory.path().join("finish-gate");
        let finish_pid = directory.path().join("finish.pid");
        let spec_path = directory.path().join("run.json");
        let finish = if block_finish {
            format!(
                "printf '%s' \"$$\" > '{pid}'; while [ ! -f '{gate}' ]; do sleep 0.02; done; printf 'finish\\n' >> '{marker}'",
                pid = finish_pid.to_string_lossy(),
                gate = finish_gate.to_string_lossy(),
                marker = marker.to_string_lossy(),
            )
        } else {
            format!("printf 'finish\\n' >> '{}'", marker.to_string_lossy())
        };
        let spec = json!({
            "name": format!("agent-{name}"),
            "steps": [
                {
                    "id": "first",
                    "type": "deterministic",
                    "command": ["/bin/sh", "-c", format!("printf 'first\\n' >> '{}'", marker.to_string_lossy())]
                },
                {
                    "id": "agent",
                    "type": "agent",
                    "depends_on": ["first"],
                    "instruction": "produce the deterministic stub artifact",
                    "recovery_mode": recovery_mode,
                    "max_iterations": 2,
                    "retry": {
                        "initial_backoff_ms": 20,
                        "max_backoff_ms": 20,
                        "multiplier": 1,
                        "jitter_percent": 0
                    },
                    "surfaces": {
                        "workspace": [{"surface": "repo"}],
                        "streams": [{"stream": "agent-notes"}],
                        "external": ["/provider/item"]
                    },
                    "verification": {"output_contains": "agent-ok"}
                },
                {
                    "id": "finish",
                    "type": "deterministic",
                    "depends_on": ["agent"],
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
            provider_calls,
            finish_gate,
            finish_pid,
            spec_path,
            spec,
        }
    }

    pub fn socket(&self) -> PathBuf {
        self.data_dir.join("relayflowd.sock")
    }

    pub fn server(&self) -> ServerGuard {
        ServerGuard::start_at(&self.data_dir, &self.socket())
    }

    pub fn provider_call_count(&self) -> usize {
        fs::read_to_string(&self.provider_calls)
            .unwrap_or_default()
            .lines()
            .count()
    }
}

pub fn attached_worker(fixture: &AgentFixture, worker_id: &str) -> ProtocolClient {
    let mut worker = ProtocolClient::connect(&fixture.socket());
    worker
        .request(
            "worker.attach",
            json!({
                "worker_id": worker_id,
                "step_types": ["agent"],
                "pins": {
                    "workspace": [{"surface": "repo", "revision_id": "rev-clean"}],
                    "streams": [{"stream": "agent-notes", "read_offset": 0}]
                }
            }),
        )
        .unwrap();
    worker
}

pub fn start_run(fixture: &AgentFixture) -> String {
    let mut control = ProtocolClient::connect(&fixture.socket());
    let result = control
        .request("run.start", json!({"spec": fixture.spec.clone()}))
        .unwrap();
    assert_eq!(result["status"], "parked");
    result["run_id"].as_str().unwrap().to_owned()
}

pub fn record_effect(
    fixture: &AgentFixture,
    worker: &mut ProtocolClient,
    dispatch: &Value,
) -> Result<bool> {
    let result = worker.request(
        "effect.record",
        json!({
            "run_id": dispatch["run_id"],
            "step_id": dispatch["step_id"],
            "attempt": dispatch["attempt"],
            "idempotency_key": dispatch["idempotency_key"],
            "surface_path": "/provider/item",
            "revision_before": "provider-rev-a",
            "revision_after": "provider-rev-b"
        }),
    )?;
    let deduped = result["deduped"].as_bool().unwrap();
    if !deduped {
        writeln!(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&fixture.provider_calls)?,
            "provider-called"
        )?;
    }
    Ok(deduped)
}

pub fn complete(worker: &mut ProtocolClient, dispatch: &Value) -> Result<Value> {
    worker.request(
        "step.complete",
        json!({
            "run_id": dispatch["run_id"],
            "step_id": dispatch["step_id"],
            "attempt": dispatch["attempt"],
            "idempotency_key": dispatch["idempotency_key"],
            "completionReason": "success",
            "output": {"status": "agent-ok"},
            "usage": {"tokens_in": 13, "tokens_out": 5, "dollars": "0.003"},
            "started_pins": dispatch["pins"],
            "end_pins": {
                "workspace": [{"surface": "repo", "revision_id": "rev-final"}],
                "streams": [{"stream": "agent-notes", "read_offset": 1}]
            },
            "effects": [{
                "surface_path": "/provider/item",
                "idempotency_key": dispatch["idempotency_key"]
            }]
        }),
    )
}

pub fn spawn_resume(fixture: &AgentFixture, run_id: &str) -> Child {
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
