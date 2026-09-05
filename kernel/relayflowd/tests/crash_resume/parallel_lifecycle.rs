//! Multi-lease lifecycle tests at the real Unix-socket and CLI boundary.

use std::{
    thread,
    time::{Duration, Instant},
};

use relayflowd_core::EntryType;
use serde_json::{Value, json};

use super::{
    llm_support::{
        LlmFixture, ProtocolClient, ServerGuard, attached_worker, complete, spawn_resume, start_run,
    },
    support::{journal_entries, wait_until},
};

fn attached_agent(fixture: &LlmFixture, id: &str) -> ProtocolClient {
    let mut worker = ProtocolClient::connect(&fixture.data_dir.join("relayflowd.sock"));
    worker
        .request(
            "worker.attach",
            json!({
                "worker_id": id,
                "step_types": ["agent"],
                "capacity": 8,
                "pins": {"workspace": [
                    {"surface": "repo-b", "revision_id": "r0"},
                    {"surface": "repo-a", "revision_id": "r0"}
                ]}
            }),
        )
        .unwrap();
    worker
}

fn complete_agent(
    worker: &mut ProtocolClient,
    dispatch: &Value,
    revisions: &[(&str, &str)],
) -> anyhow::Result<Value> {
    worker.request(
        "step.complete",
        json!({
            "run_id": dispatch["run_id"],
            "step_id": dispatch["step_id"],
            "attempt": dispatch["attempt"],
            "idempotency_key": dispatch["idempotency_key"],
            "completionReason": "success",
            "output": {"done": dispatch["step_id"]},
            "started_pins": dispatch["pins"],
            "end_pins": {"workspace": revisions.iter().map(|(surface, revision_id)| {
                json!({"surface": surface, "revision_id": revision_id})
            }).collect::<Vec<_>>()}
        }),
    )
}

fn complete_failure(worker: &mut ProtocolClient, dispatch: &Value) -> anyhow::Result<Value> {
    worker.request(
        "step.complete",
        json!({
            "run_id": dispatch["run_id"],
            "step_id": dispatch["step_id"],
            "attempt": dispatch["attempt"],
            "idempotency_key": dispatch["idempotency_key"],
            "completionReason": "worker_error",
            "output": null
        }),
    )
}

#[test]
fn renewed_parallel_leases_survive_the_original_grant_and_remain_distinct() {
    let fixture = LlmFixture::parallel("renewed-cli-resume");
    let _server = ServerGuard::start(&fixture);
    let mut worker = attached_worker(&fixture, "renewed-stub");
    let run_id = start_run(&fixture);
    let dispatches = [
        worker.event("step.dispatch").unwrap(),
        worker.event("step.dispatch").unwrap(),
    ];
    let began = Instant::now();
    thread::sleep(Duration::from_secs(10));
    let renew = |worker: &mut ProtocolClient, dispatch: &Value| {
        worker
            .request(
                "step.heartbeat",
                json!({
                    "run_id": run_id,
                    "step_id": dispatch["step_id"],
                    "attempt": dispatch["attempt"],
                    "lease_id": dispatch["lease_id"]
                }),
            )
            .unwrap()["lease_deadline_ms"]
            .as_i64()
            .unwrap()
    };
    let lane_b_deadline = renew(&mut worker, &dispatches[0]);
    thread::sleep(Duration::from_millis(40));
    let lane_a_deadline = renew(&mut worker, &dispatches[1]);
    assert_ne!(lane_b_deadline, lane_a_deadline);
    let mut control = ProtocolClient::connect(&fixture.data_dir.join("relayflowd.sock"));
    let snapshot = control
        .request("run.get", json!({"run_id": run_id}))
        .unwrap();
    assert_eq!(
        snapshot["steps"]["lane-b"]["lease_deadline_ms"],
        lane_b_deadline
    );
    assert_eq!(
        snapshot["steps"]["lane-a"]["lease_deadline_ms"],
        lane_a_deadline
    );

    thread::sleep(Duration::from_secs(36).saturating_sub(began.elapsed()));
    let mut resume = spawn_resume(&fixture, &run_id);
    thread::sleep(Duration::from_millis(300));
    assert!(
        resume.try_wait().unwrap().is_none(),
        "the real CLI must keep waiting on renewed assignments"
    );
    complete(&mut worker, &dispatches[1], json!({"answer": "a"})).unwrap();
    complete(&mut worker, &dispatches[0], json!({"answer": "b"})).unwrap();
    let output = resume.wait_with_output().unwrap();
    assert!(output.status.success(), "renewed resume failed: {output:?}");
}

#[test]
fn overlapping_agent_lanes_serialize_while_disjoint_lanes_merge_in_either_order() {
    let fixture = LlmFixture::parallel_agents("overlap", true);
    let _server = ServerGuard::start(&fixture);
    let mut worker = attached_agent(&fixture, "overlap-agent");
    start_run(&fixture);
    let lane_b = worker.event("step.dispatch").unwrap();
    assert_eq!(lane_b["step_id"], "lane-b");
    worker.override_read_timeout(Some(Duration::from_millis(200)));
    assert!(worker.event("step.dispatch").is_err());
    worker.override_read_timeout(None);
    complete_agent(&mut worker, &lane_b, &[("repo-b", "rB")]).unwrap();
    let lane_a = worker.event("step.dispatch").unwrap();
    assert_eq!(lane_a["pins"]["workspace"][0]["revision_id"], "rB");
    complete_agent(&mut worker, &lane_a, &[("repo-b", "rA")]).unwrap();
    let join = worker.event("step.dispatch").unwrap();
    assert_eq!(join["pins"]["workspace"][0]["revision_id"], "rA");
    assert_eq!(
        complete_agent(&mut worker, &join, &[("repo-b", "rJ")]).unwrap()["status"],
        "completed"
    );

    for (name, order) in [
        ("disjoint-authored", ["lane-b", "lane-a"]),
        ("disjoint-reverse", ["lane-a", "lane-b"]),
    ] {
        let fixture = LlmFixture::parallel_agents(name, false);
        let _server = ServerGuard::start(&fixture);
        let mut worker = attached_agent(&fixture, name);
        start_run(&fixture);
        let dispatches = [
            worker.event("step.dispatch").unwrap(),
            worker.event("step.dispatch").unwrap(),
        ];
        for step_id in order {
            let dispatch = dispatches
                .iter()
                .find(|dispatch| dispatch["step_id"] == step_id)
                .unwrap();
            let pins = if step_id == "lane-b" {
                &[("repo-b", "rB")][..]
            } else {
                &[("repo-a", "rA")][..]
            };
            complete_agent(&mut worker, dispatch, pins).unwrap();
        }
        let join = worker.event("step.dispatch").unwrap();
        let pins = join["pins"]["workspace"].as_array().unwrap();
        assert!(
            pins.iter()
                .any(|pin| pin["surface"] == "repo-b" && pin["revision_id"] == "rB")
        );
        assert!(
            pins.iter()
                .any(|pin| pin["surface"] == "repo-a" && pin["revision_id"] == "rA")
        );
        assert_eq!(
            complete_agent(&mut worker, &join, &[("repo-b", "rJB"), ("repo-a", "rJA")]).unwrap()["status"],
            "completed"
        );
    }
}

#[test]
fn overlapping_agent_conflict_survives_server_crash_and_resume() {
    let fixture = LlmFixture::parallel_agents("overlap-crash", true);
    let mut server = ServerGuard::start(&fixture);
    let mut worker = attached_agent(&fixture, "before-crash");
    let run_id = start_run(&fixture);
    assert_eq!(worker.event("step.dispatch").unwrap()["step_id"], "lane-b");
    server.kill();
    drop(worker);
    let _restarted = ServerGuard::start(&fixture);
    let mut replacement = attached_agent(&fixture, "after-crash");
    let resume = spawn_resume(&fixture, &run_id);
    let retried = replacement.event("step.dispatch").unwrap();
    assert_eq!(retried["step_id"], "lane-b");
    assert_eq!(retried["attempt"], 2);
    replacement.override_read_timeout(Some(Duration::from_millis(200)));
    assert!(replacement.event("step.dispatch").is_err());
    replacement.override_read_timeout(None);
    complete_agent(&mut replacement, &retried, &[("repo-b", "rB")]).unwrap();
    let lane_a = replacement.event("step.dispatch").unwrap();
    complete_agent(&mut replacement, &lane_a, &[("repo-b", "rA")]).unwrap();
    let join = replacement.event("step.dispatch").unwrap();
    complete_agent(&mut replacement, &join, &[("repo-b", "rJ")]).unwrap();
    assert!(resume.wait_with_output().unwrap().status.success());
}

#[test]
fn terminal_failure_drains_or_explains_every_live_sibling() {
    for failed_step in ["lane-b", "lane-a"] {
        let fixture = LlmFixture::parallel_terminal(&format!("terminal-{failed_step}"));
        let _server = ServerGuard::start(&fixture);
        let mut worker = attached_worker(&fixture, failed_step);
        let run_id = start_run(&fixture);
        let dispatches = [
            worker.event("step.dispatch").unwrap(),
            worker.event("step.dispatch").unwrap(),
        ];
        let failed = dispatches
            .iter()
            .find(|dispatch| dispatch["step_id"] == failed_step)
            .unwrap();
        let sibling = dispatches
            .iter()
            .find(|dispatch| dispatch["step_id"] != failed_step)
            .unwrap();
        assert_eq!(
            complete_failure(&mut worker, failed).unwrap()["status"],
            "parked"
        );
        assert!(
            !journal_entries(&fixture.data_dir)
                .unwrap()
                .iter()
                .any(|entry| entry.entry_type == EntryType::RunCompleted)
        );
        assert_eq!(
            complete(&mut worker, sibling, json!({"answer": "done"})).unwrap()["status"],
            "failed"
        );
        assert_eq!(
            journal_entries(&fixture.data_dir)
                .unwrap()
                .last()
                .unwrap()
                .entry_type,
            EntryType::RunCompleted
        );
        assert!(
            worker
                .request(
                    "step.complete",
                    json!({
                        "run_id": run_id,
                        "step_id": sibling["step_id"],
                        "attempt": sibling["attempt"],
                        "idempotency_key": sibling["idempotency_key"],
                        "completionReason": "success",
                        "output": {"answer": "late"}
                    })
                )
                .is_err()
        );
        assert_eq!(
            journal_entries(&fixture.data_dir)
                .unwrap()
                .last()
                .unwrap()
                .entry_type,
            EntryType::RunCompleted
        );
    }

    let fixture = LlmFixture::parallel_terminal("terminal-disconnect");
    let _server = ServerGuard::start(&fixture);
    let mut worker = attached_worker(&fixture, "disconnecting-worker");
    let run_id = start_run(&fixture);
    let first = worker.event("step.dispatch").unwrap();
    worker.event("step.dispatch").unwrap();
    assert_eq!(
        complete_failure(&mut worker, &first).unwrap()["status"],
        "parked"
    );
    drop(worker);
    wait_until("sibling disconnect completion", || {
        journal_entries(&fixture.data_dir).is_some_and(|entries| {
            entries
                .iter()
                .filter(|entry| entry.entry_type == EntryType::StepCompleted)
                .count()
                == 2
        })
    });
    let mut control = ProtocolClient::connect(&fixture.data_dir.join("relayflowd.sock"));
    assert_eq!(
        control
            .request("run.resume", json!({"run_id": run_id}))
            .unwrap()["status"],
        "failed"
    );
    assert_eq!(
        journal_entries(&fixture.data_dir)
            .unwrap()
            .last()
            .unwrap()
            .entry_type,
        EntryType::RunCompleted
    );
}
