use std::{
    io::{BufRead, BufReader},
    os::unix::net::UnixStream,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use relayflowd_core::{
    CompletionReason, Disposition, EntryType, StepCompletedPayload, VerificationVerdict,
};
use serde_json::json;
use tempfile::tempdir;

use super::*;
use crate::worker::LeaseProbe;

fn shared_writer() -> (SharedWriter, UnixStream) {
    let (writer, peer) = UnixStream::pair().unwrap();
    (Arc::new(Mutex::new(writer)), peer)
}

fn request(
    data_dir: &Path,
    hub: &Arc<ProtocolHub>,
    connection_id: u64,
    writer: &SharedWriter,
    line: &str,
) -> Response {
    handle_line(data_dir, hub, connection_id, writer, line)
}

fn attach_llm_worker(data_dir: &Path, hub: &Arc<ProtocolHub>, connection_id: u64) -> UnixStream {
    let (writer, peer) = shared_writer();
    let response = request(
        data_dir,
        hub,
        connection_id,
        &writer,
        r#"{"id":"attach","verb":"worker.attach","params":{"worker_id":"unit-stub","step_types":["llm"]}}"#,
    );
    assert!(response.ok, "worker.attach failed: {:?}", response.error);
    peer
}

fn start_llm_run(data_dir: &Path, hub: &Arc<ProtocolHub>) -> String {
    let (writer, _peer) = shared_writer();
    let spec = json!({
        "name": "unit-llm",
        "steps": [{
            "id": "model",
            "type": "llm",
            "prompt": "return the answer",
            "max_iterations": 3,
            "retry": {
                "initial_backoff_ms": 10,
                "max_backoff_ms": 10,
                "multiplier": 1,
                "jitter_percent": 0
            }
        }]
    });
    let line = json!({"id": "start", "verb": "run.start", "params": {"spec": spec}}).to_string();
    let response = request(data_dir, hub, 2, &writer, &line);
    assert!(response.ok, "run.start failed: {:?}", response.error);
    response.result.unwrap()["run_id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn read_frame(reader: &mut BufReader<UnixStream>) -> Value {
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert!(!line.is_empty(), "protocol peer closed unexpectedly");
    serde_json::from_str(&line).unwrap()
}

fn step_completions(data_dir: &Path, run_id: &str) -> Vec<StepCompletedPayload> {
    Engine::new(data_dir)
        .journal_entries(run_id, 1, usize::MAX)
        .unwrap()
        .into_iter()
        .filter(|entry| entry.entry_type == EntryType::StepCompleted)
        .map(|entry| serde_json::from_value(entry.payload).unwrap())
        .collect()
}

#[test]
fn hello_enforces_protocol_version() {
    let directory = tempdir().unwrap();
    let hub = Arc::new(ProtocolHub::default());
    let (writer, _peer) = shared_writer();
    let response = request(
        directory.path(),
        &hub,
        1,
        &writer,
        r#"{"id":1,"verb":"hello","params":{"protocol":0,"client":"test"}}"#,
    );
    assert!(response.ok);
    let mismatch = request(
        directory.path(),
        &hub,
        1,
        &writer,
        r#"{"id":2,"verb":"hello","params":{"protocol":1,"client":"test"}}"#,
    );
    assert!(!mismatch.ok);
}

#[test]
fn run_start_fails_closed_on_an_unknown_verification_key() {
    let directory = tempdir().unwrap();
    let hub = Arc::new(ProtocolHub::default());
    let (writer, _peer) = shared_writer();
    let response = request(
        directory.path(),
        &hub,
        1,
        &writer,
        r#"{"id":3,"verb":"run.start","params":{"spec":{"steps":[{"id":"x","type":"deterministic","command":"true","verification":{"output_contain":"x"}}]}}}"#,
    );
    assert!(!response.ok);
    assert_eq!(response.error.unwrap().code, "invalid_spec");
}

/// Finding 3: a hung worker that stops heartbeating past its lease deadline —
/// socket still open, so no disconnect fires — must not leave the run in
/// waiting_worker forever. The reconciler journals a `lease_expired`
/// completion and the step becomes leasable again.
#[test]
fn stopped_heartbeats_past_the_deadline_journal_lease_expired_and_release_the_step() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path();
    let hub = Arc::new(ProtocolHub::default());
    let worker_peer = attach_llm_worker(data_dir, &hub, 1);
    let mut worker_reader = BufReader::new(worker_peer);
    let run_id = start_llm_run(data_dir, &hub);

    let dispatch = read_frame(&mut worker_reader);
    assert_eq!(dispatch["event"], "step.dispatch");
    assert_eq!(dispatch["data"]["attempt"], 1);
    let lease_id = dispatch["data"]["lease_id"].as_str().unwrap().to_owned();

    // The worker heartbeats once — backdated 40s, as if it then hung — and
    // goes silent while keeping its socket open.
    let key = (run_id.clone(), "model".to_owned(), 1);
    hub.heartbeat(1, &key, &lease_id, now_ms() - 40_000)
        .unwrap();

    // A sweep before the deadline (right after dispatch) abandons nothing.
    let redriven = reconcile::reconcile_pass(data_dir, &hub, now_ms() - 40_000 + 1_000);
    assert!(redriven.is_empty(), "an in-lease attempt must not be swept");

    // Past the deadline the attempt is journaled lease_expired and released.
    let redriven = reconcile::reconcile_pass(data_dir, &hub, now_ms());
    assert_eq!(redriven, vec![run_id.clone()]);
    assert!(!hub.lease_active(&run_id, "model", 1, now_ms() - 60_000));
    let completions = step_completions(data_dir, &run_id);
    assert_eq!(completions.len(), 1);
    assert_eq!(
        completions[0].completion_reason,
        CompletionReason::LeaseExpired
    );
    assert_eq!(completions[0].disposition, Disposition::Retry);

    // The sweep is idempotent: nothing left to expire.
    assert!(reconcile::reconcile_pass(data_dir, &hub, now_ms()).is_empty());
    assert_eq!(step_completions(data_dir, &run_id).len(), 1);

    // The step is runnable again: a resume leases attempt 2 to the worker.
    let (writer, _peer) = shared_writer();
    let line =
        json!({"id": "resume", "verb": "run.resume", "params": {"run_id": run_id}}).to_string();
    let response = request(data_dir, &hub, 2, &writer, &line);
    assert!(response.ok, "run.resume failed: {:?}", response.error);
    let redispatch = read_frame(&mut worker_reader);
    assert_eq!(redispatch["event"], "step.dispatch");
    assert_eq!(redispatch["data"]["attempt"], 2);
}

/// Finding 4: an entry appended concurrently with `run.watch` registration is
/// delivered exactly once — the watcher registers with a cursor before the
/// replay, and buffered live entries are deduped against it.
#[test]
fn an_entry_appended_during_watch_registration_is_delivered_exactly_once() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path();
    let hub = Arc::new(ProtocolHub::default());
    let (control_writer, _control_peer) = shared_writer();
    let spec = json!({
        "name": "watch-gap",
        "steps": [{"id": "only", "type": "deterministic", "command": "true"}]
    });
    let line = json!({"id": "start", "verb": "run.start", "params": {"spec": spec}}).to_string();
    let started = request(data_dir, &hub, 2, &control_writer, &line);
    assert!(started.ok, "run.start failed: {:?}", started.error);
    let run_id = started.result.unwrap()["run_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let dispatcher: Arc<dyn crate::worker::StepDispatcher> = hub.clone();
    let observer: Arc<dyn crate::worker::JournalObserver> = hub.clone();
    let engine = Engine::with_runtime(data_dir, dispatcher, observer);
    let interleaver = {
        let dispatcher: Arc<dyn crate::worker::StepDispatcher> = hub.clone();
        let observer: Arc<dyn crate::worker::JournalObserver> = hub.clone();
        Engine::with_runtime(data_dir, dispatcher, observer)
    };

    let (watch_writer, watch_peer) = shared_writer();
    let run = run_id.clone();
    let result = watch_with_replay(&engine, &hub, 3, &run_id, &watch_writer, || {
        // The historical race window: an append interleaved with watch setup.
        interleaver
            .append_stream(&run, "results", "test", json!({"interleaved": true}))
            .unwrap();
    });
    assert!(result.is_ok(), "run.watch failed: {result:?}");

    // A post-registration append must flow through live delivery, once.
    engine
        .append_stream(&run_id, "results", "test", json!({"live": true}))
        .unwrap();

    let expected = Engine::new(data_dir)
        .journal_entries(&run_id, 1, usize::MAX)
        .unwrap();
    watch_peer
        .set_read_timeout(Some(Duration::from_millis(500)))
        .unwrap();
    let mut reader = BufReader::new(watch_peer);
    let mut seen = Vec::new();
    for _ in 0..expected.len() {
        let frame = read_frame(&mut reader);
        assert_eq!(frame["event"], "entry");
        seen.push(frame["data"]["seq"].as_i64().unwrap());
    }
    let mut leftover = String::new();
    assert!(
        reader.read_line(&mut leftover).is_err(),
        "watcher received a duplicate frame: {leftover}"
    );
    let expected_seqs = expected.iter().map(|entry| entry.seq).collect::<Vec<_>>();
    assert_eq!(
        seen, expected_seqs,
        "every journal entry is delivered exactly once, in order"
    );
}

/// Finding 5: when the journal append for a disconnect's crashed completion
/// fails, the abandonment is surfaced and retained for the reconciler — never
/// silently dropped — and the reconciler journals it once the journal heals.
#[test]
fn a_failed_disconnect_journal_append_is_retained_and_retried_not_dropped() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path();
    let hub = Arc::new(ProtocolHub::default());
    let worker_peer = attach_llm_worker(data_dir, &hub, 1);
    let mut worker_reader = BufReader::new(worker_peer);
    let run_id = start_llm_run(data_dir, &hub);
    let dispatch = read_frame(&mut worker_reader);
    assert_eq!(dispatch["data"]["attempt"], 1);

    // Inject a journal failure: the run journal is unreachable when the
    // worker's connection dies.
    let run_file = data_dir.join("runs").join(format!("{run_id}.sqlite3"));
    let hidden = data_dir.join("runs").join(format!("{run_id}.sqlite3.away"));
    std::fs::rename(&run_file, &hidden).unwrap();
    abandon_connection(data_dir, &hub, 1);
    std::fs::rename(&hidden, &run_file).unwrap();

    // Nothing was journaled — and nothing was dropped: the abandonment is
    // retained and the reconciler retries it against the healed journal.
    assert!(step_completions(data_dir, &run_id).is_empty());
    let redriven = reconcile::reconcile_pass(data_dir, &hub, now_ms());
    assert_eq!(redriven, vec![run_id.clone()]);
    let completions = step_completions(data_dir, &run_id);
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0].completion_reason, CompletionReason::Crashed);

    // Fully drained: a second pass has nothing left to record.
    assert!(reconcile::reconcile_pass(data_dir, &hub, now_ms()).is_empty());
    assert_eq!(step_completions(data_dir, &run_id).len(), 1);
}

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
