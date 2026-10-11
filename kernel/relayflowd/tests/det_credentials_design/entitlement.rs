//! Entitlement: which det steps of which runs receive a bound credential
//! (proposal §4.2-§4.4). FUTURE contract; ignored until implemented.

use serde_json::{Value, json};

use super::{contract::*, harness::*};

fn cloud_daemon(fixture: &Fixture, root: &Value) -> Daemon {
    Daemon::start(fixture, Some(&cloud_binding(root)), &[])
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials interface absent"]
fn owned_root_det_step_receives_declared_credential_by_name() {
    let fixture = Fixture::new();
    let root = spec(vec![
        probe("declared", &[BOUND]),
        after(probe("undeclared", &[]), "declared"),
    ]);
    let _daemon = cloud_daemon(&fixture, &root);
    let mut cli = fixture.connect();
    let env = conforming_cli_env(&mut cli);
    let run = start_root(&mut cli, &root, ROOT_SECRET, env).unwrap();
    assert_eq!(run["status"], "completed", "{run}");
    assert_eq!(
        stdout_of(&mut cli, &run["run_id"], "declared"),
        fingerprint(BOUND_VALUE)
    );
    // Declaration narrows: an undeclared step of the same owned run gets nothing.
    assert_eq!(stdout_of(&mut cli, &run["run_id"], "undeclared"), "unset");
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials interface absent"]
fn another_run_on_the_same_daemon_does_not_receive_it() {
    let fixture = Fixture::new();
    let root = spec(vec![probe("p", &[BOUND])]);
    // A misconfigured host that ALSO exports the value in the daemon env: the
    // bound name is still stripped from every base env (proposal §4.4 step 2).
    let _daemon = Daemon::start(
        &fixture,
        Some(&cloud_binding(&root)),
        &[(BOUND, BOUND_VALUE)],
    );
    let mut owner = fixture.connect();
    let env = conforming_cli_env(&mut owner);
    let run = start_root(&mut owner, &root, ROOT_SECRET, env.clone()).unwrap();
    assert_eq!(
        stdout_of(&mut owner, &run["run_id"], "p"),
        fingerprint(BOUND_VALUE)
    );

    // A second run, e.g. one an agent starts over the socket, is not entitled.
    let mut other = fixture.connect();
    for key in [Some("authored-root:someone-else"), None] {
        let params = json!({"spec": spec(vec![probe("p", &[BOUND])]), "env": env,
                            "admission_key": key});
        assert_eq!(other.refusal("run.start", params), "credential_unavailable");
    }
    // Undeclared, with its own GH_TOKEN in env: the bound name is reserved.
    let mut impostor = env.clone();
    impostor[BOUND] = json!("caller-supplied-impostor-value");
    let spoof = start(&mut other, vec![probe("p", &[])], None, Some(impostor)).unwrap();
    assert_eq!(stdout_of(&mut other, &spoof["run_id"], "p"), "unset");
    // A legacy client sends no env and inherits the daemon env -- which here
    // holds the value too -- yet still never sees it.
    let legacy = start(&mut other, vec![probe("p", &[])], None, None).unwrap();
    assert_eq!(stdout_of(&mut other, &legacy["run_id"], "p"), "unset");
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials interface absent"]
fn spoofed_scope_cannot_widen_access() {
    let fixture = Fixture::new();
    let root = spec(vec![probe("p", &[BOUND])]);
    let _daemon = cloud_daemon(&fixture, &root);
    let mut caller = fixture.connect();
    let env = conforming_cli_env(&mut caller);
    for (field, value) in [
        ("credentials", json!([BOUND])),
        ("credential_root", json!(ROOT_KEY)),
        ("det_credentials", json!({BOUND: "x"})),
    ] {
        let mut params = json!({"spec": spec(vec![probe("p", &[BOUND])]), "env": env});
        params[field] = value;
        assert_eq!(
            caller.refusal("run.start", params),
            "bad_request",
            "{field}"
        );
    }
    // `credentials` exists only on deterministic steps.
    for step in [
        json!({"id": "a", "type": "agent", "instruction": "x", "credentials": [BOUND]}),
        json!({"id": "l", "type": "llm", "prompt": "x", "credentials": [BOUND]}),
    ] {
        let params = json!({"spec": spec(vec![step]), "env": env});
        assert_eq!(caller.refusal("run.start", params), "invalid_spec");
    }
    // Withheld names, and unbound names absent from the run env, cannot be declared.
    for name in [AGENT_ONLY[0].0, "NPM_TOKEN"] {
        let params = json!({"spec": spec(vec![probe("p", &[name])]), "env": env});
        assert_eq!(
            caller.refusal("run.start", params),
            "credential_unavailable",
            "{name}"
        );
    }
    // The owned root: a caller-supplied value never shadows the bound one.
    let mut impostor = env.clone();
    impostor[BOUND] = json!("caller-supplied-impostor-value");
    let run = start_root(&mut caller, &root, ROOT_SECRET, impostor).unwrap();
    assert_eq!(
        stdout_of(&mut caller, &run["run_id"], "p"),
        fingerprint(BOUND_VALUE)
    );
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials interface absent"]
fn authored_child_is_linked_only_to_the_exact_live_lease_of_its_session() {
    let fixture = Fixture::new();
    let root = spec(vec![agent_step("body")]);
    let _daemon = cloud_daemon(&fixture, &root);
    // The legitimate SDK: an authenticated worker peer and an authenticated
    // journal connection of the same session (§4.3.2).
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

    // A stale attempt, a wrong child key, another journal session and an
    // unauthenticated journal are all refused; none links a child.
    let mut stale = child(&lease, "run-1", &env);
    stale["parent"]["attempt"] = json!(lease["attempt"].as_u64().unwrap() + 1);
    assert_eq!(journal.refusal("run.start", stale), "parent_not_held");
    let mut wrong_key = child(&lease, "run-1", &env);
    wrong_key["admission_key"] = json!("authored-child:not-derived-from-the-root");
    assert_eq!(journal.refusal("run.start", wrong_key), "parent_not_held");
    let mut other_journal = fixture.connect();
    authenticate_journal(&mut other_journal, ROOT_SECRET);
    assert_eq!(
        other_journal.refusal("run.start", child(&lease, "run-1", &env)),
        "parent_not_held"
    );
    let mut intruder = fixture.connect();
    assert_eq!(
        intruder.refusal("run.start", child(&lease, "run-1", &env)),
        "root_not_authenticated"
    );

    let admitted = journal
        .request("run.start", child(&lease, "run-1", &env))
        .unwrap();
    assert_eq!(admitted["status"], "completed", "{admitted}");
    assert_eq!(
        stdout_of(&mut journal, &admitted["run_id"], "p"),
        fingerprint(BOUND_VALUE)
    );
    let spawned = entries(&mut journal, &admitted["run_id"]);
    let spawned = spawned
        .iter()
        .find(|e| e["entry_type"] == "run.spawned")
        .unwrap();
    assert_eq!(spawned["payload"]["parent_run_id"], lease["run_id"]);
    assert_eq!(complete_agent(&mut peer, &lease)["status"], "completed");
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials interface absent"]
fn f1_per_run_env_isolation_still_holds_with_a_binding() {
    let fixture = Fixture::new();
    let root = spec(vec![probe("p", &[BOUND])]);
    let _daemon = Daemon::start(
        &fixture,
        Some(&cloud_binding(&root)),
        &[("DAEMON_ONLY", "from-host"), ("RUN_LABEL", "daemon")],
    );
    const LABEL: &str =
        r#"printf '%s|%s|%s' "${RUN_LABEL:-unset}" "${DAEMON_ONLY:-unset}" "${#SECRET}""#;
    let (secret_a, secret_b) = ("sa-7f3e9c1b", "sb-0d4a8e6f2c95");
    let mut first = fixture.connect();
    let mut second = fixture.connect();
    let run = |wire: &mut Wire, env: Option<Value>| {
        let run = start(wire, vec![det("p", LABEL, &[])], None, env).unwrap();
        stdout_of(wire, &run["run_id"], "p")
    };
    assert_eq!(
        run(
            &mut first,
            Some(json!({"RUN_LABEL": "a", "SECRET": secret_a}))
        ),
        format!("a|unset|{}", secret_a.len())
    );
    assert_eq!(
        run(
            &mut second,
            Some(json!({"RUN_LABEL": "b", "SECRET": secret_b}))
        ),
        format!("b|unset|{}", secret_b.len())
    );
    assert_eq!(run(&mut second, None), "daemon|from-host|0");
    for secret in [secret_a, secret_b] {
        assert_eq!(
            files_containing(&fixture.data_dir, secret),
            Vec::<String>::new()
        );
    }
}
