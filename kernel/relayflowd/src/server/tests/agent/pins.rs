//! Appendix A rules 2 and 6 over the wire: where an agent attempt's starting
//! pins come from, and how the chain carries them per surface.

use std::{io::BufReader, sync::Arc};

use relayflowd_core::{CompletionReason, Disposition};
use serde_json::json;
use tempfile::tempdir;

use super::super::super::*;
use super::super::{read_frame, request, shared_writer, step_completions};

#[test]
fn reset_worker_reporting_a_revision_other_than_its_pin_fails_closed_as_worker_error() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path();
    let hub = Arc::new(ProtocolHub::default());
    let (worker_writer, worker_peer) = shared_writer();
    let attached = request(
        data_dir,
        &hub,
        11,
        &worker_writer,
        r#"{"id":"attach-agent","verb":"worker.attach","params":{"worker_id":"agent-stub","step_types":["agent"],"pins":{"workspace":[{"surface":"repo","revision_id":"rev-clean"}]}}}"#,
    );
    assert!(attached.ok, "worker.attach failed: {:?}", attached.error);
    let mut worker_reader = BufReader::new(worker_peer);
    let (control_writer, _control_peer) = shared_writer();
    let spec = json!({
        "steps": [{
            "id": "agent",
            "type": "agent",
            "instruction": "edit",
            "recovery_mode": "reset",
            "surfaces": {"workspace": [{"surface": "repo"}]}
        }]
    });
    let started = request(
        data_dir,
        &hub,
        12,
        &control_writer,
        &json!({"id": "start-agent", "verb": "run.start", "params": {"spec": spec}}).to_string(),
    );
    assert!(started.ok, "run.start failed: {:?}", started.error);
    let run_id = started.result.unwrap()["run_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let dispatch = read_frame(&mut worker_reader)["data"].clone();
    let completion = request(
        data_dir,
        &hub,
        11,
        &worker_writer,
        &json!({
            "id": "complete-agent",
            "verb": "step.complete",
            "params": {
                "run_id": run_id,
                "step_id": "agent",
                "attempt": 1,
                "idempotency_key": dispatch["idempotency_key"],
                "completionReason": "success",
                "output": {"done": true},
                "started_pins": {"workspace": [{"surface": "repo", "revision_id": "rev-dirty"}]},
                "end_pins": {"workspace": [{"surface": "repo", "revision_id": "rev-final"}]}
            }
        })
        .to_string(),
    );
    assert!(
        completion.ok,
        "declared failure must be journaled: {:?}",
        completion.error
    );
    assert_eq!(completion.result.unwrap()["status"], "failed");
    let completions = step_completions(data_dir, &run_id);
    assert_eq!(completions.len(), 1);
    assert_eq!(
        completions[0].completion_reason,
        CompletionReason::WorkerError
    );
    assert_eq!(completions[0].disposition, Disposition::StepDone);
}

/// Appendix A rule 6 chains pins **per surface**. Two agent steps declaring
/// different workspace surfaces must both start: `docs` is worker-sourced
/// because the chain has never pinned it, while `repo` carries forward the end
/// revision of the first step. Before the per-surface carry this wedged the run
/// with a raw `internal` error and no terminal journal entry.
#[test]
fn consecutive_agent_steps_on_different_surfaces_each_start_from_their_own_pins() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path();
    let hub = Arc::new(ProtocolHub::default());
    let (worker_writer, worker_peer) = shared_writer();
    let attached = request(
        data_dir,
        &hub,
        21,
        &worker_writer,
        r#"{"id":"attach","verb":"worker.attach","params":{"worker_id":"agent-stub","step_types":["agent"],"pins":{"workspace":[{"surface":"repo","revision_id":"rev-a"},{"surface":"docs","revision_id":"doc-a"}]}}}"#,
    );
    assert!(attached.ok, "worker.attach failed: {:?}", attached.error);
    let mut worker_reader = BufReader::new(worker_peer);
    let (control_writer, _control_peer) = shared_writer();
    let spec = json!({
        "steps": [
            {
                "id": "edit",
                "type": "agent",
                "instruction": "edit the repo",
                "surfaces": {"workspace": [{"surface": "repo"}]}
            },
            {
                "id": "document",
                "type": "agent",
                "depends_on": ["edit"],
                "instruction": "write the docs",
                "surfaces": {"workspace": [{"surface": "repo"}, {"surface": "docs"}]}
            },
            {
                "id": "review",
                "type": "agent",
                "depends_on": ["document"],
                "instruction": "review the docs only",
                "surfaces": {"workspace": [{"surface": "docs"}]}
            }
        ]
    });
    let started = request(
        data_dir,
        &hub,
        22,
        &control_writer,
        &json!({"id": "start", "verb": "run.start", "params": {"spec": spec}}).to_string(),
    );
    assert!(started.ok, "run.start failed: {:?}", started.error);
    let run_id = started.result.unwrap()["run_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let edit = read_frame(&mut worker_reader)["data"].clone();
    assert_eq!(
        edit["pins"],
        json!({"workspace": [{"surface": "repo", "revision_id": "rev-a"}], "streams": []}),
        "the first step is pinned by the worker holding the surface"
    );
    let completed = request(
        data_dir,
        &hub,
        21,
        &worker_writer,
        &json!({
            "id": "complete-edit",
            "verb": "step.complete",
            "params": {
                "run_id": run_id,
                "step_id": "edit",
                "attempt": 1,
                "idempotency_key": edit["idempotency_key"],
                "completionReason": "success",
                "output": {"done": true},
                "started_pins": edit["pins"],
                "end_pins": {"workspace": [{"surface": "repo", "revision_id": "rev-b"}]}
            }
        })
        .to_string(),
    );
    assert!(completed.ok, "step.complete failed: {:?}", completed.error);

    let document = read_frame(&mut worker_reader)["data"].clone();
    assert_eq!(
        document["pins"],
        json!({"workspace": [
            {"surface": "repo", "revision_id": "rev-b"},
            {"surface": "docs", "revision_id": "doc-a"}
        ], "streams": []}),
        "repo carries forward from the chain; docs is sourced from the worker"
    );
    let completed = request(
        data_dir,
        &hub,
        21,
        &worker_writer,
        &json!({
            "id": "complete-document",
            "verb": "step.complete",
            "params": {
                "run_id": run_id,
                "step_id": "document",
                "attempt": 1,
                "idempotency_key": document["idempotency_key"],
                "completionReason": "success",
                "output": {"done": true},
                "started_pins": document["pins"],
                "end_pins": {"workspace": [
                    {"surface": "repo", "revision_id": "rev-b"},
                    {"surface": "docs", "revision_id": "doc-b"}
                ]}
            }
        })
        .to_string(),
    );
    assert!(completed.ok, "step.complete failed: {:?}", completed.error);

    // The chain now pins two surfaces; a step declaring only one must be
    // journaled with only that one. A surface it does not declare is outside
    // its contract, however the chain came by it.
    let review = read_frame(&mut worker_reader)["data"].clone();
    assert_eq!(
        review["pins"],
        json!({"workspace": [{"surface": "docs", "revision_id": "doc-b"}], "streams": []}),
        "the chain must be projected onto this step's declared surfaces"
    );
    assert_eq!(
        Engine::new(data_dir).snapshot(&run_id).unwrap().status,
        crate::RunStatus::Running,
        "every step is leased to its worker in turn, none wedged"
    );
    assert!(
        step_completions(data_dir, &run_id)
            .iter()
            .all(|completed| completed.completion_reason == CompletionReason::Success),
        "no step may fail on a heterogeneous surface chain"
    );
}
