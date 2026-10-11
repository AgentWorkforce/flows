//! Root authority (proposal §4.3). A public admission key, being the first
//! writer of that key, being the first worker to attach, or receiving the
//! first dispatch is NOT authentication. Connections prove K by
//! challenge-response; the root is admitted only from an authenticated
//! journal connection, under the reserved key, with a normalized spec whose
//! digest equals the host's authority pin; root-lineage leases go only to
//! authenticated worker peers. FUTURE contract; ignored until implemented.

use std::time::Duration;

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

fn body_root() -> Value {
    spec(vec![agent_step("body")])
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials interface absent"]
fn intruder_before_root_cannot_claim_the_key_with_any_spec() {
    let fixture = Fixture::new();
    let root = spec(vec![probe("p", &[BOUND])]);
    let _daemon = Daemon::start(&fixture, Some(&cloud_binding(&root)), &[]);
    let mut intruder = fixture.connect();
    let env = conforming_cli_env(&mut intruder);
    let evil = spec(vec![det("p", r#"printf '%s' "$GH_TOKEN""#, &[BOUND])]);
    // A guessed K produces a proof that fails.
    let intruder_nonce = nonce(&mut intruder);
    let guessed = prove_params(JOURNAL, &proof(&"0".repeat(64), JOURNAL, &intruder_nonce));
    assert_eq!(intruder.refusal("auth.prove", guessed), "auth_failed");
    // The reserved key from an unauthenticated connection, with a different
    // spec or the pinned one: never admitted, so the key is not squatted.
    for candidate in [&evil, &root] {
        let params = json!({"spec": candidate, "admission_key": ROOT_KEY, "env": env});
        assert_eq!(
            intruder.refusal("run.start", params),
            "root_not_authenticated"
        );
    }
    assert!(
        !admission_exists(&fixture, ROOT_KEY),
        "an intruder admission took the root key"
    );
    // The legitimate root still gets exactly its binding.
    let mut cli = fixture.connect();
    let run = start_root(&mut cli, &root, ROOT_SECRET, env.clone()).unwrap();
    assert_eq!(
        stdout_of(&mut cli, &run["run_id"], "p"),
        fingerprint(BOUND_VALUE)
    );
    // An AUTHENTICATED journal connection still cannot pass another spec off
    // as the root: the kernel checks the authority pin, not only K.
    let mut trusted = fixture.connect();
    authenticate(&mut trusted, ROOT_SECRET, JOURNAL).unwrap();
    let swapped = json!({"spec": evil, "admission_key": "authored-root:swapped", "env": env});
    assert_eq!(
        trusted.refusal("run.start", swapped),
        "credential_unavailable"
    );
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials interface absent"]
fn the_authority_pin_needs_the_exact_resolved_graph_and_every_pinned_field() {
    let fixture = Fixture::new();
    let graph = resolved_graph();
    let input = json!({"pr": 7});
    // The host pins the root built from ITS static resolver's graph.
    let root = authored_root("probe", &graph, input.clone());
    let binding = Binding {
        display_fields: vec!["/name", "/steps/0/instruction/flowName"],
        ..cloud_binding(&root)
    };
    let _daemon = Daemon::start(&fixture, Some(&binding), &[]);
    let mut cli = fixture.connect();
    let env = conforming_cli_env(&mut cli);
    authenticate(&mut cli, ROOT_SECRET, JOURNAL).unwrap();

    let omitted = vec![graph[0].clone()];
    let mut extra = graph.clone();
    extra.push(("/state/lib/unreachable-but-in-manifest.ts", "d".repeat(64)));
    let mut duplicated = graph.clone();
    duplicated.push(graph[1].clone());
    let mut changed = graph.clone();
    changed[1].1 = "e".repeat(64);
    let mut extra_step = root.clone();
    extra_step["steps"]
        .as_array_mut()
        .unwrap()
        .push(probe("x", &[BOUND]));
    // Each variant -> refused, no credentials: graph completeness is exact
    // set equality with the resolver, not per-record plausibility.
    for (what, variant) in [
        (
            "an omitted non-root node",
            authored_root("probe", &omitted, input.clone()),
        ),
        (
            "an extra unreachable node",
            authored_root("probe", &extra, input.clone()),
        ),
        (
            "a duplicate record",
            authored_root("probe", &duplicated, input.clone()),
        ),
        (
            "a changed node tuple",
            authored_root("probe", &changed, input.clone()),
        ),
        (
            "a different input",
            authored_root("probe", &graph, json!({"pr": 8})),
        ),
        ("an extra step", extra_step),
    ] {
        let params = json!({"spec": variant, "admission_key": ROOT_KEY, "env": env});
        assert_eq!(
            cli.refusal("run.start", params),
            "root_not_authenticated",
            "{what}"
        );
    }
    // A display field (the user-chosen flow name) is not authority.
    let renamed = authored_root("renamed-for-display", &graph, input);
    let params = json!({"spec": renamed, "admission_key": ROOT_KEY, "env": env});
    assert_eq!(
        cli.request("run.start", params).unwrap()["status"],
        "parked"
    );
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials interface absent"]
fn intruder_first_worker_never_holds_the_root_lease() {
    let fixture = Fixture::new();
    let root = body_root();
    let _daemon = Daemon::start(&fixture, Some(&cloud_binding(&root)), &[]);
    // BEFORE the legitimate SDK: an unauthenticated worker, and an
    // authenticated peer paired with a DIFFERENT journal session.
    let mut intruder = attach_agent_worker(&fixture, "intruder", None);
    let mut other_journal = fixture.connect();
    let other_session = authenticate_journal(&mut other_journal, ROOT_SECRET);
    let mut unpaired = attach_agent_worker(
        &fixture,
        "unpaired-peer",
        Some((ROOT_SECRET, other_session.as_str())),
    );
    let mut journal = fixture.connect();
    let session = authenticate_journal(&mut journal, ROOT_SECRET);
    let mut peer = attach_agent_worker(
        &fixture,
        "authored-root-body",
        Some((ROOT_SECRET, session.as_str())),
    );
    let env = conforming_cli_env(&mut journal);
    let started = run_root(&mut journal, &root, env.clone()).unwrap();
    assert_eq!(started["status"], "parked", "{started}");
    let lease = peer.event("step.dispatch");
    for (worker, who) in [
        (&mut intruder, "an unauthenticated worker"),
        (&mut unpaired, "a peer of another journal session"),
    ] {
        assert_eq!(
            worker.try_event("step.dispatch", Duration::from_millis(500)),
            None,
            "a root-lineage lease went to {who}"
        );
    }
    // A child started on the other journal session is not linked.
    assert_eq!(
        other_journal.refusal("run.start", child(&lease, "run-1", &env)),
        "parent_not_held"
    );
    let admitted = journal
        .request("run.start", child(&lease, "run-1", &env))
        .unwrap();
    assert_eq!(
        stdout_of(&mut journal, &admitted["run_id"], "p"),
        fingerprint(BOUND_VALUE)
    );
    assert_eq!(complete_agent(&mut peer, &lease)["status"], "completed");
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials interface absent"]
fn redelivery_after_losing_the_authenticated_peer_fails_closed() {
    let fixture = Fixture::new();
    let root = body_root();
    let _daemon = Daemon::start(&fixture, Some(&cloud_binding(&root)), &[]);
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
    drop(peer); // e.g. an agent killed the SDK's worker connection

    let mut intruder = attach_agent_worker(&fixture, "intruder", None);
    assert_eq!(
        intruder.try_event("step.dispatch", Duration::from_secs(2)),
        None,
        "the root body was redelivered to an unauthenticated worker"
    );
    // The authenticated journal connection survives, but the exact lease is
    // no longer held by an authenticated peer of its session.
    assert_eq!(
        journal.refusal("run.start", child(&lease, "run-1", &env)),
        "parent_not_held"
    );
    let state = journal
        .request("run.get", json!({"run_id": lease["run_id"]}))
        .unwrap();
    assert_ne!(state["status"], "completed", "{state}");
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials interface absent"]
fn a_daemon_without_a_complete_frame_refuses_every_binding() {
    let fixture = Fixture::new();
    let root = spec(vec![probe("p", &[BOUND])]);
    {
        // The interface is advertised by any daemon that implements it.
        let _plain = Daemon::start(&fixture, None, &[]);
        let hello = hello(&mut fixture.connect());
        assert!(
            hello["features"]
                .as_array()
                .unwrap()
                .contains(&json!("det_credentials")),
            "DESIGN FIXTURE: hello does not list det_credentials; the interface is absent: {hello}"
        );
    }
    // Fail closed, never fall back: no frame, or a frame missing the
    // authority pin or K, refuses EVERY binding (proposal §4.1).
    for (missing, binding) in [
        (
            "frame",
            Binding {
                send_frame: false,
                ..cloud_binding(&root)
            },
        ),
        (
            "root_authority_sha256",
            Binding {
                root_spec: None,
                ..cloud_binding(&root)
            },
        ),
        (
            "capability",
            Binding {
                secret: None,
                ..cloud_binding(&root)
            },
        ),
    ] {
        let refused = Daemon::try_start(&fixture, Some(&binding), &[])
            .err()
            .unwrap_or_else(|| panic!("a binding without {missing} was accepted"));
        assert!(!refused.status.success());
        assert!(
            refused.output.contains(missing),
            "{missing}: {}",
            refused.output
        );
        assert!(!refused.output.contains(BOUND_VALUE) && !refused.output.contains(ROOT_SECRET));
    }
}
