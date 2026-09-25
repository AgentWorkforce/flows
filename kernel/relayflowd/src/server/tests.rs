use std::{
    io::{BufRead, BufReader},
    os::unix::net::UnixStream,
    path::Path,
    sync::{Arc, Condvar, Mutex, mpsc},
    thread,
    time::Duration,
};

use relayflowd_core::{CompletionReason, Disposition, EntryType, StepCompletedPayload};
use serde_json::json;
use tempfile::tempdir;

use super::*;
use crate::worker::{JournalObserver, LeaseProbe};

mod agent;

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
                "jitter_percent": 0,
                "max_transport_retries": 1
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

#[test]
fn run_start_admission_key_recovers_the_same_run_and_refuses_spec_drift() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path();
    let hub = Arc::new(ProtocolHub::default());
    let (writer, _peer) = shared_writer();
    let first = request(
        data_dir,
        &hub,
        1,
        &writer,
        &json!({"id":"one","verb":"run.start","params":{
            "admission_key":"authored-root:fixture",
            "spec":{"name":"root","steps":[]}
        }})
        .to_string(),
    );
    assert!(first.ok, "first admission failed: {:?}", first.error);
    let run_id = first.result.unwrap()["run_id"].as_str().unwrap().to_owned();

    let retried = request(
        data_dir,
        &hub,
        1,
        &writer,
        &json!({"id":"two","verb":"run.start","params":{
            "admission_key":"authored-root:fixture",
            "spec":{"name":"root","steps":[]}
        }})
        .to_string(),
    );
    assert!(retried.ok, "retry failed: {:?}", retried.error);
    assert_eq!(retried.result.unwrap()["run_id"], run_id);

    let drifted = request(
        data_dir,
        &hub,
        1,
        &writer,
        &json!({"id":"three","verb":"run.start","params":{
            "admission_key":"authored-root:fixture",
            "spec":{"name":"different","steps":[]}
        }})
        .to_string(),
    );
    assert!(!drifted.ok);
    assert_eq!(drifted.error.unwrap().code, "run_admission_conflict");
}

/// flows#545: an authored `done("step_failed", { detail })` travels as JSON
/// inside the terminal marker's deterministic command.
///
/// The SDK relies on three kernel properties for that to be durable evidence
/// rather than a claim: the command is journaled verbatim and survives a
/// reopen, re-admitting the identical spec under the same admission key
/// returns the same run without spawning a second one, and a spec whose
/// marker data changed is refused instead of quietly admitted. No kernel
/// change was needed for the detail — it is opaque data in a shell string —
/// so this test exists to keep it that way.
#[test]
fn deterministic_marker_carrying_json_survives_reopen_and_refuses_changed_detail() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path();
    let hub = Arc::new(ProtocolHub::default());
    let (writer, _peer) = shared_writer();
    let marker = |detail: &str| {
        format!(
            r#"printf '%s' '{{"completionReason":"step_failed","detail":"{detail}"}}'"#
        )
    };
    let start = |id: &str, command: &str| {
        json!({"id": id, "verb": "run.start", "params": {
            "admission_key": "authored-child:complete-2",
            "spec": {"name": "software-factory/complete-2", "steps": [{
                "id": "complete-2", "type": "deterministic", "command": command,
            }]}
        }})
        .to_string()
    };

    let detail = "review found 1 P2: review.clean was not created";
    let first = request(data_dir, &hub, 1, &writer, &start("one", &marker(detail)));
    assert!(first.ok, "first admission failed: {:?}", first.error);
    let run_id = first.result.unwrap()["run_id"].as_str().unwrap().to_owned();

    // Same spec, same key: the same run, not a second effect.
    let retried = request(data_dir, &hub, 1, &writer, &start("two", &marker(detail)));
    assert!(retried.ok, "idempotent retry failed: {:?}", retried.error);
    assert_eq!(retried.result.unwrap()["run_id"], run_id);

    // Reopened from disk by this request, the journal holds exactly one
    // spawn, and the marker command came back character for character.
    let read = request(
        data_dir,
        &hub,
        1,
        &writer,
        &json!({"id":"read","verb":"journal.read","params":{"run_id": run_id}}).to_string(),
    );
    assert!(read.ok, "journal.read failed: {:?}", read.error);
    let entries = read.result.unwrap();
    let spawned: Vec<_> = entries["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["entry_type"] == "run.spawned")
        .collect();
    assert_eq!(spawned.len(), 1, "one admitted run, one spawn");
    assert_eq!(
        spawned[0]["payload"]["spec"]["steps"][0]["command"]
            .as_str()
            .unwrap(),
        marker(detail),
    );

    // One character of the detail differs: a different spec under an identity
    // that is already spoken for, and the kernel fails closed rather than
    // letting a second verdict take the first one's place.
    let drifted = request(
        data_dir,
        &hub,
        1,
        &writer,
        &start("three", &marker("review found 2 P2s")),
    );
    assert!(!drifted.ok);
    assert_eq!(drifted.error.unwrap().code, "run_admission_conflict");
}

/// flows#545: a lone UTF-16 surrogate is refused at the line, with no id.
///
/// This is the kernel property the SDK's detail normalization exists for. A
/// JavaScript string is code units, not text, so trimming an agent's output —
/// `(prose + "\u{1F642}").slice(0, -1)` — produces a `string` whose last half
/// of a surrogate pair has no partner. `JSON.stringify` escapes it, so the
/// frame is syntactically sendable; this decoder is where it stops. The
/// refusal carries `"id": null`, because the id is inside the frame that did
/// not parse — so it resolves no pending client request, and a caller that is
/// waiting on one waits forever. Normalizing before the write
/// (`packages/sdk/src/authored-completion.ts`) is the only place that can
/// keep an authored explanation out of this.
#[test]
fn a_lone_surrogate_in_a_request_is_refused_with_no_request_id() {
    let directory = tempdir().unwrap();
    let hub = Arc::new(ProtocolHub::default());
    let (writer, _peer) = shared_writer();

    let refused = request(
        directory.path(),
        &hub,
        1,
        &writer,
        r#"{"id":"probe","verb":"hello","params":{"protocol":0,"client":"review found 1 P2: \ud83d"}}"#,
    );

    assert!(!refused.ok);
    assert_eq!(
        refused.id,
        Value::Null,
        "a refusal no pending request can be matched to"
    );
    assert_eq!(refused.error.unwrap().code, "bad_request");

    // The complete pair is ordinary text and is accepted, so what the decoder
    // refuses above is the lone half, not the emoji.
    let paired = request(
        directory.path(),
        &hub,
        1,
        &writer,
        r#"{"id":"probe","verb":"hello","params":{"protocol":0,"client":"review found 1 P2: \ud83d\ude42"}}"#,
    );
    assert!(paired.ok, "a well-formed pair was refused: {:?}", paired.error);
}

#[test]
fn run_start_refuses_invalid_admission_keys() {
    let directory = tempdir().unwrap();
    let hub = Arc::new(ProtocolHub::default());
    let (writer, _peer) = shared_writer();
    let response = request(
        directory.path(),
        &hub,
        1,
        &writer,
        &json!({"id":"one","verb":"run.start","params":{
            "admission_key":"spaces are not an identity",
            "spec":{"name":"root","steps":[]}
        }})
        .to_string(),
    );
    assert!(!response.ok);
    assert_eq!(response.error.unwrap().code, "invalid_admission_key");
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

struct PausingObserver {
    hub: Arc<ProtocolHub>,
    committed: Arc<(Mutex<bool>, Condvar)>,
    resume: Arc<(Mutex<bool>, Condvar)>,
}

impl JournalObserver for PausingObserver {
    fn appended(&self, entry: &relayflowd_core::JournalEntry) {
        let (committed, committed_signal) = &*self.committed;
        *committed.lock().unwrap() = true;
        committed_signal.notify_one();

        let (resume, resume_signal) = &*self.resume;
        let mut ready = resume.lock().unwrap();
        while !*ready {
            ready = resume_signal.wait(ready).unwrap();
        }
        self.hub.appended(entry);
    }
}

fn wait_for_signal(signal: &Arc<(Mutex<bool>, Condvar)>) {
    let (ready, condition) = &**signal;
    let mut ready = ready.lock().unwrap();
    while !*ready {
        ready = condition.wait(ready).unwrap();
    }
}

fn send_signal(signal: &Arc<(Mutex<bool>, Condvar)>) {
    let (ready, condition) = &**signal;
    *ready.lock().unwrap() = true;
    condition.notify_one();
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

#[test]
fn run_resume_asks_the_registry_instead_of_treating_an_orphan_file_as_a_run() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path();
    let runs = data_dir.join("runs");
    std::fs::create_dir_all(&runs).unwrap();
    std::fs::File::create(runs.join("orphan.sqlite3")).unwrap();
    let hub = Arc::new(ProtocolHub::default());
    let (writer, _peer) = shared_writer();

    let response = request(
        data_dir,
        &hub,
        1,
        &writer,
        r#"{"id":"resume","verb":"run.resume","params":{"run_id":"orphan"}}"#,
    );

    let error = response.error.expect("orphan file must be refused");
    assert_eq!(error.code, "run_not_found");
}

/// #174: a run whose journal exists but whose registry row does not must be
/// RESUMABLE, not refused.
///
/// `Engine::start` creates the journal, appends RunSpawned, then registers the
/// run last. A crash in that window leaves exactly this state, and refusing it
/// made the run unrecoverable forever -- the journal was on disk, complete, and
/// nothing could reach it. That is a durability hole, not a lookup miss.
///
/// This is the counterpart to the orphan-file test above, and the pair states
/// the rule together: adopt a journal that is real, refuse a file that is not.
#[test]
fn run_resume_adopts_a_real_journal_whose_registry_row_is_missing() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path();

    // A genuine run, created the way the engine creates one.
    let outcome = Engine::new(data_dir)
        .start(
            serde_json::from_value(json!({
                "steps": [{
                    "id": "x",
                    "type": "deterministic",
                    "command": ["/bin/sh", "-c", "printf x"],
                    "verification": {"output_contains": "x"}
                }]
            }))
            .unwrap(),
            "test",
            None,
        )
        .unwrap();
    let run_id = outcome.run_id.clone();
    assert!(
        data_dir
            .join("runs")
            .join(format!("{run_id}.sqlite3"))
            .exists()
    );

    // Reproduce the crash window: the journal survives, the index entry does
    // not. Removing the registry outright is the same state a SIGKILL between
    // the append and the register leaves behind, and strictly harsher -- the
    // row is not merely stale, there is nothing to consult at all.
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(data_dir.join(format!("relayflowd.sqlite3{suffix}")));
    }
    let registry = relayflowd_journal::Registry::open(data_dir.join("relayflowd.sqlite3")).unwrap();
    assert!(registry.lookup(&run_id).unwrap().is_none());

    let hub = Arc::new(ProtocolHub::default());
    let (writer, _peer) = shared_writer();
    let response = request(
        data_dir,
        &hub,
        1,
        &writer,
        &format!(r#"{{"id":"resume","verb":"run.resume","params":{{"run_id":"{run_id}"}}}}"#),
    );

    assert!(
        response.ok,
        "a real journal with no registry row must be adopted, not refused: {:?}",
        response.error
    );
    // And the index is repaired, so the next lookup does not depend on this
    // path running again.
    assert!(
        registry.lookup(&run_id).unwrap().is_some(),
        "resume must re-register the run it adopted"
    );
}

/// #185. The fourth case, and the one #177 got wrong: a journal that was
/// CREATED but never recorded its run.
///
/// `Engine::start` creates the journal, appends RunSpawned, then registers, so a
/// crash has two residues. One is a real run missing its index entry -- adopt
/// it. The other is an empty file that never became a run, and it still carries
/// a meta row with the run id, so an id check alone accepts it. #177 did exactly
/// that, and resume then died on `read run spec: Query returned no rows` instead
/// of saying the run does not exist.
#[test]
fn run_resume_refuses_a_journal_that_never_recorded_its_run() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path();
    let run_id = "01EMPTYJOURNALEMPTYJOURNAL";

    // Exactly what a kill between `create` and the RunSpawned append leaves:
    // a valid journal for this run id, with no entries at all.
    std::fs::create_dir_all(data_dir.join("runs")).unwrap();
    let path = data_dir.join("runs").join(format!("{run_id}.sqlite3"));
    let journal = relayflowd_journal::SqliteJournal::create(&path, run_id, 0).unwrap();
    assert_eq!(
        journal.run_id(),
        run_id,
        "the meta row is what makes this tempting"
    );
    assert!(
        journal.run_spec().is_err(),
        "and there is no spec to resume"
    );
    drop(journal);

    let hub = Arc::new(ProtocolHub::default());
    let (writer, _peer) = shared_writer();
    let response = request(
        data_dir,
        &hub,
        1,
        &writer,
        &format!(r#"{{"id":"resume","verb":"run.resume","params":{{"run_id":"{run_id}"}}}}"#),
    );

    let error = response
        .error
        .expect("a journal that never recorded its run must be refused");
    assert_eq!(
        error.code, "run_not_found",
        "refusing it as not-found is the honest answer; an internal spec-read \
         failure is not"
    );

    let registry = relayflowd_journal::Registry::open(data_dir.join("relayflowd.sqlite3")).unwrap();
    assert!(
        registry.lookup(run_id).unwrap().is_none(),
        "a refused journal must not leave a registry row behind"
    );
}

/// #174, third case: a journal that is structurally VALID but belongs to a
/// different run must still be refused.
///
/// Opening a journal does not verify whose it is -- `SqliteJournal::open`
/// reports whatever run id the file carries. Without an explicit comparison,
/// a well-formed journal for run A dropped at `runs/B.sqlite3` would be
/// registered as B purely on the strength of its filename, which is the
/// filesystem-derived existence that WP-12/F7 removed on purpose.
#[test]
fn run_resume_refuses_a_valid_journal_that_belongs_to_another_run() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path();

    let outcome = Engine::new(data_dir)
        .start(
            serde_json::from_value(json!({
                "steps": [{
                    "id": "x",
                    "type": "deterministic",
                    "command": ["/bin/sh", "-c", "printf x"],
                    "verification": {"output_contains": "x"}
                }]
            }))
            .unwrap(),
            "test",
            None,
        )
        .unwrap();
    let real_id = outcome.run_id.clone();

    // A complete, openable journal -- under someone else's name.
    let impostor = "01IMPOSTORIMPOSTORIMPOSTOR";
    std::fs::copy(
        data_dir.join("runs").join(format!("{real_id}.sqlite3")),
        data_dir.join("runs").join(format!("{impostor}.sqlite3")),
    )
    .unwrap();
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(data_dir.join(format!("relayflowd.sqlite3{suffix}")));
    }

    let hub = Arc::new(ProtocolHub::default());
    let (writer, _peer) = shared_writer();
    let response = request(
        data_dir,
        &hub,
        1,
        &writer,
        &format!(r#"{{"id":"resume","verb":"run.resume","params":{{"run_id":"{impostor}"}}}}"#),
    );

    let error = response
        .error
        .expect("a journal belonging to another run must be refused");
    assert_eq!(error.code, "run_not_found");

    // And nothing was adopted under the impostor id.
    let registry = relayflowd_journal::Registry::open(data_dir.join("relayflowd.sqlite3")).unwrap();
    assert!(
        registry.lookup(impostor).unwrap().is_none(),
        "a refused journal must not leave a registry row behind"
    );
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

/// `step.wait` parks a leased attempt on a durable human question without
/// completing it; `event.emit` keyed by the wait id closes it as
/// `human_responded` and the step is dispatched again as a fresh attempt.
#[test]
fn step_wait_parks_the_attempt_and_a_human_answer_redispatches_it() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path();
    let hub = Arc::new(ProtocolHub::default());
    let (worker_writer, worker_peer) = shared_writer();
    let attach = request(
        data_dir,
        &hub,
        1,
        &worker_writer,
        r#"{"id":"attach","verb":"worker.attach","params":{"worker_id":"unit-stub","step_types":["llm"]}}"#,
    );
    assert!(attach.ok, "worker.attach failed: {:?}", attach.error);
    let mut worker_reader = BufReader::new(worker_peer);
    let run_id = start_llm_run(data_dir, &hub);

    let dispatch = read_frame(&mut worker_reader);
    assert_eq!(dispatch["event"], "step.dispatch");
    assert_eq!(dispatch["data"]["attempt"], 1);
    let idempotency_key = dispatch["data"]["idempotency_key"].as_str().unwrap().to_owned();
    let wait = |connection: u64, wait_id: &str| {
        request(
            data_dir,
            &hub,
            connection,
            &worker_writer,
            &json!({"id": "wait", "verb": "step.wait", "params": {
                "run_id": run_id, "step_id": "model", "attempt": 1,
                "idempotency_key": idempotency_key, "wait_id": wait_id,
                "prompt": "Ship this?", "requested_of": "khaliq",
            }})
            .to_string(),
        )
    };

    // Only the lease holder may park the attempt.
    let stranger = wait(9, "human-1");
    assert!(!stranger.ok);
    assert_eq!(stranger.error.unwrap().code, "lease_conflict");

    let parked = wait(1, "human-1");
    assert!(parked.ok, "step.wait failed: {:?}", parked.error);
    assert_eq!(parked.result.unwrap()["status"], "parked");
    // Nothing completed: the attempt asked a question, it did not fail.
    assert!(step_completions(data_dir, &run_id).is_empty());
    let (writer, _peer) = shared_writer();
    let snapshot = request(
        data_dir,
        &hub,
        2,
        &writer,
        &json!({"id": "get", "verb": "run.get", "params": {"run_id": run_id}}).to_string(),
    );
    let snapshot = snapshot.result.unwrap();
    assert_eq!(snapshot["status"], "parked");
    assert_eq!(snapshot["steps"]["model"]["state"], "needs_human");
    // The lease is released, so the worker connection closing later is not a crash.
    assert!(!hub.lease_active(&run_id, "model", 1, now_ms()));

    // The same question cannot be asked twice under one id, and a released
    // attempt holds no lease to park again anyway.
    let again = wait(1, "human-1");
    assert!(!again.ok);

    // An answer to a different wait matches nothing and changes nothing.
    let stray = request(
        data_dir,
        &hub,
        2,
        &writer,
        &json!({"id": "emit", "verb": "event.emit", "params": {
            "run_id": run_id, "event_key": "human-2", "payload": {"answer": true},
        }})
        .to_string(),
    );
    assert_eq!(stray.result.unwrap()["matched"], 0);

    // An unattributed answer cannot close a human wait.
    let anonymous = request(
        data_dir,
        &hub,
        2,
        &writer,
        &json!({"id": "emit", "verb": "event.emit", "params": {
            "run_id": run_id, "event_key": "human-1", "payload": {"answer": true},
        }})
        .to_string(),
    );
    assert!(!anonymous.ok);
    assert!(
        anonymous.error.unwrap().message.contains("answeredBy"),
        "refusal names the missing attribution"
    );

    let answered = request(
        data_dir,
        &hub,
        2,
        &writer,
        &json!({"id": "emit", "verb": "event.emit", "params": {
            "run_id": run_id, "event_key": "human-1",
            "payload": {"answer": true, "answeredBy": "khaliq", "at": "1999-01-01T00:00:00Z"},
        }})
        .to_string(),
    );
    assert!(answered.ok, "event.emit failed: {:?}", answered.error);
    assert_eq!(answered.result.unwrap()["matched"], 1);
    let redispatch = read_frame(&mut worker_reader);
    assert_eq!(redispatch["event"], "step.dispatch");
    assert_eq!(redispatch["data"]["attempt"], 2);

    let entries = Engine::new(data_dir)
        .journal_entries(&run_id, 1, usize::MAX)
        .unwrap();
    let completed = entries
        .iter()
        .find(|entry| entry.entry_type == EntryType::WaitCompleted)
        .expect("wait.completed journaled");
    assert_eq!(completed.payload["wait_id"], "human-1");
    assert_eq!(completed.payload["completionReason"], "human_responded");
    assert_eq!(completed.payload["result"]["answer"], true);
    // The journal's clock, not the client's, says when; attribution is
    // recorded as what it is.
    assert_eq!(completed.payload["result"]["answeredBy"], "khaliq");
    assert_eq!(completed.payload["result"]["attribution"], "client_asserted");
    assert!(completed.payload["result"].get("at").is_none());
    assert_eq!(completed.payload["result"]["at_ms"], completed.at_ms);
    // Answering again matches nothing: the wait is closed.
    let repeat = request(
        data_dir,
        &hub,
        2,
        &writer,
        &json!({"id": "emit", "verb": "event.emit", "params": {
            "run_id": run_id, "event_key": "human-1",
            "payload": {"answer": false, "answeredBy": "khaliq"},
        }})
        .to_string(),
    );
    assert_eq!(repeat.result.unwrap()["matched"], 0);
}

/// Finding 4: an entry committed before `run.watch` registration but whose
/// hub notification is delayed is delivered exactly once. The run lock makes
/// the journal commit and notification indivisible from watch registration.
#[test]
fn an_entry_appended_during_watch_registration_is_delivered_exactly_once() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path();
    let hub = Arc::new(ProtocolHub::default());
    let (control_writer, _control_peer) = shared_writer();
    let spec = json!({
        "name": "watch-gap",
        "steps": [{"id": "only", "type": "llm", "prompt": "wait for a worker"}]
    });
    let line = json!({"id": "start", "verb": "run.start", "params": {"spec": spec}}).to_string();
    let started = request(data_dir, &hub, 2, &control_writer, &line);
    assert!(started.ok, "run.start failed: {:?}", started.error);
    let run_id = started.result.unwrap()["run_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let dispatcher: Arc<dyn crate::worker::StepDispatcher> = hub.clone();
    let observer: Arc<dyn JournalObserver> = hub.clone();
    let engine = Engine::with_runtime(data_dir, dispatcher, observer);

    let committed = Arc::new((Mutex::new(false), Condvar::new()));
    let resume = Arc::new((Mutex::new(false), Condvar::new()));
    let interleaver = Engine::with_runtime(
        data_dir,
        hub.clone(),
        Arc::new(PausingObserver {
            hub: hub.clone(),
            committed: committed.clone(),
            resume: resume.clone(),
        }),
    );

    let append_run = run_id.clone();
    let run_lock = hub.run_lock(&run_id);
    let append_lock = run_lock.clone();
    let append = thread::spawn(move || {
        let _guard = append_lock.lock().unwrap();
        interleaver
            .append_stream(&append_run, "results", "test", json!({"interleaved": true}))
            .unwrap();
    });
    wait_for_signal(&committed);

    let (watch_writer, watch_peer) = shared_writer();
    let watch_hub = hub.clone();
    let watch_run = run_id.clone();
    let (watch_started, watch_is_started) = mpsc::sync_channel(0);
    let (watch_ready, watch_is_ready) = mpsc::sync_channel(0);
    let watch = thread::spawn(move || {
        watch_started.send(()).unwrap();
        watch_with_replay(&engine, &watch_hub, 3, &watch_run, &watch_writer, || {
            watch_ready.send(()).unwrap();
        })
    });
    // The rendezvous puts the watch thread immediately at registration while
    // the committed append still owns the run lock. With the fix, registering
    // takes a reference to that lock and blocks. Without it, `after_ready`
    // fires instead. Both are explicit synchronization states, not elapsed
    // time or a scheduler guess.
    watch_is_started.recv().unwrap();
    let ready_before_append_notification = loop {
        if watch_is_ready.try_recv().is_ok() {
            break true;
        }
        if Arc::strong_count(&run_lock) > 3 {
            break false;
        }
        thread::yield_now();
    };
    send_signal(&resume);
    append.join().unwrap();
    if !ready_before_append_notification {
        watch_is_ready.recv().unwrap();
    }
    let result = watch.join().unwrap();
    assert!(result.is_ok(), "run.watch failed: {result:?}");

    // A post-registration append must flow through live delivery, once.
    let live_engine = Engine::with_runtime(data_dir, hub.clone(), hub.clone());
    live_engine
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

/// `run.start` with `watch` streams the new run's entries on the starting
/// connection from `run.spawned` on, each exactly once, before the result —
/// the only moment a client that does not yet know the run id can observe it.
#[test]
fn run_start_with_watch_streams_every_entry_once_before_the_result() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path();
    let hub = Arc::new(ProtocolHub::default());
    let (writer, peer) = shared_writer();
    let spec = json!({"steps": [
        {"id": "a", "type": "deterministic", "command": ["/bin/sh", "-c", "printf a"]},
        {"id": "b", "type": "deterministic", "command": ["/bin/sh", "-c", "printf b"], "depends_on": ["a"]}
    ]});
    let line = json!({"id": "start", "verb": "run.start", "params": {"spec": spec, "watch": true}})
        .to_string();
    let started = request(data_dir, &hub, 1, &writer, &line);
    assert!(started.ok, "run.start failed: {:?}", started.error);
    let run_id = started.result.unwrap()["run_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let expected = Engine::new(data_dir)
        .journal_entries(&run_id, 1, usize::MAX)
        .unwrap();
    assert_eq!(expected.first().unwrap().entry_type, EntryType::RunSpawned);
    assert_eq!(expected.last().unwrap().entry_type, EntryType::RunCompleted);
    peer.set_read_timeout(Some(Duration::from_millis(500)))
        .unwrap();
    let mut reader = BufReader::new(peer);
    let seen = (0..expected.len())
        .map(|_| {
            let frame = read_frame(&mut reader);
            assert_eq!(frame["event"], "entry");
            assert_eq!(frame["data"]["run_id"], run_id.as_str());
            frame["data"]["seq"].as_i64().unwrap()
        })
        .collect::<Vec<_>>();
    let mut leftover = String::new();
    assert!(
        reader.read_line(&mut leftover).is_err(),
        "watcher received a duplicate frame: {leftover}"
    );
    assert_eq!(
        seen,
        expected.iter().map(|entry| entry.seq).collect::<Vec<_>>()
    );
}

/// Without `watch`, `run.start` pushes nothing: the flag is opt-in.
#[test]
fn run_start_without_watch_pushes_no_entries() {
    let directory = tempdir().unwrap();
    let data_dir = directory.path();
    let hub = Arc::new(ProtocolHub::default());
    let (writer, peer) = shared_writer();
    let spec = json!({"steps": [{"id": "a", "type": "deterministic", "command": ["/bin/sh", "-c", "printf a"]}]});
    let line = json!({"id": "start", "verb": "run.start", "params": {"spec": spec}}).to_string();
    assert!(request(data_dir, &hub, 1, &writer, &line).ok);
    assert_eq!(hub.watcher_count(1), 0);
    peer.set_nonblocking(true).unwrap();
    let mut leftover = String::new();
    assert!(
        BufReader::new(peer).read_line(&mut leftover).is_err(),
        "an unwatched start pushed a frame: {leftover}"
    );
}

#[test]
fn run_start_watch_replays_an_existing_admission() {
    let directory = tempdir().unwrap();
    let hub = Arc::new(ProtocolHub::default());
    let (writer, peer) = shared_writer();
    let params = json!({"admission_key":"watch-retry", "spec":{"steps":[]}});
    let first = request(
        directory.path(),
        &hub,
        1,
        &writer,
        &json!({"id":"first","verb":"run.start","params":params}).to_string(),
    );
    assert!(first.ok);
    let run_id = first.result.unwrap()["run_id"].as_str().unwrap().to_owned();
    let mut params = params;
    params["watch"] = json!(true);
    let retry = request(
        directory.path(),
        &hub,
        1,
        &writer,
        &json!({"id":"retry","verb":"run.start","params":params}).to_string(),
    );
    assert!(retry.ok);
    assert_eq!(retry.result.unwrap()["run_id"], run_id);
    let expected = Engine::new(directory.path())
        .journal_entries(&run_id, 1, usize::MAX)
        .unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let mut reader = BufReader::new(peer);
    for entry in expected {
        assert_eq!(read_frame(&mut reader)["data"]["seq"], entry.seq);
    }
    assert_eq!(hub.watcher_count(1), 1);
    // A boot change takes the Recover branch rather than Existing.
    rusqlite::Connection::open(directory.path().join("relayflowd.sqlite3"))
        .unwrap()
        .execute("UPDATE run_admissions SET boot_id = 'dead-boot'", [])
        .unwrap();
    let (writer2, peer2) = shared_writer();
    let recovered = request(
        directory.path(),
        &hub,
        2,
        &writer2,
        &json!({"id":"recover","verb":"run.start","params":params}).to_string(),
    );
    assert!(recovered.ok);
    assert_eq!(recovered.result.unwrap()["run_id"], run_id);
    peer2
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    assert_eq!(
        read_frame(&mut BufReader::new(peer2))["data"]["entry_type"],
        "run.spawned"
    );
    assert_eq!(hub.watcher_count(2), 1);
}

#[test]
fn run_start_watch_rolls_back_after_journal_creation_failure() {
    let directory = tempdir().unwrap();
    // Registry creation succeeds, but creating the per-run journal cannot.
    std::fs::write(directory.path().join("runs"), "not a directory").unwrap();
    let hub = Arc::new(ProtocolHub::default());
    let (writer, _peer) = shared_writer();
    let response = request(
        directory.path(),
        &hub,
        1,
        &writer,
        &json!({"id":"bad","verb":"run.start","params":{"watch":true,"spec":{"steps":[]}}})
            .to_string(),
    );
    assert!(!response.ok);
    assert_eq!(hub.watcher_count(1), 0);
}

#[test]
fn run_start_watch_streams_while_the_step_is_still_blocked() {
    let directory = tempdir().unwrap();
    let release = directory.path().join("release-step");
    let command = format!(
        "while [ ! -f '{}' ]; do sleep 0.01; done",
        release.display()
    );
    let hub = Arc::new(ProtocolHub::default());
    let (writer, peer) = shared_writer();
    let path = directory.path().to_owned();
    let (tx, rx) = mpsc::channel();
    let worker = thread::spawn(move || {
        let response = request(
            &path,
            &hub,
            1,
            &writer,
            &json!({"id":"live","verb":"run.start","params":{"watch":true,"spec":{"steps":[
                {"id":"blocked","type":"deterministic","command":["/bin/sh","-c",command]}
            ]}}})
            .to_string(),
        );
        tx.send(response).unwrap();
    });
    peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut reader = BufReader::new(peer);
    let first = read_frame(&mut reader);
    assert_eq!(first["data"]["entry_type"], "run.spawned");
    assert!(
        rx.try_recv().is_err(),
        "run completed before its step was released"
    );
    std::fs::write(&release, "go").unwrap();
    let mut last = 1;
    loop {
        let frame = read_frame(&mut reader);
        let seq = frame["data"]["seq"].as_i64().unwrap();
        assert!(seq > last);
        last = seq;
        if frame["data"]["entry_type"] == "run.completed" {
            break;
        }
    }
    assert!(rx.recv_timeout(Duration::from_secs(5)).unwrap().ok);
    worker.join().unwrap();
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
