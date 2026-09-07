use std::{
    fs,
    os::unix::process::CommandExt,
    process::{Command, Stdio},
};

use relayflowd::{RunOutcome, RunStatus};
use relayflowd_core::EntryType;
use serde_json::json;
use tempfile::tempdir;

use super::support::{
    journal_entries, kill_group, kill_process_group, only_run_id, read_pid, wait_until,
};

#[test]
fn declared_placement_keeps_one_source_tree_across_resume() {
    shared_tree("between");
}

#[test]
fn sigkill_mid_step_keeps_the_route_and_source_tree() {
    shared_tree("during");
}

#[test]
fn sigkill_before_first_step_preserves_the_submitted_workspace() {
    shared_tree("before");
}

fn shared_tree(boundary: &str) {
    let crash = boundary == "during";
    let directory = tempdir().unwrap();
    let tree = directory.path().join("source");
    let elsewhere = directory.path().join("elsewhere");
    let data = directory.path().join("data");
    fs::create_dir(&tree).unwrap();
    fs::create_dir(&elsewhere).unwrap();
    fs::write(tree.join("source.txt"), "source-present\n").unwrap();
    for args in [
        vec!["init", "-q"],
        vec!["add", "source.txt"],
        vec![
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-qm",
            "source",
        ],
    ] {
        assert!(
            Command::new("git")
                .args(args)
                .current_dir(&tree)
                .status()
                .unwrap()
                .success()
        );
    }
    let revision = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&tree)
        .output()
        .unwrap();
    let revision = String::from_utf8(revision.stdout)
        .unwrap()
        .trim()
        .to_owned();
    let spec = directory.path().join("flow.json");
    let read_command = if crash {
        "echo $$ > step.pid; touch started; while [ ! -f continue ]; do sleep 0.02; done; cat shared.txt"
    } else {
        "cat shared.txt"
    };
    fs::write(&spec, json!({"steps":[
        {"id":"write","type":"deterministic","requirements":{"workspace":true,"execution":"batch"},
         "command":"cat source.txt > shared.txt"},
        {"id":"read","type":"deterministic","depends_on":["write"],
         "requirements":{"workspace":true,"execution":"batch"},
         "command":read_command,"verification":{"output_contains":"source-present"}}
    ]}).to_string()).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_relayflowd"));
    command
        .arg("--data-dir")
        .arg(&data)
        .arg("run")
        .arg(&spec)
        .current_dir(&tree);
    if boundary == "before" {
        let mut child = command
            .args(["--pause-before-step", "write"])
            .stdout(Stdio::null())
            .process_group(0)
            .spawn()
            .unwrap();
        wait_until("submitted workspace binding", || {
            journal_entries(&data).is_some_and(|entries| {
                entries
                    .iter()
                    .filter(|e| e.entry_type.as_str() == "step.routed")
                    .count()
                    == 2
            })
        });
        kill_process_group(&mut child);
    } else if crash {
        let mut child = command
            .stdout(Stdio::null())
            .process_group(0)
            .spawn()
            .unwrap();
        wait_until("placed command starts", || tree.join("started").exists());
        kill_process_group(&mut child);
        kill_group(read_pid(&tree.join("step.pid")));
        fs::write(tree.join("continue"), "").unwrap();
    } else {
        let first = command.args(["--stop-after", "1"]).output().unwrap();
        assert!(
            first.status.success(),
            "run failed: {}",
            String::from_utf8_lossy(&first.stderr)
        );
    }
    let run = only_run_id(&data);
    let resumed = Command::new(env!("CARGO_BIN_EXE_relayflowd"))
        .arg("--data-dir")
        .arg(&data)
        .args(["resume", &run])
        .current_dir(&elsewhere)
        .output()
        .unwrap();
    assert!(resumed.status.success(), "resume failed: {resumed:?}");
    let outcome: RunOutcome = serde_json::from_slice(&resumed.stdout).unwrap();
    assert_eq!(outcome.status, RunStatus::Completed);
    assert_eq!(
        fs::read_to_string(tree.join("shared.txt")).unwrap(),
        "source-present\n"
    );
    assert!(!elsewhere.join("shared.txt").exists());
    let entries = journal_entries(&data).unwrap();
    assert_eq!(
        entries
            .iter()
            .filter(|e| e.entry_type == EntryType::StepAttemptStarted)
            .count(),
        if crash { 3 } else { 2 }
    );
    if crash {
        assert!(
            entries
                .iter()
                .any(|e| e.entry_type == EntryType::StepCompleted
                    && e.payload["completionReason"] == "crashed")
        );
    }
    let routes: Vec<_> = entries
        .iter()
        .filter(|e| e.entry_type.as_str() == "step.routed")
        .collect();
    assert_eq!(routes.len(), 2, "each routing decision must be durable");
    for route in routes {
        assert_eq!(route.payload["profile"], "batch");
        assert_eq!(route.payload["provider"], "local");
        assert_eq!(route.payload["fallbacks_attempted"], json!([]));
    }
    for start in entries
        .iter()
        .filter(|e| e.entry_type == EntryType::StepAttemptStarted)
    {
        assert_eq!(
            start.payload["pins"]["workspace"][0]["revision_id"],
            revision
        );
        assert_eq!(
            start.payload["pins"]["workspace"][0]["surface"],
            fs::canonicalize(&tree).unwrap().to_str().unwrap()
        );
    }
    let replay = Command::new(env!("CARGO_BIN_EXE_relayflowd"))
        .arg("--data-dir")
        .arg(&data)
        .args(["resume", &run])
        .current_dir(&elsewhere)
        .output()
        .unwrap();
    assert!(replay.status.success());
    assert_eq!(
        entries,
        journal_entries(&data).unwrap(),
        "completed replay must not decide again"
    );
}
