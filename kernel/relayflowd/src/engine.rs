use std::{
    path::{Path, PathBuf},
    sync::Arc,
    thread,
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail};
use relayflowd_core::{
    Action, Clock, EntryType, Journal, JournalEntry, RunCompletionReason, RunSpawnedPayload,
    RunSpec, RunState, StepKind, completion_actions, next_actions, recovery_actions,
};
use relayflowd_journal::{Registry, SqliteJournal};
use sha2::{Digest, Sha256};
use ulid::Ulid;

use crate::worker::{JournalObserver, StepDispatch, StepDispatcher};
use crate::{clock::WallClock, exec_det};

mod model;
mod remote;
pub use model::{RunOutcome, RunSnapshot, RunStatus};
use model::{outcome_from_state, snapshot_from_state};
pub use remote::OutOfBandCompletion;

#[derive(Debug, Clone, Default)]
#[doc(hidden)]
pub struct DriveOptions {
    pub stop_after: Option<usize>,
    /// Test/debug hook: pause immediately before this runnable step starts.
    pub pause_before_step: Option<String>,
    /// Test/debug hook: pause after every step is durable, before run completion.
    pub pause_before_completion: bool,
}

pub struct Engine<C = WallClock> {
    data_dir: PathBuf,
    clock: C,
    dispatcher: Option<Arc<dyn StepDispatcher>>,
    observer: Option<Arc<dyn JournalObserver>>,
}

impl Engine<WallClock> {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            clock: WallClock,
            dispatcher: None,
            observer: None,
        }
    }

    pub fn with_runtime(
        data_dir: impl Into<PathBuf>,
        dispatcher: Arc<dyn StepDispatcher>,
        observer: Arc<dyn JournalObserver>,
    ) -> Self {
        Self {
            data_dir: data_dir.into(),
            clock: WallClock,
            dispatcher: Some(dispatcher),
            observer: Some(observer),
        }
    }
}

impl<C: Clock> Engine<C> {
    pub fn with_clock(data_dir: impl Into<PathBuf>, clock: C) -> Self {
        Self {
            data_dir: data_dir.into(),
            clock,
            dispatcher: None,
            observer: None,
        }
    }

    pub fn start(
        &self,
        spec: RunSpec,
        created_by: &str,
        stop_after: Option<usize>,
    ) -> Result<RunOutcome> {
        self.start_with_options(
            spec,
            created_by,
            DriveOptions {
                stop_after,
                ..DriveOptions::default()
            },
        )
    }

    #[doc(hidden)]
    pub fn start_with_options(
        &self,
        spec: RunSpec,
        created_by: &str,
        options: DriveOptions,
    ) -> Result<RunOutcome> {
        spec.validate().context("invalid run spec")?;
        ensure_supported(&spec)?;
        let run_id = Ulid::new().to_string();
        let path = self.run_path(&run_id);
        let now_ms = self.clock.now_ms();
        let mut journal =
            SqliteJournal::create(&path, &run_id, now_ms).context("create run journal")?;
        let spec_value = serde_json::to_value(&spec)?;
        self.append(
            &mut journal,
            &JournalEntry::new(
                EntryType::RunSpawned,
                run_id.clone(),
                None,
                None,
                now_ms,
                RunSpawnedPayload {
                    spec: spec_value.clone(),
                    spec_hash: canonical_hash(&spec_value),
                    parent_run_id: None,
                    journal_version: relayflowd_core::JOURNAL_VERSION,
                    created_by: created_by.to_owned(),
                },
            ),
        )?;
        self.registry()?
            .register(&run_id, &path)
            .context("register run")?;
        self.drive(journal, spec, options)
    }

    pub fn resume(&self, run_id: &str, stop_after: Option<usize>) -> Result<RunOutcome> {
        self.resume_with_options(
            run_id,
            DriveOptions {
                stop_after,
                ..DriveOptions::default()
            },
        )
    }

    #[doc(hidden)]
    pub fn resume_with_options(&self, run_id: &str, options: DriveOptions) -> Result<RunOutcome> {
        let mut journal = self.open_run(run_id)?;
        let registry = self.registry()?;
        if registry.lookup(run_id)?.is_none() {
            registry
                .register(run_id, &self.run_path(run_id))
                .context("repair missing run registry entry")?;
        }
        let spec = journal.run_spec().context("read run spec")?;
        ensure_supported(&spec)?;
        let state = self.load_state(&journal, spec.clone())?;
        for action in recovery_actions(&state, self.clock.now_ms()) {
            self.persist_only(&mut journal, action)?;
        }
        self.drive(journal, spec, options)
    }

    pub fn snapshot(&self, run_id: &str) -> Result<RunSnapshot> {
        let journal = self.open_run(run_id)?;
        let spec = journal.run_spec().context("read run spec")?;
        let state = self.load_state(&journal, spec)?;
        Ok(snapshot_from_state(&state))
    }

    pub fn journal_entries(
        &self,
        run_id: &str,
        from_seq: i64,
        limit: usize,
    ) -> Result<Vec<JournalEntry>> {
        self.open_run(run_id)?
            .scan_from(from_seq, limit)
            .context("read journal entries")
    }

    fn drive(
        &self,
        mut journal: SqliteJournal,
        spec: RunSpec,
        options: DriveOptions,
    ) -> Result<RunOutcome> {
        let initial_completed = self.load_state(&journal, spec.clone())?.completed_steps();
        let mut pause_consumed = false;
        loop {
            let state = self.load_state(&journal, spec.clone())?;
            if let Some(reason) = state.completion {
                return Ok(outcome_from_state(&state, reason));
            }
            if options.stop_after.is_some_and(|limit| {
                state.completed_steps().saturating_sub(initial_completed) >= limit
            }) {
                self.registry()?
                    .set_status(&state.run_id, "interrupted", None)?;
                return Ok(RunOutcome {
                    run_id: state.run_id.clone(),
                    status: RunStatus::Interrupted,
                    completion_reason: None,
                    completed_steps: state.completed_steps(),
                });
            }
            if !pause_consumed && should_pause(&state, &options) {
                pause_consumed = true;
                thread::sleep(Duration::from_secs(300));
            }

            if let Some(worker_class) = state.spec.steps.iter().find_map(|step| {
                matches!(
                    state.steps[&step.id].state,
                    relayflowd_core::StepState::Runnable
                )
                .then_some(step.step_type())
                .filter(|step_type| *step_type != relayflowd_core::StepType::Deterministic)
            }) && !self
                .dispatcher
                .as_ref()
                .is_some_and(|dispatcher| dispatcher.available(worker_class))
            {
                self.registry()?.set_status(&state.run_id, "parked", None)?;
                return Ok(RunOutcome {
                    run_id: state.run_id.clone(),
                    status: RunStatus::Parked,
                    completion_reason: None,
                    completed_steps: state.completed_steps(),
                });
            }

            let actions = next_actions(&state, self.clock.now_ms());
            if actions.is_empty() {
                self.registry()?.set_status(&state.run_id, "parked", None)?;
                return Ok(RunOutcome {
                    run_id: state.run_id.clone(),
                    status: RunStatus::Parked,
                    completion_reason: None,
                    completed_steps: state.completed_steps(),
                });
            }
            for action in actions {
                match action {
                    Action::Append(mut entry) => {
                        self.assign_executor(&mut entry)?;
                        self.append(&mut journal, &entry)?;
                    }
                    Action::ExecDeterministic { step, attempt } => {
                        let result = exec_det::execute(&step);
                        // Completed semantic executions before this attempt;
                        // crashed attempts are excluded so they never consume
                        // `max_iterations` allowance.
                        let semantic_executions = state.steps[&step.id].semantic_executions;
                        for action in completion_actions(
                            journal.run_id(),
                            &step,
                            attempt,
                            semantic_executions,
                            result,
                            self.clock.now_ms(),
                        ) {
                            self.interpret_non_execution(&mut journal, action)?;
                        }
                    }
                    Action::Dispatch {
                        step,
                        attempt,
                        worker_class,
                        lease_id,
                        idempotency_key,
                        lease_deadline_ms,
                        pins,
                    } => {
                        let assigned = self
                            .dispatcher
                            .as_ref()
                            .map(|dispatcher| {
                                dispatcher.dispatch(StepDispatch {
                                    run_id: state.run_id.clone(),
                                    step_id: step.id.clone(),
                                    attempt,
                                    step_type: worker_class,
                                    spec: step,
                                    lease_id,
                                    idempotency_key,
                                    pins,
                                    lease_deadline_ms,
                                })
                            })
                            .transpose()?
                            .unwrap_or(false);
                        self.registry()?.set_status(
                            &state.run_id,
                            if assigned { "waiting_worker" } else { "parked" },
                            Some(lease_deadline_ms),
                        )?;
                        return Ok(RunOutcome {
                            run_id: state.run_id.clone(),
                            status: RunStatus::Parked,
                            completion_reason: None,
                            completed_steps: state.completed_steps(),
                        });
                    }
                    Action::ArmTimer { at_ms } => {
                        // `next_actions` exposes every durable timer. This
                        // synchronous rung sleeps only until the earliest one,
                        // then reloads state before choosing more work.
                        self.wait_for_timer(&journal, at_ms)?;
                        break;
                    }
                    Action::CompleteRun { reason } => {
                        self.registry()?.set_status(
                            journal.run_id(),
                            if reason == RunCompletionReason::Success {
                                "completed"
                            } else {
                                "failed"
                            },
                            None,
                        )?;
                        let final_state = self.load_state(&journal, spec.clone())?;
                        return Ok(outcome_from_state(&final_state, reason));
                    }
                }
            }
        }
    }

    fn interpret_non_execution(&self, journal: &mut SqliteJournal, action: Action) -> Result<()> {
        match action {
            Action::Append(entry) => {
                self.append(journal, &entry)?;
            }
            Action::ArmTimer { at_ms } => self.wait_for_timer(journal, at_ms)?,
            _ => bail!("completion emitted an invalid execution action"),
        }
        Ok(())
    }

    fn persist_only(&self, journal: &mut SqliteJournal, action: Action) -> Result<()> {
        match action {
            Action::Append(entry) => {
                self.append(journal, &entry)?;
                Ok(())
            }
            _ => bail!("recovery emitted a non-journal action"),
        }
    }

    fn wait_for_timer(&self, journal: &SqliteJournal, at_ms: i64) -> Result<()> {
        self.registry()?
            .set_status(journal.run_id(), "sleeping", Some(at_ms))?;
        let remaining = at_ms.saturating_sub(self.clock.now_ms());
        if remaining > 0 {
            thread::sleep(Duration::from_millis(remaining as u64));
        }
        self.registry()?
            .set_status(journal.run_id(), "running", None)?;
        Ok(())
    }

    fn load_state(&self, journal: &SqliteJournal, spec: RunSpec) -> Result<RunState> {
        let segment = journal.current_segment().map_err(|error| anyhow!(error))?;
        let entries = journal
            .scan_segment(segment)
            .map_err(|error| anyhow!(error))?;
        RunState::fold(journal.run_id(), spec, &entries).context("fold run journal")
    }

    fn append(&self, journal: &mut SqliteJournal, entry: &JournalEntry) -> Result<JournalEntry> {
        let persisted = journal.append(entry).map_err(|error| anyhow!(error))?;
        if let Some(observer) = &self.observer {
            observer.appended(&persisted);
        }
        Ok(persisted)
    }

    fn assign_executor(&self, entry: &mut JournalEntry) -> Result<()> {
        if entry.entry_type != EntryType::StepAttemptStarted {
            return Ok(());
        }
        let mut payload: relayflowd_core::AttemptStartedPayload =
            serde_json::from_value(entry.payload.clone())?;
        if payload.step_type == relayflowd_core::StepType::Deterministic {
            return Ok(());
        }
        if let Some(executor) = self
            .dispatcher
            .as_ref()
            .and_then(|dispatcher| dispatcher.executor(payload.step_type))
        {
            payload.executor = executor;
            entry.payload = serde_json::to_value(payload)?;
        }
        Ok(())
    }

    fn open_run(&self, run_id: &str) -> Result<SqliteJournal> {
        let registered = self.registry()?.lookup(run_id)?;
        let path = registered
            .map(|record| record.file)
            .unwrap_or_else(|| self.run_path(run_id));
        SqliteJournal::open(&path).with_context(|| format!("open run journal {}", path.display()))
    }

    fn registry(&self) -> Result<Registry> {
        Registry::open(self.data_dir.join("relayflowd.sqlite3")).context("open run registry")
    }

    fn run_path(&self, run_id: &str) -> PathBuf {
        self.data_dir.join("runs").join(format!("{run_id}.sqlite3"))
    }
}

fn should_pause(state: &RunState, options: &DriveOptions) -> bool {
    if options.pause_before_completion && state.all_steps_succeeded() {
        return true;
    }
    let Some(step_id) = options.pause_before_step.as_deref() else {
        return false;
    };
    state.spec.steps.iter().find_map(|step| {
        matches!(
            state.steps[&step.id].state,
            relayflowd_core::StepState::Runnable
        )
        .then_some(step.id.as_str())
    }) == Some(step_id)
}

fn ensure_supported(spec: &RunSpec) -> Result<()> {
    if let Some(step) = spec
        .steps
        .iter()
        .find(|step| matches!(step.kind, StepKind::Agent { .. }))
    {
        bail!(
            "step {} is {:?}; agent dispatch is not available until gate-1 rung (c)",
            step.id,
            step.step_type()
        );
    }
    Ok(())
}

/// sha256 of the spec's canonical JSON. `serde_json::Value` objects are
/// BTreeMaps, so `to_vec` emits sorted keys with no whitespace — the same
/// canonical form the SDK's `canonicalize()` produces. Parity is pinned by
/// `relayflowd-core/tests/spec_parity.rs` and the SDK's `spec-parity` test
/// over the shared `testdata/` fixture.
fn canonical_hash(value: &serde_json::Value) -> String {
    let bytes = serde_json::to_vec(value).expect("run spec serializes");
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn read_spec(path: &Path) -> Result<RunSpec> {
    let bytes = std::fs::read(path).with_context(|| format!("read run spec {}", path.display()))?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .with_context(|| format!("parse run spec {}", path.display()))?;
    // Fail closed: unknown fields are an error, never a silently dropped gate.
    let spec =
        RunSpec::parse(&value).with_context(|| format!("parse run spec {}", path.display()))?;
    Ok(spec)
}
