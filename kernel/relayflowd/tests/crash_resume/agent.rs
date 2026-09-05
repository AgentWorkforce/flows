use std::{
    fs,
    os::unix::process::CommandExt,
    process::Command,
    time::{Duration, Instant},
};

use relayflowd::{RunOutcome, RunStatus};
use relayflowd_core::{
    AttemptStartedPayload, Budget, CompletionReason, EffectRecordedPayload, EntryType,
    RunCompletedPayload, StepCompletedPayload,
};

use super::{
    agent_support::{
        AgentFixture, attached_worker, complete, elect_effect, record_effect, spawn_resume,
        start_run,
    },
    support::{
        completed_step_count, describe_stalled_resume, journal_entries, kill_group,
        kill_process_group, read_pid, resume_cli, wait_until,
    },
};

#[test]
fn rung_c_reset_sigkill_mid_edit_restores_pins_dedupes_effect_and_explains_attempts() {
    let fixture = AgentFixture::new("reset-mid-edit", "reset");
    let mut server = fixture.server();
    let mut worker = attached_worker(&fixture, "first-agent-stub");
    let run_id = start_run(&fixture);
    let first = worker.event("step.dispatch").unwrap();
    assert_eq!(first["attempt"], 1);
    assert_eq!(first["pins"]["workspace"][0]["revision_id"], "rev-clean");
    assert!(!record_effect(&fixture, &mut worker, &first).unwrap());
    assert_eq!(fixture.provider_call_count(), 1);

    server.kill();
    drop(worker);
    let _restarted = fixture.server();
    let mut replacement = attached_worker(&fixture, "replacement-agent-stub");
    let resume = spawn_resume(&fixture, &run_id);
    let second = replacement.event("step.dispatch").unwrap();
    assert_eq!(second["attempt"], 2);
    assert_eq!(second["pins"], first["pins"]);
    assert_eq!(second["recovery"]["mode"], "reset");
    assert_eq!(second["recovery"]["restore_pins"], first["pins"]);
    assert!(matches!(
        second["recovery"]["previous_completion_reason"].as_str(),
        Some("crashed" | "lease_expired")
    ));
    assert!(record_effect(&fixture, &mut replacement, &second).unwrap());
    assert_eq!(fixture.provider_call_count(), 1);
    assert_eq!(
        complete(&mut replacement, &second).unwrap()["status"],
        "completed"
    );
    let output = resume.wait_with_output().unwrap();
    assert!(output.status.success(), "resume failed: {output:?}");
    let outcome: RunOutcome = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(outcome.status, RunStatus::Completed);
    assert_eq!(
        fs::read_to_string(&fixture.marker).unwrap(),
        "first\nfinish\n"
    );

    let entries = journal_entries(&fixture.data_dir).unwrap();
    let starts = entries
        .iter()
        .filter(|entry| {
            entry.entry_type == EntryType::StepAttemptStarted
                && entry.step_id.as_deref() == Some("agent")
        })
        .map(|entry| {
            serde_json::from_value::<AttemptStartedPayload>(entry.payload.clone()).unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(starts.len(), 2);
    assert_eq!(starts[0].pins, starts[1].pins);
    assert_eq!(starts[0].idempotency_key, starts[1].idempotency_key);

    let effects = entries
        .iter()
        .filter(|entry| entry.entry_type == EntryType::EffectRecorded)
        .map(|entry| {
            serde_json::from_value::<EffectRecordedPayload>(entry.payload.clone()).unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(effects.len(), 2);
    assert!(!effects[0].deduped);
    assert!(effects[1].deduped);

    let completions = agent_completions(&entries);
    assert_eq!(completions.len(), 2);
    assert!(matches!(
        completions[0].completion_reason,
        CompletionReason::Crashed | CompletionReason::LeaseExpired
    ));
    assert_eq!(completions[1].completion_reason, CompletionReason::Success);
    assert_exact_agent_budget(&entries);
}

#[test]
fn rung_c_sigkill_boundaries_resume_only_unfinished_steps_via_real_cli() {
    for (label, pause_before, durable_before_kill) in [
        ("before-first", "first", 0),
        ("between-first-agent", "agent", 1),
    ] {
        let fixture = AgentFixture::new(label, "reset");
        let mut run = Command::new(env!("CARGO_BIN_EXE_relayflowd"))
            .args([
                "--data-dir",
                fixture.data_dir.to_str().unwrap(),
                "run",
                fixture.spec_path.to_str().unwrap(),
                "--pause-before-step",
                pause_before,
            ])
            .process_group(0)
            .spawn()
            .unwrap();
        wait_until(label, || {
            journal_entries(&fixture.data_dir)
                .is_some_and(|entries| completed_step_count(&entries) == durable_before_kill)
        });
        kill_process_group(&mut run);

        let _server = fixture.server();
        let mut worker = attached_worker(&fixture, "boundary-agent-stub");
        let run_id = super::support::only_run_id(&fixture.data_dir);
        let mut resume = spawn_resume(&fixture, &run_id);
        // Do not `.unwrap()` this. A missing dispatch is #174, and the whole
        // difficulty there has been that the failure carries no daemon-side
        // state -- so capture it here rather than losing it to the unwind.
        // This fires on ANY protocol error, not only a timeout; the dump is
        // useful either way, since it reports whether the child is stalled or
        // already gone.
        let dispatch = match worker.event("step.dispatch") {
            Ok(dispatch) => dispatch,
            Err(error) => panic!(
                "{label}: no step.dispatch after resume: {error}{}",
                describe_stalled_resume(&fixture.data_dir, &mut resume)
            ),
        };
        assert!(!record_effect(&fixture, &mut worker, &dispatch).unwrap());
        complete(&mut worker, &dispatch).unwrap();
        let output = resume.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{label}: resume failed: {output:?}"
        );
        assert_eq!(
            fs::read_to_string(&fixture.marker).unwrap(),
            "first\nfinish\n"
        );
        assert_eq!(fixture.provider_call_count(), 1);
        let entries = journal_entries(&fixture.data_dir).unwrap();
        assert_eq!(agent_completions(&entries).len(), 1);
        assert_exact_agent_budget(&entries);
    }
}

#[test]
fn rung_c_sigkill_after_final_effect_replays_results_without_redispatch() {
    let fixture = AgentFixture::new("after-final", "reset");
    let mut server = fixture.server();
    let mut worker = attached_worker(&fixture, "final-agent-stub");
    start_run(&fixture);
    let dispatch = worker.event("step.dispatch").unwrap();
    assert!(!record_effect(&fixture, &mut worker, &dispatch).unwrap());
    assert_eq!(
        complete(&mut worker, &dispatch).unwrap()["status"],
        "completed"
    );
    let before = journal_entries(&fixture.data_dir).unwrap();
    let starts_before = before
        .iter()
        .filter(|entry| entry.entry_type == EntryType::StepAttemptStarted)
        .count();
    server.kill();

    assert_eq!(resume_cli(&fixture.data_dir).status, RunStatus::Completed);
    let after = journal_entries(&fixture.data_dir).unwrap();
    assert_eq!(
        after
            .iter()
            .filter(|entry| entry.entry_type == EntryType::StepAttemptStarted)
            .count(),
        starts_before
    );
    assert_eq!(fixture.provider_call_count(), 1);
    assert_exact_agent_budget(&after);
}

#[test]
fn rung_c_sigkill_between_agent_completion_and_final_effect_memoizes_the_agent() {
    let fixture = AgentFixture::blocking_finish("between-agent-finish", "reset");
    let mut server = fixture.server();
    let mut worker = attached_worker(&fixture, "between-agent-stub");
    start_run(&fixture);
    let dispatch = worker.event("step.dispatch").unwrap();
    assert!(!record_effect(&fixture, &mut worker, &dispatch).unwrap());
    let completion = std::thread::spawn(move || complete(&mut worker, &dispatch));
    wait_until("final step to start after the agent", || {
        fixture.finish_pid.exists()
    });
    server.kill();
    kill_group(read_pid(&fixture.finish_pid));
    let _ = completion.join().unwrap();
    fs::write(&fixture.finish_gate, b"open").unwrap();

    assert_eq!(resume_cli(&fixture.data_dir).status, RunStatus::Completed);
    assert_eq!(fixture.provider_call_count(), 1);
    assert_eq!(
        fs::read_to_string(&fixture.marker).unwrap(),
        "first\nfinish\n"
    );
    let entries = journal_entries(&fixture.data_dir).unwrap();
    assert_eq!(agent_completions(&entries).len(), 1);
    let finish_starts = entries
        .iter()
        .filter(|entry| {
            entry.entry_type == EntryType::StepAttemptStarted
                && entry.step_id.as_deref() == Some("finish")
        })
        .count();
    assert_eq!(
        finish_starts, 2,
        "only the unfinished final step is retried"
    );
    assert_exact_agent_budget(&entries);
}

/// Appendix A rule 5 at its hardest boundary: the worker is SIGKILLed *after*
/// the journal elected it to perform the writeback and *before* it called the
/// provider. A one-phase election would have marked the effect done and every
/// retry would have skipped it, so the run would complete with the declared
/// effect never having happened. Election alone must not suppress: the
/// unconfirmed election is reclaimed and the effect happens exactly once.
#[test]
fn rung_c_crash_between_effect_election_and_the_provider_call_performs_it_exactly_once() {
    let fixture = AgentFixture::new("elect-then-crash", "reset");
    let mut server = fixture.server();
    let mut worker = attached_worker(&fixture, "electing-agent-stub");
    let run_id = start_run(&fixture);
    let first = worker.event("step.dispatch").unwrap();
    assert_eq!(first["attempt"], 1);

    // Elected, then dead: no provider call, no confirmation.
    assert!(!elect_effect(&mut worker, &first).unwrap());
    assert_eq!(fixture.provider_call_count(), 0);
    server.kill();
    drop(worker);

    let _restarted = fixture.server();
    let mut replacement = attached_worker(&fixture, "replacement-agent-stub");
    let resume = spawn_resume(&fixture, &run_id);
    let second = replacement.event("step.dispatch").unwrap();
    assert_eq!(second["attempt"], 2);
    // The unconfirmed election does not permanently suppress the effect: this
    // attempt reclaims it, performs it, and confirms.
    assert!(
        !record_effect(&fixture, &mut replacement, &second).unwrap(),
        "an election nobody confirmed must be reclaimable"
    );
    assert_eq!(fixture.provider_call_count(), 1);
    assert_eq!(
        complete(&mut replacement, &second).unwrap()["status"],
        "completed"
    );
    let output = resume.wait_with_output().unwrap();
    assert!(output.status.success(), "resume failed: {output:?}");
    let outcome: RunOutcome = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(outcome.status, RunStatus::Completed);

    // Exactly one provider call across both attempts, and the journal explains
    // both: attempt 1 elected and was not deduped, attempt 2 reclaimed.
    assert_eq!(fixture.provider_call_count(), 1);
    let entries = journal_entries(&fixture.data_dir).unwrap();
    let effects = entries
        .iter()
        .filter(|entry| entry.entry_type == EntryType::EffectRecorded)
        .map(|entry| {
            (
                entry.attempt,
                serde_json::from_value::<EffectRecordedPayload>(entry.payload.clone()).unwrap(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(effects.len(), 2);
    assert!(!effects[0].1.deduped, "attempt 1 won the election");
    assert!(!effects[1].1.deduped, "attempt 2 reclaimed it");
    let confirmations = entries
        .iter()
        .filter(|entry| entry.entry_type == EntryType::EffectConfirmed)
        .map(|entry| entry.attempt)
        .collect::<Vec<_>>();
    assert_eq!(
        confirmations,
        vec![Some(2)],
        "only the attempt that called the provider confirms"
    );
    let completions = agent_completions(&entries);
    assert_eq!(completions.len(), 2);
    assert!(matches!(
        completions[0].completion_reason,
        CompletionReason::Crashed | CompletionReason::LeaseExpired
    ));
    assert_eq!(completions[1].completion_reason, CompletionReason::Success);
    assert_exact_agent_budget(&entries);
}

fn agent_completions(entries: &[relayflowd_core::JournalEntry]) -> Vec<StepCompletedPayload> {
    entries
        .iter()
        .filter(|entry| {
            entry.entry_type == EntryType::StepCompleted
                && entry.step_id.as_deref() == Some("agent")
        })
        .map(|entry| serde_json::from_value(entry.payload.clone()).unwrap())
        .collect()
}

fn assert_exact_agent_budget(entries: &[relayflowd_core::JournalEntry]) {
    let completed = entries
        .iter()
        .find(|entry| entry.entry_type == EntryType::RunCompleted)
        .expect("run has a declared terminal entry");
    let completed: RunCompletedPayload = serde_json::from_value(completed.payload.clone()).unwrap();
    assert_eq!(
        completed.budget_total,
        Budget {
            tokens_in: 13,
            tokens_out: 5,
            dollars: "0.003".to_owned(),
        },
        "resumed spend equals one successful agent execution"
    );
}

/// P1-1 regression, through the real CLI over the real socket. A run parked
/// because no worker is attached must answer `resume` immediately: `parked`
/// says "nothing is coming until something changes", while `waiting_worker`
/// makes `resume_via_socket` poll for an out-of-band completion for 30s and
/// then die with a raw, undeclared error. The unit test asserts the registry
/// row; only this one exercises the path that read it wrong.
#[test]
fn resume_without_a_worker_parks_immediately_instead_of_timing_out() {
    let fixture = AgentFixture::new("no-worker", "reset");
    let _server = fixture.server();
    // No agent worker ever attaches: the deterministic `first` step runs, then
    // the agent step parks with nothing to dispatch it to.
    let run_id = start_run(&fixture);

    let started = Instant::now();
    let output = Command::new(env!("CARGO_BIN_EXE_relayflowd"))
        .args([
            "--data-dir",
            fixture.data_dir.to_str().unwrap(),
            "resume",
            &run_id,
        ])
        .output()
        .unwrap();
    let elapsed = started.elapsed();
    assert!(
        output.status.success(),
        "resume on a worker-less run must not fail: {output:?}"
    );
    let outcome: RunOutcome = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(outcome.status, RunStatus::Parked);
    assert!(
        elapsed < Duration::from_secs(10),
        "resume must not wait for a completion that cannot arrive (took {elapsed:?})"
    );
}
