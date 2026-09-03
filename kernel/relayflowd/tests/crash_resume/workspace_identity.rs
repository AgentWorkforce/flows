//! Workspace mount/worktree identities share one canonical, subtree-aware contract.

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
                "end_pins": dispatch["pins"]
            }),
        )
        .unwrap()
}

#[test]
fn workspace_aliases_are_refused_and_canonical_subtrees_serialize_over_real_sockets() {
    let fixture = LlmFixture::parallel("workspace-identity");
    let _server = ServerGuard::start(&fixture);
    let socket = fixture.data_dir.join("relayflowd.sock");
    let mut worker = ProtocolClient::connect(&socket);
    assert_eq!(
        worker.request_error_code(
            "worker.attach",
            json!({
                "worker_id": "alias-worker",
                "step_types": ["agent"],
                "pins": {"workspace": [
                    {"surface": "/mount/./repo", "revision_id": "rev-0"}
                ]}
            }),
        ),
        "bad_request"
    );
    worker
        .request(
            "worker.attach",
            json!({
                "worker_id": "workspace-worker",
                "step_types": ["agent"],
                "capacity": 2,
                "pins": {"workspace": [
                    {"surface": "/mount/repo", "revision_id": "repo-0"},
                    {"surface": "/mount/repo/child", "revision_id": "child-0"},
                    {"surface": "/mount/left", "revision_id": "left-0"},
                    {"surface": "/mount/right", "revision_id": "right-0"}
                ]}
            }),
        )
        .unwrap();
    let mut control = ProtocolClient::connect(&socket);
    for alias in [
        "/mount/./repo",
        "/mount/repo/../repo",
        "/mount//repo",
        "/mount/repo/",
        " worktrees/repo",
        "worktrees/./repo",
    ] {
        assert_eq!(
            control.request_error_code(
                "run.start",
                json!({"spec": {"steps": [{
                    "id": "bad", "type": "agent", "instruction": "bad",
                    "surfaces": {"workspace": [{"surface": alias}]}
                }]}}),
            ),
            "invalid_spec"
        );
    }

    let overlapping = control
        .request(
            "run.start",
            json!({"spec": {"steps": [
                {"id": "parent", "type": "agent", "instruction": "parent",
                 "surfaces": {"workspace": [{"surface": "/mount/repo"}]}},
                {"id": "child", "type": "agent", "instruction": "child",
                 "surfaces": {"workspace": [{"surface": "/mount/repo/child"}]}}
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
                entry.run_id == overlapping["run_id"]
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
                 "surfaces": {"workspace": [{"surface": "/mount/left"}]}},
                {"id": "right", "type": "agent", "instruction": "right",
                 "surfaces": {"workspace": [{"surface": "/mount/right"}]}}
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
