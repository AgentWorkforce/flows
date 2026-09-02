use serde_json::json;

use super::*;
use crate::{entry::StepCompletedPayload, state::RunState};

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
    let running = RunState::fold("run", spec, &starts).unwrap();
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
}
