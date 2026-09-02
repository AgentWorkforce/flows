//! Terminality is enforced at the live protocol mutation boundary.

use relayflowd_core::EntryType;
use serde_json::json;

use super::{
    llm_support::{LlmFixture, ProtocolClient, ServerGuard},
    support::journal_entries,
};

#[test]
fn every_mutating_run_verb_refuses_terminal_before_changing_state() {
    let fixture = LlmFixture::completed("terminal-admission");
    let _server = ServerGuard::start(&fixture);
    let socket = fixture.data_dir.join("relayflowd.sock");
    let mut client = ProtocolClient::connect(&socket);
    let started = client
        .request(
            "run.start",
            json!({"spec": {
                "steps": [{"id": "done", "type": "deterministic", "command": "true"}]
            }}),
        )
        .unwrap();
    assert_eq!(started["status"], "completed");
    let run_id = started["run_id"].as_str().unwrap();
    let before = journal_entries(&fixture.data_dir).unwrap();
    assert_eq!(before.last().unwrap().entry_type, EntryType::RunCompleted);

    let cases = [
        (
            "stream.append",
            json!({"run_id": run_id, "stream": "late", "message": {"bad": true}}),
        ),
        (
            "event.emit",
            json!({"run_id": run_id, "event_key": "late", "payload": {}}),
        ),
        (
            "effect.record",
            json!({
                "run_id": run_id, "step_id": "done", "attempt": 1,
                "idempotency_key": "late", "surface_path": "/provider/item",
                "revision_before": "a", "revision_after": "b"
            }),
        ),
        (
            "effect.confirm",
            json!({
                "run_id": run_id, "step_id": "done", "attempt": 1,
                "idempotency_key": "late", "surface_path": "/provider/item"
            }),
        ),
        (
            "step.complete",
            json!({
                "run_id": run_id, "step_id": "done", "attempt": 1,
                "idempotency_key": "late", "completionReason": "success"
            }),
        ),
        (
            "step.heartbeat",
            json!({
                "run_id": run_id, "step_id": "done", "attempt": 1,
                "lease_id": "late"
            }),
        ),
    ];
    for (verb, params) in cases {
        assert_eq!(client.request_error_code(verb, params), "run_terminal");
        assert_eq!(
            journal_entries(&fixture.data_dir).unwrap().len(),
            before.len(),
            "{verb} changed the terminal journal"
        );
    }
    assert_eq!(
        client
            .request("run.get", json!({"run_id": run_id}))
            .unwrap()["status"],
        "completed"
    );
}
