use std::{
    io::{BufRead, BufReader},
    os::unix::net::UnixStream,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use relayflowd_core::{CompletionReason, Disposition, EntryType, StepCompletedPayload};
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
