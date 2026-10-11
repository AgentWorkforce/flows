//! The real authored-child session (proposal §4.3.6, C1; Native's interface,
//! cloud design/hosted-step-env-boundary @ d88b166b §3, with amendment A1).
//! Under Bun the CLI keeps journal J and root peer P's lease in the PARENT
//! (packages/sdk/src/authored-root.ts:109-119, 327-340) and runs the body in a
//! Node child (authored-node-runner.ts:87-90) that opens a NEW JournalClient
//! (authored-node-entry.ts:78-79). The owner mints a delegation of the exact
//! current attempt, bound to the child's pid and start time; the child gets
//! D (never K) in its stdin request and binds one session with it.
//! FUTURE contract; ignored until implemented. The "child" here is a second
//! connection of the test process, so pid binding uses this process's pid.

use serde_json::{Value, json};

use super::{contract::*, harness::*};

fn admission_exists(fixture: &Fixture, key: &str) -> bool {
    rusqlite::Connection::open(fixture.data_dir.join("relayflowd.sqlite3"))
        .and_then(|registry| {
            registry.query_row(
                "SELECT COUNT(*) FROM run_admissions WHERE admission_key = ?1",
                [key],
                |row| row.get::<_, i64>(0),
            )
        })
        .is_ok_and(|count| count > 0)
}

/// The Bun parent: journal J, paired peer P, root started, lease in hand.
fn bun_parent(fixture: &Fixture, root: &Value) -> (Wire, Wire, Value, Value) {
    let mut journal = fixture.connect();
    let session = authenticate_journal(&mut journal, ROOT_SECRET);
    let mut peer = attach_agent_worker(
        fixture,
        "authored-root-body",
        Some((ROOT_SECRET, session.as_str())),
    );
    let env = conforming_cli_env(&mut journal);
    run_root(&mut journal, root, env.clone()).unwrap();
    let lease = peer.event("step.dispatch");
    (journal, peer, lease, env)
}

/// The Node child's session: bind with D derived from the parent's K.
fn node_child(fixture: &Fixture, delegation: &str) -> Wire {
    let mut child = fixture.connect();
    let d = delegation_secret(ROOT_SECRET, delegation);
    bind_delegate(&mut child, &d, delegation).unwrap();
    child
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials interface absent"]
fn a_delegated_authored_child_admits_declaring_work_and_resumes_its_linked_child() {
    let fixture = Fixture::new();
    let root = spec(vec![agent_step("body")]);
    let _daemon = Daemon::start(&fixture, Some(&cloud_binding(&root)), &[]);
    let (mut journal, mut peer, lease, env) = bun_parent(&fixture, &root);
    let delegation = delegate(&mut journal, &lease, self_identity()).unwrap();
    let mut child = node_child(&fixture, &delegation);
    let admitted = child
        .request("run.start", child_start(&lease, "run-1", &env))
        .unwrap();
    assert_eq!(admitted["status"], "completed", "{admitted}");
    assert_eq!(
        stdout_of(&mut child, &admitted["run_id"], "p"),
        fingerprint(BOUND_VALUE)
    );
    let resumed = child
        .request(
            "run.resume",
            json!({"run_id": admitted["run_id"], "env": env}),
        )
        .unwrap();
    assert_eq!(resumed["status"], "completed", "{resumed}");
    assert_eq!(complete_agent(&mut peer, &lease)["status"], "completed");
}

fn child_start(lease: &Value, id: &str, env: &Value) -> Value {
    super::contract::child(lease, id, env)
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials interface absent"]
fn undelegated_mismatched_replayed_and_stale_sessions_are_refused_before_any_mutation() {
    let fixture = Fixture::new();
    let root = spec(vec![agent_step("body")]);
    let _daemon = Daemon::start(&fixture, Some(&cloud_binding(&root)), &[]);
    let (mut journal, peer, lease, env) = bun_parent(&fixture, &root);
    let attempt = child_start(&lease, "run-2", &env);
    let key = attempt["admission_key"].as_str().unwrap().to_owned();
    let me = self_identity();

    // Independently K-authenticated but UNDELEGATED: no first-prover trust.
    let mut stranger = fixture.connect();
    authenticate_journal(&mut stranger, ROOT_SECRET);
    assert_eq!(
        stranger.refusal("run.start", attempt.clone()),
        "lineage_not_owned"
    );
    assert!(
        delegate(&mut stranger, &lease, me).is_err(),
        "a non-owner minted"
    );
    // Wrong parent, step or attempt: no delegation.
    for (field, value) in [
        ("run_id", json!("01NOTTHEROOTRUN000000000000")),
        ("step_id", json!("not-authored-root")),
        ("attempt", json!(lease["attempt"].as_u64().unwrap() + 1)),
    ] {
        let mut wrong = lease.clone();
        wrong[field] = value;
        assert!(delegate(&mut journal, &wrong, me).is_err(), "{field}");
    }
    // Wrong pid: D is useless from another process (SO_PEERCRED).
    let elsewhere = delegate(&mut journal, &lease, (me.0 + 1_000_000, me.1)).unwrap();
    let d = delegation_secret(ROOT_SECRET, &elsewhere);
    assert!(bind_delegate(&mut fixture.connect(), &d, &elsewhere).is_err());
    // Bound once; a replay of D on another session is refused.
    let delegation = delegate(&mut journal, &lease, me).unwrap();
    let mut child = node_child(&fixture, &delegation);
    let d = delegation_secret(ROOT_SECRET, &delegation);
    let mut replay = fixture.connect();
    let replayed = bind_delegate(&mut replay, &d, &delegation).unwrap_err();
    assert!(
        replayed.to_string().contains("delegation_used"),
        "{replayed}"
    );
    // Narrow: no root takeover, no lease, no re-delegation.
    let root_resume = json!({"run_id": lease["run_id"], "env": env});
    assert_eq!(
        child.refusal("run.resume", root_resume),
        "lineage_not_owned"
    );
    let attach = json!({"worker_id": "child-steal", "step_types": ["agent"],
                        "pins": {"workspace": [], "streams": [{"stream": "agent-notes", "read_offset": 0}]}});
    assert_eq!(child.refusal("worker.attach", attach), "lineage_not_owned");
    assert!(
        delegate(&mut child, &lease, me).is_err(),
        "a delegate re-delegated"
    );

    // Stale: P loses the lease, so the delegation is revoked.
    drop(peer);
    assert_eq!(child.refusal("run.start", attempt), "delegation_invalid");
    assert!(
        !admission_exists(&fixture, &key),
        "a refused child start still wrote the registry"
    );
}
