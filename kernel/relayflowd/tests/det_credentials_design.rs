//! DESIGN FIXTURE: trusted credentials for deterministic steps.
//!
//! Encodes the required behaviour of docs/proposals/trusted-det-step-credentials.md
//! (feature `det_credentials`). Nothing here is implemented yet, so every test
//! is `#[ignore]`d with that reason and FAILS when forced with `--ignored` on a
//! kernel without the feature: `relayflowd serve` rejects the binding flags and
//! the harness reports exactly that. The implementing PR removes the
//! `#[ignore]` attributes and changes nothing else; these tests are its gate.
//!
//! What they pin (proposal section in brackets):
//! - an owned root's det step receives a declared credential by name [4.3, 4.4]
//! - det steps never receive agent-only keys; agent steps are still served [4.5]
//! - other runs, agent-started or legacy, do not receive it [4.3]
//! - spoofed scope in run.start, env, spec or `parent` cannot widen access [4.3, 4.4]
//! - an authored child inherits only via the root body's lease holder [4.3]
//! - restart keeps exactly the same binding; no binding fails closed [4.6]
//! - no value in journal, wire frames, daemon logs or checkpoints [4.4]
//! - F1 per-run env isolation still holds [4.4 step 1]

#[path = "det_credentials_design/harness.rs"]
mod harness;

use std::fs;

use harness::*;
use serde_json::{Value, json};

fn cloud_daemon(fixture: &Fixture) -> Daemon {
    Daemon::start(fixture, Some(&cloud_binding()), &[(BOUND, BOUND_VALUE)])
}

fn agent_step(id: &str) -> Value {
    json!({"id": id, "type": "agent", "instruction": "diagnose", "max_iterations": 1})
}

fn budgeted(steps: Vec<Value>) -> Value {
    json!({
        "name": "det-credentials-design",
        "steps": steps,
        "budget": {"max_tokens_in": 100, "max_tokens_out": 100, "max_dollars": "1"}
    })
}

fn attach_agent_worker(fixture: &Fixture, id: &str) -> Wire {
    let mut worker = fixture.connect();
    worker
        .request(
            "worker.attach",
            // An agent worker must report a surface pin (server.rs attach rule).
            json!({"worker_id": id, "step_types": ["agent"],
                   "pins": {"workspace": [], "streams": [{"stream": "agent-notes", "read_offset": 0}]}}),
        )
        .unwrap();
    worker
}

fn complete_agent(worker: &mut Wire, dispatch: &Value) -> Value {
    worker
        .request(
            "step.complete",
            json!({
                "run_id": dispatch["run_id"], "step_id": dispatch["step_id"],
                "attempt": dispatch["attempt"], "idempotency_key": dispatch["idempotency_key"],
                "completionReason": "success", "output": {"status": "ok"},
                "usage": {"tokens_in": 1, "tokens_out": 1, "dollars": "0.001"},
                "started_pins": dispatch["pins"], "end_pins": dispatch["pins"]
            }),
        )
        .unwrap()
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials not implemented"]
fn owned_root_det_step_receives_declared_credential_by_name() {
    let fixture = Fixture::new();
    let _daemon = cloud_daemon(&fixture);
    let mut cli = fixture.connect();
    let run = start(
        &mut cli,
        vec![
            probe("declared", &[BOUND]),
            after(probe("undeclared", &[]), "declared"),
        ],
        Some(ROOT_KEY),
        Some(cli_env()),
    )
    .unwrap();
    assert_eq!(run["status"], "completed", "{run}");
    assert_eq!(
        stdout_of(&mut cli, &run["run_id"], "declared"),
        fingerprint(BOUND_VALUE)
    );
    // Declaration narrows: an undeclared step of the same owned run gets nothing.
    assert_eq!(stdout_of(&mut cli, &run["run_id"], "undeclared"), "unset");
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials not implemented"]
fn det_steps_never_receive_agent_only_keys_while_agent_steps_are_served() {
    let fixture = Fixture::new();
    let _daemon = cloud_daemon(&fixture);
    let declared = fixture.scratch.join("declared.env");
    let undeclared = fixture.scratch.join("undeclared.env");
    let mut worker = attach_agent_worker(&fixture, "agent-worker");
    let mut cli = fixture.connect();
    let run = cli
        .request(
            "run.start",
            json!({
                "spec": budgeted(vec![
                    dump("declared", &declared, &[BOUND]),
                    after(dump("undeclared", &undeclared, &[]), "declared"),
                    after(agent_step("diagnose"), "undeclared"),
                ]),
                "admission_key": ROOT_KEY,
                "env": cli_env(),
            }),
        )
        .unwrap();
    assert_eq!(run["status"], "parked", "{run}");

    for path in [&declared, &undeclared] {
        let env = fs::read(path).unwrap();
        for (name, value) in AGENT_ONLY {
            let by_name = String::from_utf8_lossy(&env)
                .lines()
                .any(|line| line.starts_with(&format!("{name}=")));
            assert!(!by_name, "{name} reached a det step ({})", path.display());
            assert!(
                !contains(&env, value),
                "{name}'s value bytes reached a det step ({})",
                path.display()
            );
        }
        // Delivered and repository-grant variables keep their semantics.
        let text = String::from_utf8_lossy(&env);
        for (name, value) in REPOSITORY.iter().chain(std::iter::once(&DELIVERED)) {
            assert!(text.contains(&format!("{name}={value}")), "{name} lost");
        }
    }
    assert!(
        String::from_utf8_lossy(&fs::read(&declared).unwrap())
            .contains(&format!("{BOUND}={BOUND_VALUE}"))
    );
    assert!(
        !String::from_utf8_lossy(&fs::read(&undeclared).unwrap()).contains(&format!("{BOUND}="))
    );

    // The agent step is still dispatched and completed under the same binding.
    // Its provider keys live in the worker's own process env (the CLI), which
    // the kernel never touches; withholding applies to exec_det only.
    let dispatch = worker.event("step.dispatch");
    assert_eq!(dispatch["step_id"], "diagnose");
    assert!(!dispatch.to_string().contains(BOUND_VALUE), "{dispatch}");
    assert_eq!(
        complete_agent(&mut worker, &dispatch)["status"],
        "completed"
    );
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials not implemented"]
fn another_run_on_the_same_daemon_does_not_receive_it() {
    let fixture = Fixture::new();
    let _daemon = cloud_daemon(&fixture);
    let mut owner = fixture.connect();
    let root = start(
        &mut owner,
        vec![probe("p", &[BOUND])],
        Some(ROOT_KEY),
        Some(cli_env()),
    )
    .unwrap();
    assert_eq!(
        stdout_of(&mut owner, &root["run_id"], "p"),
        fingerprint(BOUND_VALUE)
    );

    // A second run, e.g. one an agent starts over the socket, is not entitled.
    let mut other = fixture.connect();
    for key in [Some("authored-root:someone-else"), None] {
        let refused = other.frame(
            "run.start",
            json!({"spec": {"steps": [probe("p", &[BOUND])]}, "env": cli_env(),
                   "admission_key": key}),
        );
        let frame = refused.unwrap();
        assert_eq!(frame["error"]["code"], "credential_unavailable", "{frame}");
    }
    // Undeclared, with its own GH_TOKEN in env: the bound name is reserved.
    let mut env = cli_env();
    env[BOUND] = json!("caller-supplied-impostor-value");
    let spoof = start(&mut other, vec![probe("p", &[])], None, Some(env)).unwrap();
    assert_eq!(stdout_of(&mut other, &spoof["run_id"], "p"), "unset");
    // A legacy client sends no env and inherits the daemon env -- which holds
    // the bound value by name -- yet still never sees it.
    let legacy = start(&mut other, vec![probe("p", &[])], None, None).unwrap();
    assert_eq!(stdout_of(&mut other, &legacy["run_id"], "p"), "unset");
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials not implemented"]
fn spoofed_scope_cannot_widen_access() {
    let fixture = Fixture::new();
    let _daemon = cloud_daemon(&fixture);
    let mut caller = fixture.connect();
    let spec = json!({"steps": [probe("p", &[BOUND])]});
    for (field, value) in [
        ("credentials", json!([BOUND])),
        ("credential_root", json!(ROOT_KEY)),
        ("det_credentials", json!({BOUND: "x"})),
    ] {
        let mut params = json!({"spec": spec, "env": cli_env()});
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
        let params = json!({"spec": budgeted(vec![step]), "admission_key": ROOT_KEY});
        assert_eq!(caller.refusal("run.start", params), "invalid_spec");
    }
    // Withheld names and unbound names absent from the run env cannot be declared.
    for name in [AGENT_ONLY[0].0, "NPM_TOKEN"] {
        let params = json!({"spec": {"steps": [probe("p", &[name])]},
                            "admission_key": ROOT_KEY, "env": cli_env()});
        assert_eq!(
            caller.refusal("run.start", params),
            "credential_unavailable",
            "{name}"
        );
    }
    // The owned root itself: a caller-supplied value never shadows the bound one.
    let mut env = cli_env();
    env[BOUND] = json!("caller-supplied-impostor-value");
    let root = start(
        &mut caller,
        vec![probe("p", &[BOUND])],
        Some(ROOT_KEY),
        Some(env),
    )
    .unwrap();
    assert_eq!(
        stdout_of(&mut caller, &root["run_id"], "p"),
        fingerprint(BOUND_VALUE)
    );
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials not implemented"]
fn authored_child_inherits_only_through_the_root_body_lease_holder() {
    let fixture = Fixture::new();
    let _daemon = cloud_daemon(&fixture);
    let mut body = attach_agent_worker(&fixture, "authored-root-body");
    let mut cli = fixture.connect();
    let root = cli
        .request(
            "run.start",
            json!({"spec": budgeted(vec![agent_step("body")]), "admission_key": ROOT_KEY,
                   "env": cli_env()}),
        )
        .unwrap();
    assert_eq!(root["status"], "parked", "{root}");
    let lease = body.event("step.dispatch");
    let parent = json!({"run_id": lease["run_id"], "step_id": lease["step_id"],
                        "attempt": lease["attempt"]});
    let child = |parent: &Value| {
        json!({"spec": {"steps": [probe("p", &[BOUND])]}, "parent": parent,
               "admission_key": "authored-child:fixture-0001", "env": cli_env()})
    };

    // Any other connection (an agent on the socket) cannot claim the lease.
    let mut intruder = fixture.connect();
    assert_eq!(
        intruder.refusal("run.start", child(&parent)),
        "parent_not_held"
    );
    let mut stale = parent.clone();
    stale["attempt"] = json!(lease["attempt"].as_u64().unwrap() + 1);
    assert_eq!(body.refusal("run.start", child(&stale)), "parent_not_held");

    // The lease holder's child is entitled through journaled lineage.
    let admitted = body.request("run.start", child(&parent)).unwrap();
    assert_eq!(admitted["status"], "completed", "{admitted}");
    assert_eq!(
        stdout_of(&mut body, &admitted["run_id"], "p"),
        fingerprint(BOUND_VALUE)
    );
    let spawned = entries(&mut body, &admitted["run_id"]);
    let spawned = spawned
        .iter()
        .find(|e| e["entry_type"] == "run.spawned")
        .unwrap();
    assert_eq!(spawned["payload"]["parent_run_id"], lease["run_id"]);
    assert_eq!(complete_agent(&mut body, &lease)["status"], "completed");
}

/// Start the owned root and stop it mid-run: `before` has completed, `gate`
/// is running. Returns the root run id after the daemon is SIGKILLed.
fn interrupted_root(fixture: &Fixture) -> Value {
    let gate = fixture.scratch.join("gate");
    let started = fixture.scratch.join("gate.started");
    let wait = format!(
        "touch '{}'; while [ ! -f '{}' ]; do sleep 0.02; done",
        started.display(),
        gate.display()
    );
    let mut daemon = cloud_daemon(fixture);
    let mut cli = fixture.connect();
    let steps = vec![
        probe("before", &[BOUND]),
        after(det("gate", &wait, &[]), "before"),
        after(probe("after", &[BOUND]), "gate"),
        after(probe("after_undeclared", &[]), "after"),
    ];
    let blocked =
        std::thread::spawn(move || start(&mut cli, steps, Some(ROOT_KEY), Some(cli_env())));
    wait_for("the gate step", || started.exists());
    let mut watcher = fixture.connect();
    let run_id = json!(admitted_run_id(&fixture.data_dir, ROOT_KEY));
    assert_eq!(
        stdout_of(&mut watcher, &run_id, "before"),
        fingerprint(BOUND_VALUE)
    );
    daemon.kill();
    assert!(
        blocked.join().unwrap().is_err(),
        "the run finished before the kill"
    );
    fs::write(&gate, b"").unwrap();
    run_id
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials not implemented"]
fn restart_and_resume_keep_exactly_the_same_binding() {
    let fixture = Fixture::new();
    let run_id = interrupted_root(&fixture);
    let _restarted = cloud_daemon(&fixture);
    let mut resumer = fixture.connect();
    let mut env = cli_env();
    env[BOUND] = json!("caller-supplied-impostor-value");
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
    // Not more: the restarted daemon entitles no other run.
    let params = json!({"spec": {"steps": [probe("p", &[BOUND])]}, "env": cli_env(),
                        "admission_key": "authored-root:after-restart"});
    assert_eq!(
        resumer.refusal("run.start", params),
        "credential_unavailable"
    );
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials not implemented"]
fn restart_without_the_binding_fails_closed() {
    let fixture = Fixture::new();
    let run_id = interrupted_root(&fixture);
    // The host restarts the daemon without the flags (the value may even still
    // sit in its env): nothing persisted may resurrect the binding.
    let _restarted = Daemon::start(&fixture, None, &[(BOUND, BOUND_VALUE)]);
    let mut resumer = fixture.connect();
    let _ = resumer.request("run.resume", json!({"run_id": run_id, "env": cli_env()}));
    let entries = entries(&mut resumer, &run_id);
    let after: Vec<_> = entries.iter().filter(|e| e["step_id"] == "after").collect();
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
        "the declared step ran with the credential after an unbound restart"
    );
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials not implemented"]
fn no_token_value_reaches_journal_wire_logs_or_checkpoints() {
    let fixture = Fixture::new();
    let mut daemon = cloud_daemon(&fixture);
    let mut cli = fixture.connect();
    let leak = r#"printf 'out:%s' "$GH_TOKEN"; printf 'err:%s' "$GH_TOKEN" >&2"#;
    let fail = r#"printf 'fail:%s' "$GH_TOKEN" >&2; exit 3"#;
    let run = cli
        .request(
            "run.start",
            json!({"spec": {"steps": [det("leak", leak, &[BOUND]),
                                      after(det("fail", fail, &[BOUND]), "leak")]},
                   "admission_key": ROOT_KEY, "env": cli_env(), "watch": true}),
        )
        .unwrap();
    assert_eq!(run["status"], "failed", "{run}");
    let journal = entries(&mut cli, &run["run_id"]);
    let leaked = journal
        .iter()
        .find(|e| e["step_id"] == "leak" && e["entry_type"] == "step.completed");
    assert_eq!(
        leaked.unwrap()["payload"]["output"]["stdout_tail"],
        format!("out:[redacted:{BOUND}]")
    );
    cli.request("run.get", json!({"run_id": run["run_id"]}))
        .unwrap();
    daemon.kill();

    let wire = fixture.wire.lock().unwrap().clone();
    assert!(
        !contains(&wire, BOUND_VALUE),
        "a wire frame carried the value"
    );
    assert!(
        !contains(&daemon.output(), BOUND_VALUE),
        "the daemon logged the value"
    );
    assert_eq!(
        files_containing(&fixture.data_dir, BOUND_VALUE),
        Vec::<String>::new(),
        "the value reached the journal, registry or a checkpoint"
    );
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials not implemented"]
fn f1_per_run_env_isolation_still_holds_with_a_binding() {
    let fixture = Fixture::new();
    let _daemon = Daemon::start(
        &fixture,
        Some(&cloud_binding()),
        &[
            (BOUND, BOUND_VALUE),
            ("DAEMON_ONLY", "from-host"),
            ("RUN_LABEL", "daemon"),
        ],
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
