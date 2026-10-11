//! K, the host's per-daemon-lifetime capability (proposal §4.3.1). K never
//! crosses the socket: each connection answers a single-use `hello` nonce
//! with an HMAC proof bound to a purpose and a session. The agent-key and
//! token scans do not cover K, so K and its proofs get their own controls.
//! FUTURE contract; ignored until implemented.
//!
//! Descriptor controls (fd 3 and its aliases never reach agent or det
//! children) are SDK-side: packages/sdk/tests/det-credentials-live.design.test.ts.

use serde_json::json;

use super::{contract::*, harness::*};

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials interface absent"]
fn a_proof_is_single_use_purpose_bound_and_session_bound() {
    let fixture = Fixture::new();
    let root = spec(vec![agent_step("body")]);
    let _daemon = Daemon::start(&fixture, Some(&cloud_binding(&root)), &[]);

    // Replay on another connection: that connection's nonce differs.
    let mut first = fixture.connect();
    let first_nonce = nonce(&mut first);
    let mac = proof(ROOT_SECRET, JOURNAL, &first_nonce);
    first
        .request("auth.prove", prove_params(JOURNAL, &mac))
        .unwrap();
    let mut second = fixture.connect();
    let _ = hello(&mut second);
    assert_eq!(
        second.refusal("auth.prove", prove_params(JOURNAL, &mac)),
        "auth_failed"
    );
    // Replay on the same connection: the nonce was consumed.
    assert_eq!(
        first.refusal("auth.prove", prove_params(JOURNAL, &mac)),
        "auth_failed"
    );
    // A proof computed for one purpose does not authenticate another.
    let mut third = fixture.connect();
    let third_nonce = nonce(&mut third);
    let worker_mac = proof(ROOT_SECRET, &peer_purpose("some-session"), &third_nonce);
    assert_eq!(
        third.refusal("auth.prove", prove_params(JOURNAL, &worker_mac)),
        "auth_failed"
    );
    // A worker-peer connection cannot start the root.
    let mut journal = fixture.connect();
    let session = authenticate_journal(&mut journal, ROOT_SECRET);
    let mut worker = fixture.connect();
    authenticate(&mut worker, ROOT_SECRET, &peer_purpose(&session)).unwrap();
    let env = raw_cli_env();
    let params = json!({"spec": root, "admission_key": ROOT_KEY, "env": env});
    assert_eq!(
        worker.refusal("run.start", params),
        "root_not_authenticated"
    );
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials interface absent"]
fn no_k_or_proof_bytes_reach_any_response_journal_log_or_file() {
    let fixture = Fixture::new();
    let root = spec(vec![probe("p", &[BOUND])]);
    let mut daemon = Daemon::start(&fixture, Some(&cloud_binding(&root)), &[]);
    let mut cli = fixture.connect();
    let env = conforming_cli_env(&mut cli);
    let cli_nonce = nonce(&mut cli);
    let mac = proof(ROOT_SECRET, JOURNAL, &cli_nonce);
    let accepted = cli
        .request("auth.prove", prove_params(JOURNAL, &mac))
        .unwrap();
    assert!(!accepted.to_string().contains(&mac), "{accepted}");
    let run = cli
        .request(
            "run.start",
            json!({"spec": root, "admission_key": ROOT_KEY, "env": env, "watch": true}),
        )
        .unwrap();
    assert_eq!(run["status"], "completed", "{run}");
    entries(&mut cli, &run["run_id"]);
    cli.request("run.get", json!({"run_id": run["run_id"]}))
        .unwrap();
    // A refused proof is not echoed either.
    let mut other = fixture.connect();
    let bad = proof(ROOT_SECRET_AFTER_RESTART, JOURNAL, &nonce(&mut other));
    let frame = other
        .frame("auth.prove", prove_params(JOURNAL, &bad))
        .unwrap();
    assert!(!frame.to_string().contains(&bad), "{frame}");
    daemon.kill();

    // K never crosses the socket at all; proofs cross only client -> daemon.
    let sent = fixture.sent.lock().unwrap().clone();
    let received = fixture.received.lock().unwrap().clone();
    assert!(!contains(&sent, ROOT_SECRET), "K was sent over the socket");
    for secret in [ROOT_SECRET, &mac, &bad] {
        assert!(
            !contains(&received, secret),
            "the daemon sent K or a proof back"
        );
        assert!(
            !contains(&daemon.output(), secret),
            "the daemon logged K or a proof"
        );
        assert_eq!(
            files_containing(&fixture.data_dir, secret),
            Vec::<String>::new()
        );
    }
}

#[test]
#[ignore = "DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md): det_credentials interface absent"]
fn a_foreign_k_is_refused_and_k_is_revoked_when_the_root_lineage_completes() {
    let fixture = Fixture::new();
    let root = spec(vec![probe("p", &[BOUND])]);
    let _daemon = Daemon::start(&fixture, Some(&cloud_binding(&root)), &[]);
    // Another lifetime's K (foreign) never authenticates this daemon.
    let mut foreign = fixture.connect();
    assert!(authenticate(&mut foreign, ROOT_SECRET_AFTER_RESTART, JOURNAL).is_err());
    // K authenticates the session's connections while the lineage is live...
    let mut cli = fixture.connect();
    let env = conforming_cli_env(&mut cli);
    let mut peer = fixture.connect();
    authenticate(&mut peer, ROOT_SECRET, JOURNAL).unwrap();
    let run = start_root(&mut cli, &root, ROOT_SECRET, env.clone()).unwrap();
    assert_eq!(run["status"], "completed", "{run}");
    // ...and is revoked once the root lineage completes.
    let mut late = fixture.connect();
    assert!(authenticate(&mut late, ROOT_SECRET, JOURNAL).is_err());
    let again = json!({"spec": root, "admission_key": "authored-root:again", "env": env});
    assert_eq!(peer.refusal("run.start", again), "credential_unavailable");
}
