//! Real placement, capacity release, and crash recovery at the socket boundary.

use relayflowd_core::{CompletionReason, EntryType, StepCompletedPayload};
use serde_json::json;

use super::{
    llm_support::{LlmFixture, ProtocolClient, ServerGuard, complete},
    support::{journal_entries, wait_until},
};

fn attach(fixture: &LlmFixture, worker_id: &str, capacity: Option<usize>) -> ProtocolClient {
    let mut worker = ProtocolClient::connect(&fixture.data_dir.join("relayflowd.sock"));
    let mut params = json!({"worker_id": worker_id, "step_types": ["llm"]});
    if let Some(capacity) = capacity {
        params["capacity"] = json!(capacity);
    }
    worker.request("worker.attach", params).unwrap();
    worker
}

#[test]
fn two_workers_receive_a_deterministic_fair_capacity_bounded_batch() {
    let fixture = LlmFixture::parallel("fair-capacity");
    let _server = ServerGuard::start(&fixture);
    let mut first = attach(&fixture, "first", Some(2));
    let mut second = attach(&fixture, "second", Some(2));
    let mut control = ProtocolClient::connect(&fixture.data_dir.join("relayflowd.sock"));
    let started = control
        .request(
            "run.start",
            json!({"spec": {"steps": [
                {"id": "lane-1", "type": "llm", "prompt": "1", "model": "stub"},
                {"id": "lane-2", "type": "llm", "prompt": "2", "model": "stub"},
                {"id": "lane-3", "type": "llm", "prompt": "3", "model": "stub"},
                {"id": "lane-4", "type": "llm", "prompt": "4", "model": "stub"}
            ]}}),
        )
        .unwrap();
    assert_eq!(started["status"], "parked");
    let first_dispatches = [
        first.event("step.dispatch").unwrap(),
        first.event("step.dispatch").unwrap(),
    ];
    let second_dispatches = [
        second.event("step.dispatch").unwrap(),
        second.event("step.dispatch").unwrap(),
    ];
    assert_eq!(
        first_dispatches
            .iter()
            .map(|dispatch| dispatch["step_id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["lane-1", "lane-3"]
    );
    assert_eq!(
        second_dispatches
            .iter()
            .map(|dispatch| dispatch["step_id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["lane-2", "lane-4"]
    );
    for dispatch in &first_dispatches {
        complete(&mut first, dispatch, json!({"done": dispatch["step_id"]})).unwrap();
    }
    for dispatch in &second_dispatches {
        complete(&mut second, dispatch, json!({"done": dispatch["step_id"]})).unwrap();
    }
    assert_eq!(
        control
            .request("run.get", json!({"run_id": started["run_id"]}))
            .unwrap()["status"],
        "completed"
    );
}

#[test]
fn default_capacity_one_reopens_only_after_durable_completion_or_crash() {
    let fixture = LlmFixture::parallel("capacity-one-completion");
    let _server = ServerGuard::start(&fixture);
    let mut worker = attach(&fixture, "serial", None);
    let mut control = ProtocolClient::connect(&fixture.data_dir.join("relayflowd.sock"));
    let started = control
        .request(
            "run.start",
            json!({"spec": {
                "steps": [
                    {"id": "lane-b", "type": "llm", "prompt": "b", "model": "stub"},
                    {"id": "lane-a", "type": "llm", "prompt": "a", "model": "stub"}
                ]
            }}),
        )
        .unwrap();
    let lane_b = worker.event("step.dispatch").unwrap();
    assert_eq!(lane_b["step_id"], "lane-b");
    assert_eq!(
        journal_entries(&fixture.data_dir)
            .unwrap()
            .iter()
            .filter(|entry| entry.entry_type == EntryType::StepAttemptStarted)
            .count(),
        1,
        "capacity must be reserved before another start is journaled"
    );
    complete(&mut worker, &lane_b, json!({"done": "b"})).unwrap();
    let lane_a = worker.event("step.dispatch").unwrap();
    assert_eq!(lane_a["step_id"], "lane-a");
    assert_eq!(
        complete(&mut worker, &lane_a, json!({"done": "a"})).unwrap()["status"],
        "completed"
    );
    assert_eq!(
        control
            .request("run.get", json!({"run_id": started["run_id"]}))
            .unwrap()["status"],
        "completed"
    );

    let fixture = LlmFixture::parallel("capacity-one-crash");
    let _server = ServerGuard::start(&fixture);
    let mut crashed = attach(&fixture, "crashed", None);
    let mut control = ProtocolClient::connect(&fixture.data_dir.join("relayflowd.sock"));
    let started = control
        .request(
            "run.start",
            json!({"spec": {
                "steps": [
                    {"id": "lane-b", "type": "llm", "prompt": "b", "model": "stub"},
                    {"id": "lane-a", "type": "llm", "prompt": "a", "model": "stub"}
                ]
            }}),
        )
        .unwrap();
    assert_eq!(crashed.event("step.dispatch").unwrap()["step_id"], "lane-b");
    drop(crashed);
    wait_until("durable crashed completion", || {
        journal_entries(&fixture.data_dir).is_some_and(|entries| {
            entries.iter().any(|entry| {
                entry.entry_type == EntryType::StepCompleted
                    && serde_json::from_value::<StepCompletedPayload>(entry.payload.clone())
                        .is_ok_and(|payload| payload.completion_reason == CompletionReason::Crashed)
            })
        })
    });
    let mut replacement = attach(&fixture, "replacement", None);
    control
        .request("run.resume", json!({"run_id": started["run_id"]}))
        .unwrap();
    let retried = replacement.event("step.dispatch").unwrap();
    assert_eq!(retried["step_id"], "lane-b");
    assert_eq!(retried["attempt"], 2);
    complete(&mut replacement, &retried, json!({"done": "b"})).unwrap();
    let sibling = replacement.event("step.dispatch").unwrap();
    assert_eq!(sibling["step_id"], "lane-a");
    assert_eq!(
        complete(&mut replacement, &sibling, json!({"done": "a"})).unwrap()["status"],
        "completed"
    );
}
