//! Restart and resume (proposal §4.6). A Cloud resume restores the archived
//! state dir (journal + registry + submitted source) into a fresh sandbox and
//! spawns a new daemon with a NEW K. The restored registry carries lineage,
//! never K: the old K is refused, the new K restores exactly the binding.
//! FUTURE contract; ignored until implemented.

use std::fs;

use serde_json::{Value, json};

use super::{contract::*, harness::*};

/// The pinned root of these tests: `before` and `after` declare the
/// credential, `gate` blocks until the test releases it.
fn gated_root(fixture: &Fixture) -> Value {
    let gate = fixture.scratch.join("gate");
    let started = fixture.scratch.join("gate.started");
    let wait = format!(
        "touch '{}'; while [ ! -f '{}' ]; do sleep 0.02; done",
        started.display(),
        gate.display()
    );
    spec(vec![
        probe("before", &[BOUND]),
        after(det("gate", &wait, &[]), "before"),
        after(probe("after", &[BOUND]), "gate"),
        after(probe("after_undeclared", &[]), "after"),
    ])
}

/// Start the authenticated root, SIGKILL the daemon while `gate` runs, then
/// archive and restore the data dir as Cloud would. Returns the root run id.
fn interrupted_and_restored(fixture: &Fixture, root: &Value) -> Value {
    let mut daemon = Daemon::start(fixture, Some(&cloud_binding(root)), &[]);
    let mut cli = fixture.connect();
    let env = conforming_cli_env(&mut cli);
    let pinned = root.clone();
    let blocked = std::thread::spawn(move || start_root(&mut cli, &pinned, ROOT_SECRET, env));
    wait_for("the gate step", || {
        fixture.scratch.join("gate.started").exists()
    });
    let run_id = json!(admitted_run_id(&fixture.data_dir, ROOT_KEY));
    let mut watcher = fixture.connect();
    assert_eq!(
        stdout_of(&mut watcher, &run_id, "before"),
        fingerprint(BOUND_VALUE)
    );
    daemon.kill();
    assert!(
        blocked.join().unwrap().is_err(),
        "the run finished before the kill"
    );

    let archive = fixture.scratch.join("archive");
    copy_tree(&fixture.data_dir, &archive);
    fs::remove_dir_all(&fixture.data_dir).unwrap();
    copy_tree(&archive, &fixture.data_dir);
    fs::write(fixture.scratch.join("gate"), b"").unwrap();
    run_id
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials interface absent"]
fn archive_restore_takes_a_new_k_and_keeps_exactly_the_binding() {
    let fixture = Fixture::new();
    let root = gated_root(&fixture);
    let run_id = interrupted_and_restored(&fixture, &root);
    let resumed_binding = Binding {
        secret: Some(ROOT_SECRET_AFTER_RESTART),
        ..cloud_binding(&root)
    };
    let _restored = Daemon::start(&fixture, Some(&resumed_binding), &[]);
    let mut resumer = fixture.connect();
    let mut env = conforming_cli_env(&mut resumer);
    env[BOUND] = json!("caller-supplied-impostor-value");

    // The old K is refused: the registry restored lineage, never a secret.
    let resumer_nonce = nonce(&mut resumer);
    let stale = prove_params(JOURNAL, &proof(ROOT_SECRET, JOURNAL, &resumer_nonce));
    assert_eq!(resumer.refusal("auth.prove", stale), "auth_failed");
    let unauthenticated = json!({"run_id": run_id, "env": env});
    assert_eq!(
        resumer.refusal("run.resume", unauthenticated),
        "root_not_authenticated"
    );
    // The new K authenticates; the restored lineage restores the binding.
    authenticate(&mut resumer, ROOT_SECRET_AFTER_RESTART, JOURNAL).unwrap();
    let resumed = resumer
        .request("run.resume", json!({"run_id": run_id, "env": env}))
        .unwrap();
    assert_eq!(resumed["status"], "completed", "{resumed}");
    assert_eq!(
        stdout_of(&mut resumer, &run_id, "after"),
        fingerprint(BOUND_VALUE)
    );
    assert_eq!(
        stdout_of(&mut resumer, &run_id, "after_undeclared"),
        "unset"
    );
    // Not more: the restored daemon entitles no other run.
    let other = json!({"spec": spec(vec![probe("p", &[BOUND])]), "env": env,
                       "admission_key": "authored-root:after-restore"});
    assert_eq!(
        resumer.refusal("run.start", other),
        "credential_unavailable"
    );
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials interface absent"]
fn restore_without_the_binding_fails_closed() {
    let fixture = Fixture::new();
    let root = gated_root(&fixture);
    let run_id = interrupted_and_restored(&fixture, &root);
    // The host respawns with no binding at all, and the value even sits in the
    // daemon env: nothing persisted may resurrect the credential.
    let _restored = Daemon::start(&fixture, None, &[(BOUND, BOUND_VALUE)]);
    let mut resumer = fixture.connect();
    let env = raw_cli_env();
    let _ = resumer.request("run.resume", json!({"run_id": run_id, "env": env}));
    let journal = entries(&mut resumer, &run_id);
    let after: Vec<_> = journal.iter().filter(|e| e["step_id"] == "after").collect();
    assert!(
        after.iter().any(|e| e["payload"]
            .to_string()
            .contains("credential_unavailable: GH_TOKEN")),
        "the declared step did not fail closed: {after:?}"
    );
    assert!(
        !after
            .iter()
            .any(|e| e["payload"].to_string().contains(&fingerprint(BOUND_VALUE))),
        "the declared step ran with the credential after an unbound restore"
    );
}
