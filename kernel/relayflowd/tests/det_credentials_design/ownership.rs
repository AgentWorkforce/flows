//! Authenticated ownership of every lineage mutation (proposal §4.3.5, J2).
//! Today `run.start` (also when admission returns an EXISTING run) and
//! `run.resume` replace a run's env before dispatch (server.rs:185-189,
//! 303-305). For an entitled lineage that is a design counterexample: an
//! unauthenticated resume could swap a linked child's PATH. Not a
//! demonstrated exploit. FUTURE contract; ignored until implemented.

use std::fs;

use serde_json::{Value, json};

use super::{contract::*, harness::*};

fn gated_child(fixture: &Fixture, lease: &Value, env: &Value) -> Value {
    let gate = fixture.scratch.join("gate");
    let started = fixture.scratch.join("gate.started");
    let wait = format!(
        "touch '{}'; while [ ! -f '{}' ]; do sleep 0.02; done",
        started.display(),
        gate.display()
    );
    let mut params = child(lease, "run-1", env);
    params["spec"] = spec(vec![
        det("gate", &wait, &[]),
        after(probe("after", &[BOUND]), "gate"),
        after(det("path", r#"printf '%s' "$PATH""#, &[]), "after"),
    ]);
    params
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials interface absent"]
fn only_the_lineage_owner_may_resume_restart_or_rebind_a_linked_child() {
    let fixture = Fixture::new();
    let root = spec(vec![agent_step("body")]);
    let mut daemon = Daemon::start(&fixture, Some(&cloud_binding(&root)), &[]);
    let mut journal = fixture.connect();
    let session = authenticate_journal(&mut journal, ROOT_SECRET);
    let mut peer = attach_agent_worker(
        &fixture,
        "authored-root-body",
        Some((ROOT_SECRET, session.as_str())),
    );
    let env = conforming_cli_env(&mut journal);
    run_root(&mut journal, &root, env.clone()).unwrap();
    let lease = peer.event("step.dispatch");
    let params = gated_child(&fixture, &lease, &env);
    let key = params["admission_key"].as_str().unwrap().to_owned();
    let blocked = std::thread::spawn(move || journal.request("run.start", params));
    wait_for("the child's gate step", || {
        fixture.scratch.join("gate.started").exists()
    });
    let child_run = json!(admitted_run_id(&fixture.data_dir, &key));

    let mut evil_env = env.clone();
    evil_env["PATH"] = json!("/evil");
    // Unauthenticated resume, and unauthenticated duplicate start: refused.
    let mut intruder = fixture.connect();
    let resume = json!({"run_id": child_run, "env": evil_env});
    assert_eq!(
        intruder.refusal("run.resume", resume.clone()),
        "root_not_authenticated"
    );
    let mut duplicate = gated_child(&fixture, &lease, &evil_env);
    assert_eq!(
        intruder.refusal("run.start", duplicate.clone()),
        "root_not_authenticated"
    );
    // Authenticated, but a foreign journal session: refused too.
    let mut foreign = fixture.connect();
    authenticate_journal(&mut foreign, ROOT_SECRET);
    assert_eq!(foreign.refusal("run.resume", resume), "lineage_not_owned");
    duplicate["env"] = evil_env;
    assert_eq!(foreign.refusal("run.start", duplicate), "lineage_not_owned");

    // Restore: no pre-restart session or lease survives; the owner is the
    // journal session that proves under the NEW K, and linkage (not a live
    // lease) authorizes resuming the already-linked child.
    daemon.kill();
    assert!(blocked.join().unwrap().is_err());
    let archive = fixture.scratch.join("archive");
    copy_tree(&fixture.data_dir, &archive);
    fs::remove_dir_all(&fixture.data_dir).unwrap();
    copy_tree(&archive, &fixture.data_dir);
    fs::write(fixture.scratch.join("gate"), b"").unwrap();
    let restored = Binding {
        secret: Some(ROOT_SECRET_AFTER_RESTART),
        ..cloud_binding(&root)
    };
    let _restored = Daemon::start(&fixture, Some(&restored), &[]);
    let mut owner = fixture.connect();
    authenticate_journal(&mut owner, ROOT_SECRET_AFTER_RESTART);
    let resumed = owner
        .request("run.resume", json!({"run_id": child_run, "env": env}))
        .unwrap();
    assert_eq!(resumed["status"], "completed", "{resumed}");
    assert_eq!(
        stdout_of(&mut owner, &child_run, "after"),
        fingerprint(BOUND_VALUE)
    );
    assert_ne!(stdout_of(&mut owner, &child_run, "path"), "/evil");
}
