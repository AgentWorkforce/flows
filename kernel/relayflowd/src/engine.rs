use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result, anyhow, bail};
use relayflowd_core::{
    Clock, EntryType, Journal, JournalEntry, RunSpawnedPayload, RunSpec, RunState, StepKind,
    recovery_actions_filtered,
};
use relayflowd_journal::{Registry, SqliteJournal};
use sha2::{Digest, Sha256};
use ulid::Ulid;

use crate::clock::WallClock;
use crate::worker::{JournalObserver, StepDispatcher};

mod drive;
mod effects;
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
        self.resume_filtered(run_id, options, &|_, _| false)
    }

    /// Shared resume path. `lease_is_active(step_id, attempt)` marks attempts
    /// that still have a live worker lease; those are left running instead of
    /// being presumed dead. Offline resume passes a constant `false`: with no
    /// server, no lease can be live.
    pub(crate) fn resume_filtered(
        &self,
        run_id: &str,
        options: DriveOptions,
        lease_is_active: &dyn Fn(&str, u32) -> bool,
    ) -> Result<RunOutcome> {
        let mut journal = self.open_run(run_id)?;
        let registry = self.registry()?;
        if registry.lookup(run_id)?.is_none() {
            registry
                .register(run_id, &self.run_path(run_id))
                .context("repair missing run registry entry")?;
        }
        let spec = journal.run_spec().context("read run spec")?;
        let state = self.load_state(&journal, spec.clone())?;
        for action in recovery_actions_filtered(&state, self.clock.now_ms(), lease_is_active) {
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

    fn prepare_start_entry(&self, state: &RunState, entry: &mut JournalEntry) -> Result<()> {
        if entry.entry_type != EntryType::StepAttemptStarted {
            return Ok(());
        }
        let mut payload: relayflowd_core::AttemptStartedPayload =
            serde_json::from_value(entry.payload.clone())?;
        if payload.step_type != relayflowd_core::StepType::Agent {
            return Ok(());
        }
        let step_id = entry
            .step_id
            .as_deref()
            .context("agent start has no step id")?;
        let step = state
            .spec
            .step(step_id)
            .with_context(|| format!("run has no step {step_id}"))?;
        payload.pins = self.resolve_agent_pins(step, &payload.pins)?;
        validate_agent_pins(step, &payload.pins)?;
        entry.payload = serde_json::to_value(payload)?;
        Ok(())
    }

    /// Complete a step's start pins. The state machine has already carried
    /// forward every declared surface the run's pin chain covers (Appendix A
    /// rule 6); the gaps are surfaces this run has never pinned, and only the
    /// worker holding them can report their revision (rule 2). Consecutive
    /// agent steps may therefore declare entirely different surfaces.
    fn resolve_agent_pins(
        &self,
        step: &relayflowd_core::StepSpec,
        carried: &relayflowd_core::Pins,
    ) -> Result<relayflowd_core::Pins> {
        let StepKind::Agent { surfaces, .. } = &step.kind else {
            return Ok(carried.clone());
        };
        let covered = surfaces.workspace.iter().all(|declared| {
            carried
                .workspace
                .iter()
                .any(|pin| pin.surface == declared.surface)
        }) && surfaces.streams.iter().all(|declared| {
            carried
                .streams
                .iter()
                .any(|pin| pin.stream == declared.stream)
        });
        // Only ask the worker when the chain leaves a gap; a fully covered step
        // must not depend on a worker still holding a surface it once reported.
        let worker = if covered {
            relayflowd_core::Pins::default()
        } else {
            self.dispatcher
                .as_ref()
                .context("agent dispatch requires an attached worker")?
                .starting_pins(step)?
        };
        // Project onto the declared surfaces, in declared order: a surface this
        // step does not declare is outside its contract (Appendix A rule 1) and
        // must not be journaled as one of its pins, however the chain got it.
        Ok(relayflowd_core::Pins {
            workspace: surfaces
                .workspace
                .iter()
                .filter_map(|declared| {
                    carried
                        .workspace
                        .iter()
                        .chain(worker.workspace.iter())
                        .find(|pin| pin.surface == declared.surface)
                        .cloned()
                })
                .collect(),
            streams: surfaces
                .streams
                .iter()
                .filter_map(|declared| {
                    carried
                        .streams
                        .iter()
                        .chain(worker.streams.iter())
                        .find(|pin| pin.stream == declared.stream)
                        .cloned()
                })
                .collect(),
        })
    }

    /// Preflight for Appendix A rule 2: can the attached worker pin every
    /// surface this agent step declares that the chain has not already pinned?
    /// A worker that cannot is not a compatible worker for this step — the run
    /// parks until one that can attaches, rather than failing mid-drive with an
    /// untyped error after `run.start` has already journaled the spawn.
    pub(super) fn agent_pins_available(
        &self,
        state: &RunState,
        step: &relayflowd_core::StepSpec,
    ) -> bool {
        let carried = relayflowd_core::carried_pins_for(state.current_pins.as_ref(), step);
        let carried = state.steps[&step.id]
            .last_start_pins
            .clone()
            .unwrap_or(carried);
        self.resolve_agent_pins(step, &carried)
            .is_ok_and(|pins| validate_agent_pins(step, &pins).is_ok())
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

fn validate_agent_pins(
    step: &relayflowd_core::StepSpec,
    pins: &relayflowd_core::Pins,
) -> Result<()> {
    let StepKind::Agent { surfaces, .. } = &step.kind else {
        return Ok(());
    };
    let expected_workspace = surfaces
        .workspace
        .iter()
        .map(|surface| surface.surface.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let actual_workspace = pins
        .workspace
        .iter()
        .map(|pin| pin.surface.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let expected_streams = surfaces
        .streams
        .iter()
        .map(|surface| surface.stream.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let actual_streams = pins
        .streams
        .iter()
        .map(|pin| pin.stream.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    if expected_workspace != actual_workspace
        || expected_streams != actual_streams
        || expected_workspace.len() != pins.workspace.len()
        || expected_streams.len() != pins.streams.len()
    {
        bail!(
            "agent step {} pins do not cover its declared workspace and stream surfaces",
            step.id
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
