//! Slice 1: a fixed pack is injected once, then replayed after SIGKILL.
use super::{
    agent_support::{AgentFixture, attached_worker, complete, record_effect, spawn_resume},
    llm_support::ProtocolClient,
    support::{describe_stalled_resume, journal_entries},
};
use serde_json::{Value, json};
use std::{fs, time::Duration};
use wait_timeout::ChildExt;

#[test]
fn memory_sigkill_after_injection_replays_pack_and_charges_it_once() {
    let fixture = AgentFixture::new("memory-once", "reset");
    let mut spec: Value = serde_json::from_slice(&fs::read(&fixture.spec_path).unwrap()).unwrap();
    let request = json!({
        "scope": "agent", "query": "previous lessons",
        "budget": {"max_tokens_in": 7, "max_dollars": "0.002"}
    });
    spec["steps"][1]["memory"] = request.clone();
    let mut server = fixture.server();
    let mut worker = attached_worker(&fixture, "first-memory-worker");
    let mut control = ProtocolClient::connect(&fixture.socket());
    let started = control
        .request("run.start", json!({"spec": spec}))
        .expect("a step-declared memory pack must be supported");
    let run_id = started["run_id"].as_str().unwrap();
    let first = worker.event("step.dispatch").unwrap();
    let pack = json!({"text": "fixed memory pack", "citations": []});
    let cost = json!({"tokens_in": 7, "tokens_out": 0, "dollars": "0.002"});
    assert_eq!(first["memory"]["request"], request);
    assert_eq!(first["memory"]["pack"], pack);
    assert_eq!(first["memory"]["budget"], cost);
    let before = journal_entries(&fixture.data_dir).unwrap();
    let injected: Vec<_> = before
        .iter()
        .filter(|e| e.entry_type.as_str() == "memory.injected")
        .collect();
    assert_eq!(injected.len(), 1);
    assert_eq!(injected[0].step_id.as_deref(), Some("agent"));
    assert_eq!(injected[0].payload, first["memory"]);
    assert_eq!(
        control
            .request("run.get", json!({"run_id":run_id}))
            .unwrap()["budget"],
        cost
    );

    // Kill after the journaled pack has reached the worker, before completion.
    server.kill();
    drop((worker, control));
    let _restarted = fixture.server();
    let mut replacement = attached_worker(&fixture, "replacement-memory-worker");
    let mut resume = spawn_resume(&fixture, run_id);
    let second = replacement.event("step.dispatch").unwrap_or_else(|error| {
        panic!(
            "no resumed dispatch: {error}{}",
            describe_stalled_resume(&fixture.data_dir, &mut resume)
        )
    });
    assert_eq!(second["attempt"], 2);
    assert_eq!(second["memory"], first["memory"]);
    let mut control = ProtocolClient::connect(&fixture.socket());
    assert_eq!(
        control
            .request("run.get", json!({"run_id":run_id}))
            .unwrap()["budget"],
        cost
    );
    assert!(!record_effect(&fixture, &mut replacement, &second).unwrap());
    complete(&mut replacement, &second).unwrap();
    if resume
        .wait_timeout(Duration::from_secs(15))
        .unwrap()
        .is_none()
    {
        panic!(
            "resume stalled{}",
            describe_stalled_resume(&fixture.data_dir, &mut resume)
        );
    }
    let output = resume.wait_with_output().unwrap();
    assert!(output.status.success(), "resume failed: {output:?}");
    let entries = journal_entries(&fixture.data_dir).unwrap();
    let replay: Vec<_> = entries
        .iter()
        .filter(|e| e.entry_type.as_str() == "memory.injected")
        .collect();
    assert_eq!(
        replay, injected,
        "resume must reuse the original fact, not append another injection"
    );
    let terminal = entries
        .iter()
        .find(|e| e.entry_type.as_str() == "run.completed")
        .unwrap();
    // Worker usage is 13 in / 5 out / .003; memory is a separate 7 in / .002.
    let total = json!({"tokens_in":20,"tokens_out":5,"dollars":"0.005"});
    assert_eq!(terminal.payload["budget_total"], total);
    assert_eq!(
        control
            .request("run.get", json!({"run_id":run_id}))
            .unwrap()["budget"],
        total
    );
    assert_eq!(fixture.provider_call_count(), 1);
}
