//! Rejected agent evidence cannot advance either durable or live pin state.

use relayflowd_core::{CompletionReason, EntryType, StepCompletedPayload};
use serde_json::json;

use super::{
    llm_support::{LlmFixture, ProtocolClient, ServerGuard},
    support::journal_entries,
};

#[test]
fn rejected_completion_cannot_forge_inspect_retry_pins_over_the_real_socket() {
    let fixture = LlmFixture::parallel("rejected-pin-projection");
    let _server = ServerGuard::start(&fixture);
    let socket = fixture.socket();
    let mut worker = ProtocolClient::connect(&socket);
    worker
        .request(
            "worker.attach",
            json!({
                "worker_id": "pin-worker",
                "step_types": ["agent"],
                "pins": {"workspace": [{"surface": "repo", "revision_id": "rev-0"}]}
            }),
        )
        .unwrap();
    let mut control = ProtocolClient::connect(&socket);
    let started = control
        .request(
            "run.start",
            json!({"spec": {"steps": [{
                "id": "edit",
                "type": "agent",
                "instruction": "edit",
                "recovery_mode": "inspect",
                "max_iterations": 2,
                "retry": {
                    "initial_backoff_ms": 0,
                    "max_backoff_ms": 0,
                    "multiplier": 1,
                    "jitter_percent": 0
                },
                "surfaces": {"workspace": [{"surface": "repo"}]}
            }]}}),
        )
        .unwrap();
    let first = worker.event("step.dispatch").unwrap();
    assert_eq!(first["pins"]["workspace"][0]["revision_id"], "rev-0");

    let rejected = worker
        .request(
            "step.complete",
            json!({
                "run_id": first["run_id"],
                "step_id": first["step_id"],
                "attempt": first["attempt"],
                "idempotency_key": first["idempotency_key"],
                "completionReason": "success",
                "output": {"ok": true},
                "started_pins": {
                    "workspace": [{"surface": "repo", "revision_id": "not-the-journaled-pin"}]
                },
                "end_pins": {
                    "workspace": [{"surface": "repo", "revision_id": "forged-revision"}]
                }
            }),
        )
        .unwrap();
    assert_eq!(rejected["status"], "parked");

    let retry = worker.event("step.dispatch").unwrap();
    assert_eq!(retry["attempt"], 2);
    assert_eq!(retry["pins"], first["pins"]);
    assert_eq!(retry["recovery"]["mode"], "inspect");

    let rejected_fact = journal_entries(&fixture.data_dir)
        .unwrap()
        .into_iter()
        .find(|entry| {
            entry.run_id == started["run_id"]
                && entry.entry_type == EntryType::StepCompleted
                && entry.attempt == Some(1)
        })
        .unwrap();
    let payload: StepCompletedPayload = serde_json::from_value(rejected_fact.payload).unwrap();
    assert_eq!(payload.completion_reason, CompletionReason::WorkerError);
    assert_eq!(payload.end_pins, None);
}
