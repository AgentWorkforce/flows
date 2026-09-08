use relayflowd::{
    Engine,
    worker::{DispatchOutcome, StepDispatch, StepDispatcher},
};
use relayflowd_core::{RunSpec, StepType};
use serde_json::json;
use std::{path::Path, process::Command};
use tempfile::tempdir;

struct LocalWorker;
impl StepDispatcher for LocalWorker {
    fn executor(&self, _: StepType) -> Option<String> {
        Some("local-worker".into())
    }
    fn available(&self, _: StepType) -> bool {
        true
    }
    fn dispatch(&self, _: StepDispatch) -> anyhow::Result<DispatchOutcome> {
        unreachable!()
    }
}

fn git(tree: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(tree)
        .output()
        .unwrap();
    assert!(output.status.success(), "git failed: {output:?}");
    String::from_utf8(output.stdout).unwrap().trim().into()
}

#[test]
fn default_worker_pins_the_declared_worktree_base_commit_and_refuses_missing_source() {
    let tree = tempdir().unwrap();
    git(tree.path(), &["init", "-q"]);
    git(
        tree.path(),
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-qm",
            "base",
        ],
    );
    let revision = git(tree.path(), &["rev-parse", "HEAD"]);
    let surface = tree
        .path()
        .canonicalize()
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    let spec = RunSpec::parse(
        &json!({"steps":[{"id":"edit","type":"agent","instruction":"edit",
        "surfaces":{"workspace":[{"surface":surface}]}}]}),
    )
    .unwrap();
    let pins = LocalWorker.starting_pins(&spec.steps[0]).unwrap();
    assert_eq!(pins.workspace.len(), 1);
    assert_eq!(pins.workspace[0].surface, surface);
    assert_eq!(pins.workspace[0].revision_id, revision);
    std::fs::remove_dir_all(tree.path().join(".git")).unwrap();
    assert!(LocalWorker.starting_pins(&spec.steps[0]).is_err());
}

#[test]
fn unsupported_local_pty_is_refused_before_an_earlier_step_can_run() {
    let directory = tempdir().unwrap();
    let marker = directory.path().join("must-not-exist");
    let spec = RunSpec::parse(&json!({"steps":[
        {"id":"first","type":"deterministic","command": ["touch", marker]},
        {"id":"pty","type":"deterministic","depends_on":["first"],"command":"true",
         "requirements":{"execution":"interactive"}}
    ]}))
    .unwrap();
    let engine = Engine::new(directory.path().join("data"));
    let error = engine.start(spec, "test", None).unwrap_err();
    assert!(format!("{error:#}").contains("supports batch only"));
    assert!(!marker.exists());
    assert!(!directory.path().join("data/runs").exists());
}

/// A worker that records every time the engine asks it to resolve starting
/// pins. `Dispatched` hands the lease off and parks the run, which is what
/// lets a second Engine (new boot id) replace the attempt on resume.
#[derive(Default)]
struct RecordingWorker {
    pin_requests: std::sync::atomic::AtomicUsize,
}

impl StepDispatcher for RecordingWorker {
    fn executor(&self, _: StepType) -> Option<String> {
        Some("recording-worker".into())
    }
    fn available(&self, _: StepType) -> bool {
        true
    }
    fn reserved_starting_pins(
        &self,
        _run_id: &str,
        step: &relayflowd_core::StepSpec,
        _attempt: u32,
    ) -> anyhow::Result<relayflowd_core::Pins> {
        self.pin_requests
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.starting_pins(step)
    }
    fn dispatch(&self, _: StepDispatch) -> anyhow::Result<DispatchOutcome> {
        Ok(DispatchOutcome::Dispatched)
    }
}

struct SilentObserver;
impl relayflowd::worker::JournalObserver for SilentObserver {
    fn appended(&self, _entry: &relayflowd_core::JournalEntry) {}
}

fn started_pin_revisions(engine: &Engine, run_id: &str) -> Vec<String> {
    engine
        .journal_entries(run_id, 0, 1024)
        .unwrap()
        .into_iter()
        .filter(|entry| entry.entry_type == relayflowd_core::EntryType::StepAttemptStarted)
        .map(|entry| {
            let payload: relayflowd_core::AttemptStartedPayload =
                serde_json::from_value(entry.payload).unwrap();
            payload.pins.workspace[0].revision_id.clone()
        })
        .collect()
}

/// A resumed attempt must reuse the revision the run was already pinned to,
/// even when the worktree HEAD has moved underneath it. The carried pin is
/// what the step was elected against; re-reading HEAD would silently hand the
/// retry a different starting state for the same durable route.
#[test]
fn a_resumed_attempt_keeps_the_original_pin_after_the_worktree_head_moves() {
    let tree = tempdir().unwrap();
    let data = tempdir().unwrap();
    let commit = |message: &str| {
        git(
            tree.path(),
            &[
                "-c", "user.name=Test", "-c", "user.email=test@example.com",
                "commit", "--allow-empty", "-qm", message,
            ],
        )
    };
    git(tree.path(), &["init", "-q"]);
    commit("base");
    let elected = git(tree.path(), &["rev-parse", "HEAD"]);
    let surface = tree.path().canonicalize().unwrap().to_str().unwrap().to_owned();
    let spec = RunSpec::parse(
        &json!({"steps":[{"id":"edit","type":"agent","instruction":"edit",
        "surfaces":{"workspace":[{"surface":surface}]}}]}),
    )
    .unwrap();

    let worker = std::sync::Arc::new(RecordingWorker::default());
    let engine = Engine::with_runtime(
        data.path(),
        worker.clone(),
        std::sync::Arc::new(SilentObserver),
    );
    let run_id = engine.start(spec, "test", None).unwrap().run_id;
    assert_eq!(started_pin_revisions(&engine, &run_id), vec![elected.clone()]);
    let asked_once = worker.pin_requests.load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(asked_once, 1, "the first attempt has nothing to carry");

    // HEAD moves under the parked run, exactly as an operator committing in
    // their worktree would move it.
    commit("moved");
    let moved = git(tree.path(), &["rev-parse", "HEAD"]);
    assert_ne!(moved, elected);

    // A fresh Engine means a fresh boot id, so the leased attempt reads as
    // dead and the step is retried.
    let resumed = Engine::with_runtime(
        data.path(),
        worker.clone(),
        std::sync::Arc::new(SilentObserver),
    );
    resumed.resume(&run_id, None).unwrap();

    let revisions = started_pin_revisions(&resumed, &run_id);
    assert!(revisions.len() >= 2, "expected a second attempt, got {revisions:?}");
    assert!(
        revisions.iter().all(|revision| revision == &elected),
        "a retry re-read HEAD instead of carrying the elected pin: {revisions:?} (moved to {moved})",
    );
    assert_eq!(
        worker.pin_requests.load(std::sync::atomic::Ordering::SeqCst),
        asked_once,
        "a covered surface must not be resolved again",
    );
}
