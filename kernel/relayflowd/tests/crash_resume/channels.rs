//! Two stub agents coordinate over the real daemon; every cut resumes via CLI.
use std::{fs, io::Write, process::{Command, Stdio}};
use serde_json::{Value, json};
use super::{agent_support::AgentFixture, llm_support::ProtocolClient, support::journal_entries};

fn attach(f: &AgentFixture, agent: &str) -> ProtocolClient {
    let mut worker = ProtocolClient::connect(&f.socket());
    worker.request("worker.attach", json!({
        "worker_id": agent, "step_types": ["agent"],
        "pins": {"workspace": [{"surface": agent, "revision_id": "clean"}]}
    })).unwrap();
    worker
}

fn params(dispatch: &Value, channel: &str) -> Value {
    json!({"run_id": dispatch["run_id"], "step_id": dispatch["step_id"],
        "attempt": dispatch["attempt"], "idempotency_key": dispatch["idempotency_key"],
        "channel": channel})
}

fn send(worker: &mut ProtocolClient, dispatch: &Value, channel: &str, text: &str) -> Value {
    let mut p = params(dispatch, channel);
    p["message_id"] = json!(text);
    p["message"] = json!({"text": text});
    worker.request("channel.append", p).expect("durable channel append must exist")
}

fn receive(worker: &mut ProtocolClient, dispatch: &Value, channel: &str) -> Value {
    worker.request("channel.receive", params(dispatch, channel)).unwrap()
}

fn ack(worker: &mut ProtocolClient, dispatch: &Value, channel: &str, delivery: &Value) {
    let mut p = params(dispatch, channel);
    p["delivery_seq"] = delivery["seq"].clone();
    worker.request("channel.ack", p).unwrap();
}

fn finish(worker: &mut ProtocolClient, dispatch: &Value) {
    worker.request("step.complete", json!({
        "run_id": dispatch["run_id"], "step_id": dispatch["step_id"],
        "attempt": dispatch["attempt"], "idempotency_key": dispatch["idempotency_key"],
        "completionReason": "success", "output": "done", "started_pins": dispatch["pins"],
        "end_pins": dispatch["pins"],
        "effects": [{"surface_path": format!("/provider/{}", dispatch["step_id"].as_str().unwrap()), "idempotency_key": dispatch["idempotency_key"]}]
    })).unwrap();
}

#[test]
fn channels_sigkill_resume_redelivers_unacked_messages_with_exactly_once_effects() {
    for cut in ["append", "delivery", "effect", "ack"] {
        let f = AgentFixture::new(cut, "reset");
        let spec = json!({"name": "channel-exchange", "steps": (["alice", "bob"].map(|id| json!({
            "id": id, "type": "agent", "instruction": "exchange a request and reply",
            "surfaces": {"workspace": [{"surface": id}], "external": [format!("/provider/{id}")]},
            "max_iterations": 2,
            "retry": {"initial_backoff_ms": 0, "max_backoff_ms": 0, "multiplier": 1, "jitter_percent": 0}
        })))});
        let mut server = f.server();
        let mut alice = attach(&f, "alice");
        let mut bob = attach(&f, "bob");
        let mut control = ProtocolClient::connect(&f.socket());
        let started = control.request("run.start", json!({"spec": spec})).unwrap();
        let run_id = started["run_id"].as_str().unwrap();
        let a1 = alice.event("step.dispatch").unwrap();
        let b1 = bob.event("step.dispatch").unwrap();
        assert_eq!(a1["step_id"], "alice");
        assert_eq!(b1["step_id"], "bob");
        let appended = send(&mut alice, &a1, "requests", "ping");
        assert_eq!(appended["payload"]["offset"], 1);
        let mut deliveries = Vec::new();
        if cut != "append" {
            let delivery = receive(&mut bob, &b1, "requests");
            assert_eq!(delivery["payload"]["message"], json!({"text": "ping"}));
            deliveries.push(delivery);
        }
        if matches!(cut, "effect" | "ack") {
            assert!(!record_effect(&f, &mut bob, &b1).unwrap());
        }
        if cut == "ack" {
            ack(&mut bob, &b1, "requests", &deliveries[0]);
        }
        // SIGKILL the daemon with both agents still in flight. Drop the old
        // worker connections and reconnect fresh identities on restart.
        server.kill();
        drop((alice, bob, control));
        let _restarted = f.server();
        let mut alice = attach(&f, "alice");
        let mut bob = attach(&f, "bob");
        let resume = Command::new(env!("CARGO_BIN_EXE_relayflowd"))
            .args(["--data-dir", f.data_dir.to_str().unwrap(), "resume", run_id])
            .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let a2 = alice.event("step.dispatch").unwrap();
        let b2 = bob.event("step.dispatch").unwrap();
        assert_eq!(a2["attempt"], 2);
        assert_eq!(b2["attempt"], 2);
        // A producer that lost its response can safely repeat its send.
        assert_eq!(send(&mut alice, &a2, "requests", "ping"), appended);
        let delivery = receive(&mut bob, &b2, "requests");
        if cut == "ack" {
            assert!(delivery.is_null(), "acked messages must stay consumed after SIGKILL");
        } else {
            assert_eq!(delivery["payload"]["offset"], 1);
            assert_eq!(delivery["payload"]["message"], json!({"text": "ping"}));
            deliveries.push(delivery.clone());
            assert_eq!(record_effect(&f, &mut bob, &b2).unwrap(), cut == "effect");
            ack(&mut bob, &b2, "requests", &delivery);
            ack(&mut bob, &b2, "requests", &delivery); // lost ack response is harmless
        }
        if cut == "ack" {
            assert!(record_effect(&f, &mut bob, &b2).unwrap());
        }
        assert!(receive(&mut bob, &b2, "requests").is_null());
        send(&mut bob, &b2, "replies", "pong");
        let reply = receive(&mut alice, &a2, "replies");
        assert_eq!(reply["payload"]["message"], json!({"text": "pong"}));
        assert!(!record_effect(&f, &mut alice, &a2).unwrap());
        ack(&mut alice, &a2, "replies", &reply);
        deliveries.push(reply);
        finish(&mut alice, &a2);
        finish(&mut bob, &b2);
        let output = resume.wait_with_output().unwrap();
        assert!(output.status.success(), "resume failed: {output:?}");
        assert_eq!(serde_json::from_slice::<Value>(&output.stdout).unwrap()["status"], "completed");
        assert_eq!(f.provider_call_count(), 2, "one effect per agent despite redelivery ({cut})");
        let entries = journal_entries(&f.data_dir).unwrap();
        let replay: Vec<Value> = entries.iter()
            .filter(|entry| entry.entry_type.as_str() == "channel.delivered")
            .map(|entry| serde_json::to_value(entry).unwrap()).collect();
        assert_eq!(replay, deliveries, "journal replay must reproduce actual deliveries ({cut})");
        assert_eq!(replay.len(), if matches!(cut, "delivery" | "effect") { 3 } else { 2 });
        assert_eq!(entries.iter().filter(|e| e.entry_type.as_str() == "channel.appended").count(), 2);
        assert_eq!(entries.iter().filter(|e| e.entry_type.as_str() == "channel.acknowledged").count(), 2);
        assert_eq!(fs::read_to_string(&f.provider_calls).unwrap(), "provider-called\nprovider-called\n");
    }
}

fn record_effect(f: &AgentFixture, worker: &mut ProtocolClient, dispatch: &Value) -> anyhow::Result<bool> {
    let mut p = json!({"run_id": dispatch["run_id"], "step_id": dispatch["step_id"],
        "attempt": dispatch["attempt"], "idempotency_key": dispatch["idempotency_key"],
        "surface_path": format!("/provider/{}", dispatch["step_id"].as_str().unwrap())});
    let confirm = p.clone();
    p["revision_before"] = json!("before"); p["revision_after"] = json!("after");
    let result = worker.request("effect.record", p)?;
    let deduped = result["deduped"].as_bool().unwrap();
    if !deduped {
        let mut file = fs::OpenOptions::new().create(true).append(true).open(&f.provider_calls)?;
        writeln!(file, "provider-called")?;
        file.sync_all()?;
        worker.request("effect.confirm", confirm)?;
    }
    Ok(deduped)
}
