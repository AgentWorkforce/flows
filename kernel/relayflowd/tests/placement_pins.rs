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
