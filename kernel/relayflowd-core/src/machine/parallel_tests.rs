use serde_json::json;

use super::*;
use crate::{
    entry::{StepCompletedPayload, WorkspacePin},
    state::{RunState, StateError},
};

fn parallel_spec() -> crate::RunSpec {
    crate::RunSpec::parse(&json!({
        "steps": [
            {
                "id": "lane-b",
                "type": "llm",
                "prompt": "research b",
                "retry": {"initial_backoff_ms": 0, "max_backoff_ms": 0, "multiplier": 1, "jitter_percent": 0}
            },
            {
                "id": "join",
                "type": "deterministic",
                "command": "true",
                "depends_on": ["lane-a", "lane-b"]
            },
            {
                "id": "lane-a",
                "type": "llm",
                "prompt": "research a",
                "retry": {"initial_backoff_ms": 0, "max_backoff_ms": 0, "multiplier": 1, "jitter_percent": 0}
            }
        ]
    }))
    .unwrap()
}

fn appended_entries(actions: &[Action]) -> Vec<JournalEntry> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::Append(entry) => Some(entry.clone()),
            _ => None,
        })
        .collect()
}

fn parallel_agent_spec(overlapping: bool) -> crate::RunSpec {
    let lane_a_surface = if overlapping { "repo-b" } else { "repo-a" };
    crate::RunSpec::parse(&json!({
        "steps": [
            {
                "id": "lane-b",
                "type": "agent",
                "instruction": "b",
                "surfaces": {"workspace": [{"surface": "repo-b"}]}
            },
            {
                "id": "lane-a",
                "type": "agent",
                "instruction": "a",
                "surfaces": {"workspace": [{"surface": lane_a_surface}]}
            },
            {
                "id": "join",
                "type": "agent",
                "instruction": "join",
                "depends_on": ["lane-b", "lane-a"],
                "surfaces": {"workspace": [
                    {"surface": "repo-b"},
                    {"surface": lane_a_surface}
                ]}
            }
        ]
    }))
    .unwrap()
}

fn agent_success(
    spec: &crate::RunSpec,
    step_id: &str,
    revision: &str,
    now_ms: i64,
) -> JournalEntry {
    let step = spec.step(step_id).unwrap();
    let mut result = AttemptResult::successful(json!({"done": step_id}), "worker");
    let surface = match &step.kind {
        StepKind::Agent { surfaces, .. } => surfaces.workspace[0].surface.clone(),
        _ => unreachable!(),
    };
    result.end_pins = Some(Pins {
        workspace: vec![WorkspacePin {
            surface,
            revision_id: revision.to_owned(),
        }],
        streams: Vec::new(),
    });
    completion_actions("run", step, 1, 0, result, now_ms)
        .into_iter()
        .find_map(|action| match action {
            Action::Append(entry) if entry.entry_type == EntryType::StepCompleted => Some(entry),
            _ => None,
        })
        .unwrap()
}

#[test]
fn machine_starts_every_runnable_step_in_authored_order() {
    let state = RunState::fold("run", parallel_spec(), &[]).unwrap();
    let actions = next_actions(&state, 10);

    assert_eq!(
        actions,
        next_actions(&state, 10),
        "the same journal state and simulated time must emit the same batch"
    );
    assert_eq!(actions.len(), 4, "both independent lanes must start");
    for (pair, expected_step) in actions.chunks_exact(2).zip(["lane-b", "lane-a"]) {
        let Action::Append(started) = &pair[0] else {
            panic!("each lease must be journaled before dispatch")
        };
        assert_eq!(started.entry_type, EntryType::StepAttemptStarted);
        assert_eq!(started.step_id.as_deref(), Some(expected_step));
        let Action::Dispatch { step, attempt, .. } = &pair[1] else {
            panic!("each independent llm lane must dispatch")
        };
        assert_eq!(step.id, expected_step);
        assert_eq!(*attempt, 1);
    }
}

#[test]
fn parallel_lanes_do_not_cross_the_dependency_barrier_early() {
    let spec = parallel_spec();
    let fresh = RunState::fold("run", spec.clone(), &[]).unwrap();
    let mut entries = appended_entries(&next_actions(&fresh, 10));
    assert_eq!(entries.len(), 2, "both lane leases must be journaled");

    let complete = |step: &crate::StepSpec, answer: &str| {
        completion_actions(
            "run",
            step,
            1,
            0,
            AttemptResult::successful(json!({"answer": answer}), "worker"),
            20,
        )
        .into_iter()
        .find_map(|action| match action {
            Action::Append(entry) if entry.entry_type == EntryType::StepCompleted => Some(entry),
            _ => None,
        })
        .unwrap()
    };

    entries.push(complete(&spec.steps[0], "b"));
    let one_lane_running = RunState::fold("run", spec.clone(), &entries).unwrap();
    assert!(next_actions(&one_lane_running, 20).is_empty());
    assert_eq!(one_lane_running.steps["join"].state, StepState::Pending);

    entries.push(complete(&spec.steps[2], "a"));
    let both_lanes_done = RunState::fold("run", spec, &entries).unwrap();
    let actions = next_actions(&both_lanes_done, 20);
    let Action::Append(join_started) = &actions[0] else {
        panic!("the join must start once every dependency succeeds")
    };
    assert_eq!(join_started.step_id.as_deref(), Some("join"));
}

#[test]
fn crash_resume_preserves_each_parallel_lease_exactly_once() {
    let spec = parallel_spec();
    let fresh = RunState::fold("run", spec.clone(), &[]).unwrap();
    let actions = next_actions(&fresh, 10);
    let starts = appended_entries(&actions);
    assert_eq!(starts.len(), 2, "both parallel leases must be durable");

    // Crash after only the first journal append: resume schedules the lane
    // whose lease was never persisted, without re-emitting the durable one.
    let partial = RunState::fold("run", spec.clone(), &starts[..1]).unwrap();
    let resumed = next_actions(&partial, 11);
    assert_eq!(resumed.len(), 2);
    let Action::Append(resumed_start) = &resumed[0] else {
        panic!("the unstarted lane must journal its lease")
    };
    assert_eq!(resumed_start.step_id.as_deref(), Some("lane-a"));

    // Crash after both journal appends: recovery explains both in-flight
    // attempts in the same deterministic order, once each.
    let running = RunState::fold("run", spec.clone(), &starts).unwrap();
    let recovered = recovery_actions(&running, 12);
    let completions = recovered
        .iter()
        .filter_map(|action| match action {
            Action::Append(entry) if entry.entry_type == EntryType::StepCompleted => Some(entry),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(completions.len(), 2);
    assert_eq!(completions[0].step_id.as_deref(), Some("lane-b"));
    assert_eq!(completions[1].step_id.as_deref(), Some("lane-a"));
    for entry in completions {
        let payload: StepCompletedPayload = serde_json::from_value(entry.payload.clone()).unwrap();
        assert_eq!(payload.completion_reason, CompletionReason::Crashed);
    }

    let mut entries = starts;
    entries.extend(appended_entries(&recovered));
    let backoff = RunState::fold("run", spec.clone(), &entries).unwrap();
    let due_waits = next_actions(&backoff, 12);
    assert_eq!(
        due_waits.len(),
        2,
        "both recovered lanes must wake together"
    );
    assert!(due_waits.iter().all(|action| matches!(
        action,
        Action::Append(entry) if entry.entry_type == EntryType::WaitCompleted
    )));

    entries.extend(appended_entries(&due_waits));
    let runnable = RunState::fold("run", spec, &entries).unwrap();
    let restarted = next_actions(&runnable, 12);
    assert_eq!(restarted.len(), 4, "both recovered lanes must restart");
    for (pair, expected_step) in restarted.chunks_exact(2).zip(["lane-b", "lane-a"]) {
        let Action::Append(started) = &pair[0] else {
            panic!("each recovered lease must be journaled before dispatch")
        };
        assert_eq!(started.step_id.as_deref(), Some(expected_step));
        assert_eq!(started.attempt, Some(2));
    }
}

#[test]
fn overlapping_agent_surfaces_are_serialized_in_authored_order() {
    let spec = parallel_agent_spec(true);
    let fresh = RunState::fold("run", spec.clone(), &[]).unwrap();
    let first = next_actions(&fresh, 10);
    assert_eq!(first.len(), 2, "only the authored conflict winner starts");
    let Action::Append(started) = &first[0] else {
        panic!("the winning agent must journal its start")
    };
    assert_eq!(started.step_id.as_deref(), Some("lane-b"));

    let mut entries = appended_entries(&first);
    let running = RunState::fold("run", spec.clone(), &entries).unwrap();
    assert!(
        next_actions(&running, 11).is_empty(),
        "a conflicting lane must remain runnable while the surface is leased"
    );
    let mut recovering_entries = entries.clone();
    recovering_entries.extend(appended_entries(&recovery_actions(&running, 12)));
    let recovering = RunState::fold("run", spec.clone(), &recovering_entries).unwrap();
    assert!(
        next_actions(&recovering, 12)
            .iter()
            .all(|action| matches!(action, Action::ArmTimer { .. })),
        "the conflicting sibling must not pass an unfinished lane in retry backoff"
    );

    entries.push(agent_success(&spec, "lane-b", "rB", 12));
    let released = RunState::fold("run", spec, &entries).unwrap();
    let second = next_actions(&released, 12);
    let Action::Append(started) = &second[0] else {
        panic!("the released conflicting lane must now start")
    };
    assert_eq!(started.step_id.as_deref(), Some("lane-a"));
    let payload: AttemptStartedPayload = serde_json::from_value(started.payload.clone()).unwrap();
    assert_eq!(payload.pins.workspace[0].revision_id, "rB");
}

#[test]
fn every_declared_mutable_surface_participates_in_conflict_selection() {
    for surfaces in [
        json!({"workspace": [{"surface": "repo"}]}),
        json!({"streams": [{"stream": "notes"}]}),
        json!({"external": ["/provider/item"]}),
    ] {
        let spec = crate::RunSpec::parse(&json!({
            "steps": [
                {"id": "first", "type": "agent", "instruction": "a", "surfaces": surfaces},
                {"id": "second", "type": "agent", "instruction": "b", "surfaces": surfaces}
            ]
        }))
        .unwrap();
        let state = RunState::fold("run", spec, &[]).unwrap();
        let actions = next_actions(&state, 10);
        assert_eq!(actions.len(), 2);
        let Action::Append(started) = &actions[0] else {
            panic!("the authored conflict winner must start")
        };
        assert_eq!(started.step_id.as_deref(), Some("first"));
    }
}

#[test]
fn external_ancestor_and_descendant_paths_conflict_but_siblings_do_not() {
    let selected = |left: &str, right: &str| {
        let spec = crate::RunSpec::parse(&json!({
            "steps": [
                {"id": "first", "type": "agent", "instruction": "a", "surfaces": {"external": [left]}},
                {"id": "second", "type": "agent", "instruction": "b", "surfaces": {"external": [right]}}
            ]
        }))
        .unwrap();
        let state = RunState::fold("run", spec, &[]).unwrap();
        next_actions(&state, 10)
    };
    assert_eq!(selected("/provider/item", "/provider/item/child").len(), 2);
    assert_eq!(selected("pr://github", "pr://github/example").len(), 2);
    assert_eq!(selected("/provider/a", "/provider/b").len(), 4);
}

#[test]
fn workspace_ancestor_and_descendant_paths_conflict_but_siblings_do_not() {
    let selected = |left: &str, right: &str| {
        let spec = crate::RunSpec::parse(&json!({
            "steps": [
                {"id": "first", "type": "agent", "instruction": "a", "surfaces": {"workspace": [{"surface": left}]}},
                {"id": "second", "type": "agent", "instruction": "b", "surfaces": {"workspace": [{"surface": right}]}}
            ]
        }))
        .unwrap();
        let state = RunState::fold("run", spec, &[]).unwrap();
        next_actions(&state, 10)
    };
    assert_eq!(selected("/mount/repo", "/mount/repo/child").len(), 2);
    assert_eq!(selected("worktrees/repo", "worktrees/repo/child").len(), 2);
    assert_eq!(selected("/mount/left", "/mount/right").len(), 4);
}

#[test]
fn disjoint_agent_lanes_merge_pins_in_either_completion_order() {
    for order in [["lane-b", "lane-a"], ["lane-a", "lane-b"]] {
        let spec = parallel_agent_spec(false);
        let fresh = RunState::fold("run", spec.clone(), &[]).unwrap();
        let starts = next_actions(&fresh, 10);
        assert_eq!(starts.len(), 4, "disjoint agent lanes may fan out");
        let mut entries = appended_entries(&starts);
        for step_id in order {
            let revision = if step_id == "lane-b" { "rB" } else { "rA" };
            entries.push(agent_success(&spec, step_id, revision, 20));
        }
        let joined = RunState::fold("run", spec, &entries).unwrap();
        let actions = next_actions(&joined, 20);
        let Action::Append(started) = &actions[0] else {
            panic!("the join must start after both disjoint lanes")
        };
        let payload: AttemptStartedPayload =
            serde_json::from_value(started.payload.clone()).unwrap();
        assert!(
            payload
                .pins
                .workspace
                .iter()
                .any(|pin| { pin.surface == "repo-b" && pin.revision_id == "rB" })
        );
        assert!(
            payload
                .pins
                .workspace
                .iter()
                .any(|pin| { pin.surface == "repo-a" && pin.revision_id == "rA" })
        );
    }
}

#[test]
fn failed_run_drains_open_siblings_before_terminal_entry() {
    let spec = parallel_spec();
    let fresh = RunState::fold("run", spec.clone(), &[]).unwrap();
    let mut entries = appended_entries(&next_actions(&fresh, 10));
    let mut failed = AttemptResult::successful(Value::Null, "worker");
    failed.failure_reason = Some(CompletionReason::WorkerError);
    entries.extend(appended_entries(&completion_actions(
        "run",
        &spec.steps[0],
        1,
        0,
        failed,
        20,
    )));
    let draining = RunState::fold("run", spec.clone(), &entries).unwrap();
    assert!(
        next_actions(&draining, 20).is_empty(),
        "run.completed must wait for the open sibling lease"
    );

    entries.push(
        completion_actions(
            "run",
            &spec.steps[2],
            1,
            0,
            AttemptResult::successful(json!({"answer": "a"}), "worker"),
            21,
        )
        .into_iter()
        .find_map(|action| match action {
            Action::Append(entry) if entry.entry_type == EntryType::StepCompleted => Some(entry),
            _ => None,
        })
        .unwrap(),
    );
    let drained = RunState::fold("run", spec.clone(), &entries).unwrap();
    let terminal = next_actions(&drained, 21);
    assert!(matches!(
        &terminal[..],
        [Action::Append(entry), Action::CompleteRun { .. }]
            if entry.entry_type == EntryType::RunCompleted
    ));

    entries.extend(appended_entries(&terminal));
    entries.push(JournalEntry::new(
        EntryType::StepCompleted,
        "run",
        Some("lane-a".to_owned()),
        Some(1),
        22,
        StepCompletedPayload {
            completion_reason: CompletionReason::Success,
            disposition: Disposition::StepDone,
            output: Value::Null,
            verification: None,
            end_pins: None,
            effects: Vec::new(),
            trajectory_tail: None,
            budget: Budget::default(),
            completed_by: "late-worker".to_owned(),
            next_attempt_at_ms: None,
        },
    ));
    assert!(matches!(
        RunState::fold("run", spec, &entries),
        Err(StateError::EntryAfterRunCompleted { .. })
    ));
}
