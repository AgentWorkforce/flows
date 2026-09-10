//! External mount-write identity is canonical and subtree-aware.

use relayflowd_core::EntryType;
use serde_json::{Value, json};

use super::{
    llm_support::{LlmFixture, ProtocolClient, ServerGuard},
    support::journal_entries,
};

fn complete(worker: &mut ProtocolClient, dispatch: &Value) -> Value {
    worker
        .request(
            "step.complete",
            json!({
                "run_id": dispatch["run_id"],
                "step_id": dispatch["step_id"],
                "attempt": dispatch["attempt"],
                "idempotency_key": dispatch["idempotency_key"],
                "completionReason": "success",
                "output": {"done": dispatch["step_id"]},
                "started_pins": dispatch["pins"],
                "end_pins": {}
            }),
        )
        .unwrap()
}

#[test]
fn aliases_are_rejected_and_external_ancestors_serialize_over_real_sockets() {
    let fixture = LlmFixture::parallel("surface-identity");
    let _server = ServerGuard::start(&fixture);
    let socket = fixture.socket();
    let mut worker = ProtocolClient::connect(&socket);
    worker
        .request(
            "worker.attach",
            json!({
                "worker_id": "surface-worker",
                "step_types": ["agent"],
                "capacity": 2,
                "pins": {"workspace": [{"surface": "unused", "revision_id": "r0"}]}
            }),
        )
        .unwrap();
    let mut control = ProtocolClient::connect(&socket);
    for alias in [
        "/provider/./item",
        "/provider/../item",
        "/provider//item",
        "/provider/item//",
        "/provider/item/",
    ] {
        assert_eq!(
            control.request_error_code(
                "run.start",
                json!({"spec": {"steps": [{
                    "id": "bad", "type": "agent", "instruction": "bad",
                    "surfaces": {"external": [alias]}
                }]}}),
            ),
            "invalid_spec"
        );
    }

    let started = control
        .request(
            "run.start",
            json!({"spec": {"steps": [
                {"id": "parent", "type": "agent", "instruction": "parent",
                 "surfaces": {"external": ["/provider/item"]}},
                {"id": "child", "type": "agent", "instruction": "child",
                 "surfaces": {"external": ["/provider/item/child"]}}
            ]}}),
        )
        .unwrap();
    let parent = worker.event("step.dispatch").unwrap();
    assert_eq!(parent["step_id"], "parent");
    assert_eq!(
        journal_entries(&fixture.data_dir)
            .unwrap()
            .iter()
            .filter(|entry| {
                entry.run_id == started["run_id"]
                    && entry.entry_type == EntryType::StepAttemptStarted
            })
            .count(),
        1
    );
    complete(&mut worker, &parent);
    let child = worker.event("step.dispatch").unwrap();
    assert_eq!(child["step_id"], "child");
    assert_eq!(complete(&mut worker, &child)["status"], "completed");

    let disjoint = control
        .request(
            "run.start",
            json!({"spec": {"steps": [
                {"id": "left", "type": "agent", "instruction": "left",
                 "surfaces": {"external": ["/provider/left"]}},
                {"id": "right", "type": "agent", "instruction": "right",
                 "surfaces": {"external": ["/provider/right"]}}
            ]}}),
        )
        .unwrap();
    assert_eq!(disjoint["status"], "parked");
    let left = worker.event("step.dispatch").unwrap();
    let right = worker.event("step.dispatch").unwrap();
    assert_eq!([&left["step_id"], &right["step_id"]], ["left", "right"]);
    complete(&mut worker, &right);
    assert_eq!(complete(&mut worker, &left)["status"], "completed");
}
