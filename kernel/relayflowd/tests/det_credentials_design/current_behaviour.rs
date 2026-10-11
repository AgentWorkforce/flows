//! Current behaviour on main (not ignored): the Cloud shape after #655.
//!
//! The host spawns the daemon with `daemonEnv` (holds GH_TOKEN, no agent
//! keys; cloud relayflow-v2-step-env.ts:215-218) and the CLI sends `cliEnv`
//! (agent keys, no GH_TOKEN; :219-223) as `run.start.env`. exec_det clears the
//! daemon env and applies the run env (exec_det.rs:77-80), so:
//! - D1: the det step loses GH_TOKEN;
//! - D2: the det step receives every agent-only key.

use std::fs;

use super::{contract::*, harness::*};

#[test]
fn current_main_det_steps_lose_the_daemon_token_and_receive_agent_keys() {
    let fixture = Fixture::new();
    let _daemon = Daemon::start(&fixture, None, &[(BOUND, BOUND_VALUE)]);
    let dumped = fixture.scratch.join("det.env");
    let mut cli = fixture.connect();
    let run = start(
        &mut cli,
        vec![dump("det", &dumped, &[])],
        None,
        Some(raw_cli_env()),
    )
    .unwrap();
    assert_eq!(run["status"], "completed", "{run}");
    let env = fs::read_to_string(&dumped).unwrap();
    assert!(
        !env.contains(&format!("{BOUND}=")),
        "D1 not reproduced: GH_TOKEN reached the step"
    );
    for (name, value) in AGENT_ONLY {
        assert!(
            env.contains(&format!("{name}={value}")),
            "D2 not reproduced for {name}"
        );
    }
}
