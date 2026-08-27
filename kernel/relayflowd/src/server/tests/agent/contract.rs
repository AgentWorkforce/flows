//! What the agent protocol boundary refuses, and what it parks instead of
//! failing: attach preflight, undispatchable surfaces, undeclared effects, and
//! the `trajectory_tail` cap.

use std::{io::BufReader, sync::Arc};

use relayflowd_core::{CompletionReason, EntryType, VerificationVerdict};
use serde_json::json;
use tempfile::tempdir;

use super::super::super::*;
use super::super::{attach_llm_worker, read_frame, request, shared_writer, step_completions};

/// `parked` means nothing is coming until something changes; `waiting_worker`
/// means a worker holds this lease and `resume` should block for its
/// completion. A run with no worker at all must be the former, or `resume`
/// waits 30s for a completion that cannot arrive (see
/// `crash_resume::agent::resume_without_a_worker_parks_immediately`).
#[test]
fn agent_without_a_compatible_worker_parks_without_starting() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path();
    let hub = Arc::new(ProtocolHub::default());
    let (writer, _peer) = shared_writer();
    let spec = json!({
        "steps": [{"id": "agent", "type": "agent", "instruction": "wait"}]
    });
    let response = request(
        data_dir,
        &hub,
        1,
        &writer,
        &json!({"id": "start", "verb": "run.start", "params": {"spec": spec}}).to_string(),
    );
    assert!(response.ok, "run.start failed: {:?}", response.error);
    let result = response.result.unwrap();
    assert_eq!(result["status"], "parked");
    let run_id = result["run_id"].as_str().unwrap();
    let registry = relayflowd_journal::Registry::open(data_dir.join("relayflowd.sqlite3")).unwrap();
    assert_eq!(registry.lookup(run_id).unwrap().unwrap().status, "parked");
    assert!(
        Engine::new(data_dir)
            .journal_entries(run_id, 1, usize::MAX)
            .unwrap()
            .iter()
            .all(|entry| entry.entry_type != EntryType::StepAttemptStarted)
    );
}

/// Covenant 2 preflight: a worker that accepts agent steps and reports no
/// surface can never supply Appendix A rule 2 pins. Refusing the attach keeps
/// that provable failure out of the middle of a started run.
#[test]
fn an_agent_worker_attaching_without_pins_is_refused_at_attach() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path();
    let hub = Arc::new(ProtocolHub::default());
    let (writer, _peer) = shared_writer();
    let response = request(
        data_dir,
        &hub,
        31,
        &writer,
        r#"{"id":"attach","verb":"worker.attach","params":{"worker_id":"nopins","step_types":["agent"]}}"#,
    );
    assert!(!response.ok, "attach without pins must be refused");
    let error = response.error.unwrap();
    assert_eq!(error.code, "bad_request");
    assert!(
        error.message.contains("pins"),
        "the refusal must name the missing input: {}",
        error.message
    );
}

/// A worker whose pins do not cover a step's declared surfaces is not a
/// compatible worker. The run parks — a declared state a later worker resolves
/// — instead of failing `run.start` with an untyped error and stranding the run
/// at status `running` with no terminal entry.
#[test]
fn an_agent_worker_missing_a_declared_surface_parks_the_run_instead_of_erroring() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path();
    let hub = Arc::new(ProtocolHub::default());
    let (worker_writer, _worker_peer) = shared_writer();
    let attached = request(
        data_dir,
        &hub,
        41,
        &worker_writer,
        r#"{"id":"attach","verb":"worker.attach","params":{"worker_id":"repo-only","step_types":["agent"],"pins":{"workspace":[{"surface":"repo","revision_id":"rev-a"}]}}}"#,
    );
    assert!(attached.ok, "worker.attach failed: {:?}", attached.error);
    let (control_writer, _control_peer) = shared_writer();
    let spec = json!({
        "steps": [{
            "id": "edit",
            "type": "agent",
            "instruction": "edit the design docs",
            "surfaces": {"workspace": [{"surface": "design-docs"}]}
        }]
    });
    let started = request(
        data_dir,
        &hub,
        42,
        &control_writer,
        &json!({"id": "start", "verb": "run.start", "params": {"spec": spec}}).to_string(),
    );
    assert!(
        started.ok,
        "an unpinnable surface must park, not error: {:?}",
        started.error
    );
    let result = started.result.unwrap();
    assert_eq!(result["status"], "parked");
    let run_id = result["run_id"].as_str().unwrap();
    let registry = relayflowd_journal::Registry::open(data_dir.join("relayflowd.sqlite3")).unwrap();
    assert_eq!(
        registry.lookup(run_id).unwrap().unwrap().status,
        "parked",
        "no run may be left at `running` with nothing to drive it"
    );
    assert!(
        Engine::new(data_dir)
            .journal_entries(run_id, 1, usize::MAX)
            .unwrap()
            .iter()
            .all(|entry| entry.entry_type != EntryType::StepAttemptStarted)
    );
}

/// Appendix A rules 1 and 3: only an agent step declares external surfaces, and
/// only a journaled `effect.record` backs an effect. A non-agent step claiming
/// one is undeclared and unwitnessed, so the completion fails closed with the
/// reason named in the journal rather than recording a writeback as fact.
#[test]
fn an_llm_completion_claiming_an_effect_fails_closed_with_the_reason_journaled() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path();
    let hub = Arc::new(ProtocolHub::default());
    let worker_peer = attach_llm_worker(data_dir, &hub, 51);
    let mut worker_reader = BufReader::new(worker_peer);
    let (control_writer, _control_peer) = shared_writer();
    let spec = json!({"steps": [{"id": "think", "type": "llm", "prompt": "hello"}]});
    let started = request(
        data_dir,
        &hub,
        52,
        &control_writer,
        &json!({"id": "start", "verb": "run.start", "params": {"spec": spec}}).to_string(),
    );
    assert!(started.ok, "run.start failed: {:?}", started.error);
    let run_id = started.result.unwrap()["run_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let dispatch = read_frame(&mut worker_reader)["data"].clone();
    let (worker_writer, _peer) = shared_writer();
    let completion = request(
        data_dir,
        &hub,
        51,
        &worker_writer,
        &json!({
            "id": "complete",
            "verb": "step.complete",
            "params": {
                "run_id": run_id,
                "step_id": "think",
                "attempt": 1,
                "idempotency_key": dispatch["idempotency_key"],
                "completionReason": "success",
                "output": {"text": "hi"},
                "effects": [{"surface_path": "/provider/item", "idempotency_key": "k1"}]
            }
        })
        .to_string(),
    );
    assert!(
        completion.ok,
        "the rejection must be journaled, not raised: {:?}",
        completion.error
    );
    let completions = step_completions(data_dir, &run_id);
    assert_eq!(completions.len(), 1);
    assert_eq!(
        completions[0].completion_reason,
        CompletionReason::WorkerError
    );
    assert!(completions[0].effects.is_empty());
    let verification = completions[0]
        .verification
        .as_ref()
        .expect("a rejection must journal why it was rejected");
    assert_eq!(verification.verdict, VerificationVerdict::Fail);
    assert!(
        verification.detail.contains("cannot claim effects"),
        "the journal must name the mistake: {}",
        verification.detail
    );
}

/// The `trajectory_tail` the docs call bounded is bounded at the boundary that
/// admits it.
#[test]
fn an_oversized_trajectory_tail_is_refused_at_step_complete() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path();
    let hub = Arc::new(ProtocolHub::default());
    let (writer, _peer) = shared_writer();
    let response = request(
        data_dir,
        &hub,
        61,
        &writer,
        &json!({
            "id": "complete",
            "verb": "step.complete",
            "params": {
                "run_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                "step_id": "agent",
                "attempt": 1,
                "idempotency_key": "k",
                "completionReason": "success",
                "output": {},
                "trajectory_tail": {"tail": "x".repeat(TRAJECTORY_TAIL_MAX_BYTES + 1)}
            }
        })
        .to_string(),
    );
    assert!(!response.ok, "an unbounded tail must be refused");
    let error = response.error.unwrap();
    assert_eq!(error.code, "bad_request");
    assert!(error.message.contains("trajectory_tail"));
}

/// Pins are journaled from whichever worker `select_worker` returned; if that
/// answer changes before the dispatch — a detach, a swap — the worker now
/// selected may never have reported those surfaces. Dispatching anyway would
/// hand it a starting state it cannot honor, so it declines and the run parks.
#[test]
fn a_replacement_worker_that_never_reported_the_pinned_surface_is_not_dispatched_to() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path();
    let hub = Arc::new(ProtocolHub::default());
    let (holder_writer, holder_peer) = shared_writer();
    let attached = request(
        data_dir,
        &hub,
        71,
        &holder_writer,
        r#"{"id":"attach","verb":"worker.attach","params":{"worker_id":"repo-holder","step_types":["agent"],"pins":{"workspace":[{"surface":"repo","revision_id":"rev-a"}]}}}"#,
    );
    assert!(attached.ok, "worker.attach failed: {:?}", attached.error);
    let mut holder_reader = BufReader::new(holder_peer);
    let (control_writer, _control_peer) = shared_writer();
    let spec = json!({
        "steps": [{
            "id": "edit",
            "type": "agent",
            "instruction": "edit",
            "max_iterations": 3,
            "retry": {"initial_backoff_ms": 0, "max_backoff_ms": 0, "multiplier": 1, "jitter_percent": 0},
            "surfaces": {"workspace": [{"surface": "repo"}]}
        }]
    });
    let started = request(
        data_dir,
        &hub,
        72,
        &control_writer,
        &json!({"id": "start", "verb": "run.start", "params": {"spec": spec}}).to_string(),
    );
    assert!(started.ok, "run.start failed: {:?}", started.error);
    let run_id = started.result.unwrap()["run_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let first = read_frame(&mut holder_reader)["data"].clone();
    assert_eq!(first["pins"]["workspace"][0]["revision_id"], "rev-a");

    // The pin holder dies; a worker that holds a different surface takes its
    // place and becomes the one `select_worker` returns.
    abandon_connection(data_dir, &hub, 71);
    let (other_writer, _other_peer) = shared_writer();
    let attached = request(
        data_dir,
        &hub,
        73,
        &other_writer,
        r#"{"id":"attach","verb":"worker.attach","params":{"worker_id":"docs-holder","step_types":["agent"],"pins":{"workspace":[{"surface":"docs","revision_id":"doc-a"}]}}}"#,
    );
    assert!(attached.ok, "worker.attach failed: {:?}", attached.error);

    let resumed = request(
        data_dir,
        &hub,
        72,
        &control_writer,
        &json!({"id": "resume", "verb": "run.resume", "params": {"run_id": run_id}}).to_string(),
    );
    assert!(resumed.ok, "run.resume failed: {:?}", resumed.error);
    assert_eq!(resumed.result.unwrap()["status"], "parked");
    let registry = relayflowd_journal::Registry::open(data_dir.join("relayflowd.sqlite3")).unwrap();
    assert_eq!(
        registry.lookup(&run_id).unwrap().unwrap().status,
        "parked",
        "an undispatchable attempt parks; it must not be marked as leased"
    );
}
