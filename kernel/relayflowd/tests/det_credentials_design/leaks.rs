//! What crosses which boundary (proposal §4.4, §4.5). FUTURE contract;
//! ignored until implemented.
//!
//! Two different claims, kept apart:
//! - a CONFORMING client omits every name `hello.det_withheld` lists, so no
//!   withheld agent value and no bound credential appears in the bytes it
//!   sends; the SDK half of that is pinned in
//!   packages/sdk/tests/det-credentials.design.test.ts;
//! - a NONCONFORMING raw client can always send its own values. The kernel
//!   strips or refuses them; it cannot erase incoming wire bytes. What it
//!   guarantees is what it sends back, logs, journals and persists.
//!
//! "No files" here means kernel persistence under the data dir. Env dumps a
//! test writes outside it, and anything an entitled step writes itself, are
//! not covered.

use std::fs;

use serde_json::json;

use super::{contract::*, harness::*};

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials interface absent"]
fn det_steps_never_receive_withheld_agent_keys_even_from_a_raw_client() {
    let fixture = Fixture::new();
    let declared = fixture.scratch.join("declared.env");
    let undeclared = fixture.scratch.join("undeclared.env");
    let root = spec(vec![
        dump("declared", &declared, &[BOUND]),
        after(dump("undeclared", &undeclared, &[]), "declared"),
    ]);
    let _daemon = Daemon::start(&fixture, Some(&cloud_binding(&root)), &[]);
    let mut raw = fixture.connect();
    let run = start_root(&mut raw, &root, ROOT_SECRET, raw_cli_env()).unwrap();
    assert_eq!(run["status"], "completed", "{run}");
    for path in [&declared, &undeclared] {
        let env = fs::read(path).unwrap();
        let text = String::from_utf8_lossy(&env).into_owned();
        for (name, value) in AGENT_ONLY {
            assert!(
                !text
                    .lines()
                    .any(|line| line.starts_with(&format!("{name}="))),
                "{name} reached a det step ({})",
                path.display()
            );
            assert!(
                !contains(&env, value),
                "{name}'s value bytes reached a det step"
            );
        }
        // Ordinary repository and delivered names keep their per-run path.
        for (name, value) in REPOSITORY.iter().chain(std::iter::once(&DELIVERED)) {
            assert!(text.contains(&format!("{name}={value}")), "{name} lost");
        }
    }
    let declared = fs::read_to_string(&declared).unwrap();
    assert!(declared.contains(&format!("{BOUND}={BOUND_VALUE}")));
    assert!(
        !fs::read_to_string(&undeclared)
            .unwrap()
            .contains(&format!("{BOUND}="))
    );
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials interface absent"]
fn no_secret_reaches_daemon_output_journal_or_kernel_persistence() {
    let fixture = Fixture::new();
    let leak = r#"printf 'out:%s' "$GH_TOKEN"; printf 'err:%s' "$GH_TOKEN" >&2"#;
    let fail = r#"printf 'fail:%s' "$GH_TOKEN" >&2; exit 3"#;
    let root = spec(vec![
        det("leak", leak, &[BOUND]),
        after(det("fail", fail, &[BOUND]), "leak"),
    ]);
    let mut daemon = Daemon::start(&fixture, Some(&cloud_binding(&root)), &[]);
    let mut cli = fixture.connect();
    let env = conforming_cli_env(&mut cli);
    authenticate(&mut cli, ROOT_SECRET, JOURNAL).unwrap();
    let run = cli
        .request(
            "run.start",
            json!({"spec": root, "admission_key": ROOT_KEY, "env": env, "watch": true}),
        )
        .unwrap();
    assert_eq!(run["status"], "failed", "{run}");
    let journal = entries(&mut cli, &run["run_id"]);
    let leaked = journal
        .iter()
        .find(|e| e["step_id"] == "leak" && e["entry_type"] == "step.completed")
        .unwrap();
    assert_eq!(
        leaked["payload"]["output"]["stdout_tail"],
        format!("out:[redacted:{BOUND}]")
    );
    cli.request("run.get", json!({"run_id": run["run_id"]}))
        .unwrap();
    daemon.kill();

    let sent = fixture.sent.lock().unwrap().clone();
    let received = fixture.received.lock().unwrap().clone();
    let output = daemon.output();
    let values = AGENT_ONLY
        .iter()
        .map(|(_, value)| *value)
        .chain([BOUND_VALUE]);
    for value in values {
        assert!(
            !contains(&sent, value),
            "a conforming client sent a secret value"
        );
        assert!(
            !contains(&received, value),
            "the daemon sent a secret value back"
        );
        assert!(
            !contains(&output, value),
            "the daemon logged a secret value"
        );
        assert_eq!(
            files_containing(&fixture.data_dir, value),
            Vec::<String>::new()
        );
    }
}
