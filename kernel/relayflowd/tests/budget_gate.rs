use relayflowd::{
    Engine, OutOfBandCompletion,
    worker::{DispatchOutcome, JournalObserver, StepDispatch, StepDispatcher},
};
use relayflowd_core::{
    Budget, CompletionReason, EntryType, JournalEntry, RunCompletionReason, RunSpec, StepType,
};
use serde_json::json;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Worker(Mutex<Vec<StepDispatch>>);
impl JournalObserver for Worker {
    fn appended(&self, _: &JournalEntry) {}
}
impl StepDispatcher for Worker {
    fn executor(&self, _: StepType) -> Option<String> {
        Some("mock".into())
    }
    fn available(&self, _: StepType) -> bool {
        true
    }
    fn dispatch(&self, d: StepDispatch) -> anyhow::Result<DispatchOutcome> {
        self.0.lock().unwrap().push(d);
        Ok(DispatchOutcome::Dispatched)
    }
}

#[test]
fn crossing_completion_is_durable_and_next_step_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let worker = Arc::new(Worker::default());
    let engine = Engine::with_runtime(dir.path(), worker.clone(), worker.clone());
    let spec = RunSpec::parse(&json!({"budget":{"max_dollars":"0.001"},"steps":[
        {"id":"first","type":"llm","prompt":"answer"},
        {"id":"second","type":"deterministic","command":"printf must-not-run","depends_on":["first"]}
    ]})).unwrap();
    let started = engine.start(spec, "test", None).unwrap();
    let d = worker.0.lock().unwrap()[0].clone();
    let outcome = engine
        .complete_out_of_band(
            &started.run_id,
            "first",
            OutOfBandCompletion {
                human_intervention: false,
                attempt: d.attempt,
                idempotency_key: d.idempotency_key,
                completion_reason: CompletionReason::Success,
                output: json!("answer"),
                budget: Budget {
                    tokens_in: 1000,
                    tokens_out: 200,
                    dollars: "0.006000".into(),
                    dollars_unmetered: false,
                },
                completed_by: "mock".into(),
                started_pins: None,
                end_pins: None,
                effects: vec![],
                trajectory_tail: None,
            },
        )
        .unwrap();
    assert_eq!(
        outcome.completion_reason,
        Some(RunCompletionReason::BudgetExceeded)
    );
    let reopened = Engine::new(dir.path());
    let entries = reopened.journal_entries(&started.run_id, 1, 100).unwrap();
    let completed = entries
        .iter()
        .find(|e| e.entry_type == EntryType::StepCompleted)
        .unwrap();
    assert_eq!(completed.payload["completionReason"], "success");
    assert_eq!(completed.payload["output"], "answer");
    assert_eq!(completed.payload["spend"]["tokens_input"], 1000);
    assert_eq!(completed.payload["spend"]["tokens_output"], 200);
    assert_eq!(completed.payload["spend"]["dollars"], json!(0.006));
    assert!(completed.payload["spend"]["wallclock_ms"].is_u64());
    assert!(
        !entries
            .iter()
            .any(|e| e.entry_type == EntryType::StepAttemptStarted
                && e.step_id.as_deref() == Some("second"))
    );
    assert_eq!(
        reopened
            .resume(&started.run_id, None)
            .unwrap()
            .completion_reason,
        outcome.completion_reason
    );
}

#[test]
fn deterministic_spend_and_wallclock_limit_gate_parallel_batch_starts() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::new(dir.path());
    let spec = RunSpec::parse(&json!({"budget":{"max_wallclock_ms":0},"steps":[
        {"id":"first","type":"deterministic","command":"sleep 0.01"},
        {"id":"second","type":"deterministic","command":"printf must-not-run"}
    ]}))
    .unwrap();
    let outcome = engine.start(spec, "test", None).unwrap();
    assert_eq!(
        outcome.completion_reason,
        Some(RunCompletionReason::BudgetExceeded)
    );
    let entries = engine.journal_entries(&outcome.run_id, 1, 100).unwrap();
    let completions: Vec<_> = entries
        .iter()
        .filter(|e| e.entry_type == EntryType::StepCompleted)
        .collect();
    assert_eq!(completions.len(), 1);
    assert_eq!(completions[0].payload["spend"]["tokens_input"], 0);
    assert!(
        completions[0].payload["spend"]["wallclock_ms"]
            .as_u64()
            .unwrap()
            > 0
    );
}

#[test]
fn daily_windows_reset_and_exact_limits_do_not_refuse() {
    use relayflowd_core::{Action, AttemptResult, RunState, completion_actions, next_actions};
    for (window, limit, now, exceeded) in [
        ("day", "0.005", 10, true),
        ("day", "0.005", 86_400_000, false),
        ("day", "0.006", 10, false),
    ] {
        let spec = RunSpec::parse(
            &json!({"budget":{"max_dollars":limit,"window":window},"steps":[
                {"id":"first","type":"llm","prompt":"answer"},
                {"id":"second","type":"deterministic","command":":","depends_on":["first"]}
            ]}),
        )
        .unwrap();
        let initial = RunState::fold("run", spec.clone(), &[]).unwrap();
        let mut entries: Vec<_> = next_actions(&initial, 0)
            .into_iter()
            .filter_map(|a| {
                if let Action::Append(e) = a {
                    Some(e)
                } else {
                    None
                }
            })
            .collect();
        let mut result = AttemptResult::successful(json!("answer"), "mock");
        result.budget = Budget {
            tokens_in: 1000,
            tokens_out: 200,
            dollars: "0.006".into(),
            dollars_unmetered: false,
        };
        entries.extend(
            completion_actions("run", &spec.steps[0], 1, 0, result, 1)
                .into_iter()
                .filter_map(|a| {
                    if let Action::Append(e) = a {
                        Some(e)
                    } else {
                        None
                    }
                }),
        );
        let replay = RunState::fold("run", spec, &entries).unwrap();
        assert_eq!(
            relayflowd_core::machine::budget_exceeded(&replay, now),
            exceeded
        );
        assert_eq!(replay.memo["first"], json!("answer"));
    }
}

/// Complete the leased `first` llm step with `budget`, returning the outcome.
fn complete_first(
    engine: &Engine<relayflowd::clock::WallClock>,
    worker: &Worker,
    run_id: &str,
    budget: Budget,
) -> anyhow::Result<relayflowd::RunOutcome> {
    let d = worker.0.lock().unwrap()[0].clone();
    engine.complete_out_of_band(
        run_id,
        "first",
        OutOfBandCompletion {
            human_intervention: false,
            attempt: d.attempt,
            idempotency_key: d.idempotency_key,
            completion_reason: CompletionReason::Success,
            output: json!("answer"),
            budget,
            completed_by: "mock".into(),
            started_pins: None,
            end_pins: None,
            effects: vec![],
            trajectory_tail: None,
        },
    )
}

fn unmetered(tokens_in: u64, tokens_out: u64) -> Budget {
    Budget {
        tokens_in,
        tokens_out,
        dollars_unmetered: true,
        ..Budget::default()
    }
}

#[test]
fn unmetered_spend_is_journaled_as_unknown_and_never_crosses_a_dollar_ceiling() {
    let dir = tempfile::tempdir().unwrap();
    let worker = Arc::new(Worker::default());
    let engine = Engine::with_runtime(dir.path(), worker.clone(), worker.clone());
    let spec = RunSpec::parse(&json!({"budget":{"max_dollars":"0.001"},"steps":[
        {"id":"first","type":"llm","prompt":"answer"},
        {"id":"second","type":"deterministic","command":"printf ran","depends_on":["first"]}
    ]}))
    .unwrap();
    let started = engine.start(spec, "test", None).unwrap();
    let outcome = complete_first(
        &engine,
        &worker,
        &started.run_id,
        unmetered(1_000_000, 1_000_000),
    )
    .unwrap();
    assert_eq!(
        outcome.completion_reason,
        Some(RunCompletionReason::Success)
    );

    let entries = Engine::new(dir.path())
        .journal_entries(&started.run_id, 1, 100)
        .unwrap();
    let completed = entries
        .iter()
        .find(|e| e.entry_type == EntryType::StepCompleted && e.step_id.as_deref() == Some("first"))
        .unwrap();
    assert_eq!(completed.payload["budget"]["dollars_unmetered"], true);
    assert_eq!(completed.payload["spend"]["dollars_unmetered"], true);
    assert_eq!(completed.payload["spend"]["tokens_input"], 1_000_000);
    let second = entries
        .iter()
        .find(|e| {
            e.entry_type == EntryType::StepCompleted && e.step_id.as_deref() == Some("second")
        })
        .unwrap();
    assert!(second.payload["spend"].get("dollars_unmetered").is_none());
    let run = entries
        .iter()
        .find(|e| e.entry_type == EntryType::RunCompleted)
        .unwrap();
    assert_eq!(run.payload["budget_total"]["tokens_in"], 1_000_000);
    assert_eq!(run.payload["budget_total"]["dollars_unmetered"], true);
}

#[test]
fn unmetered_tokens_still_cross_a_token_ceiling() {
    let dir = tempfile::tempdir().unwrap();
    let worker = Arc::new(Worker::default());
    let engine = Engine::with_runtime(dir.path(), worker.clone(), worker.clone());
    let spec = RunSpec::parse(&json!({"budget":{"max_tokens":100,"max_dollars":"1"},"steps":[
        {"id":"first","type":"llm","prompt":"answer"},
        {"id":"second","type":"deterministic","command":"printf must-not-run","depends_on":["first"]}
    ]}))
    .unwrap();
    let started = engine.start(spec, "test", None).unwrap();
    let outcome = complete_first(&engine, &worker, &started.run_id, unmetered(80, 40)).unwrap();
    assert_eq!(
        outcome.completion_reason,
        Some(RunCompletionReason::BudgetExceeded)
    );
}

#[test]
fn unmetered_usage_may_not_claim_priced_dollars() {
    let dir = tempfile::tempdir().unwrap();
    let worker = Arc::new(Worker::default());
    let engine = Engine::with_runtime(dir.path(), worker.clone(), worker.clone());
    let spec = RunSpec::parse(&json!({"budget":{"max_dollars":"1"},"steps":[
        {"id":"first","type":"llm","prompt":"answer"}
    ]}))
    .unwrap();
    let started = engine.start(spec, "test", None).unwrap();
    let claimed = Budget {
        dollars: "0.5".into(),
        ..unmetered(1, 1)
    };
    let error = complete_first(&engine, &worker, &started.run_id, claimed).unwrap_err();
    assert!(error.to_string().contains("dollars_unmetered"), "{error}");
    let zero = Budget {
        dollars: "0.000000".into(),
        ..unmetered(1, 1)
    };
    assert!(complete_first(&engine, &worker, &started.run_id, zero).is_ok());
}

#[test]
fn metering_flag_is_additive_on_the_wire() {
    // Journals written before the flag (including #421's zero-dollar unpriced
    // steps) decode as metered; metered charges serialize without the key.
    let legacy: Budget =
        serde_json::from_value(json!({"tokens_in":1,"tokens_out":2,"dollars":"0.000000"})).unwrap();
    assert!(!legacy.dollars_unmetered);
    assert!(
        serde_json::to_value(&legacy)
            .unwrap()
            .get("dollars_unmetered")
            .is_none()
    );
    let wire: Budget =
        serde_json::from_value(json!({"tokens_in":1,"tokens_out":2,"dollars_unmetered":true}))
            .unwrap();
    assert_eq!(wire, unmetered(1, 2));
}
