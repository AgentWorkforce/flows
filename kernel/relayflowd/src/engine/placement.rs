use super::Engine;
use anyhow::{Context, Result, bail};
use relayflowd_core::{
    AttemptStartedPayload, Clock, EntryType, ExecutionMode, JournalEntry, RoutingDecision,
    RunState, StepType,
};
use relayflowd_journal::SqliteJournal;
use std::path::Path;

impl<C: Clock> Engine<C> {
    pub(super) fn preflight_placement(&self, spec: &relayflowd_core::RunSpec) -> Result<()> {
        for step in &spec.steps {
            if step.step_type() != StepType::Deterministic {
                continue;
            }
            if let Some(requirements) = &step.requirements {
                if requirements.execution == Some(ExecutionMode::Interactive) {
                    bail!(
                        "step {} requires interactive execution; local deterministic executor supports batch only",
                        step.id
                    );
                }
                if requirements.workspace != Some(false) {
                    crate::workspace::pin(&std::env::current_dir()?)?;
                }
            }
        }
        Ok(())
    }

    /// Bind declared local workspaces at submission, before a pause/crash can
    /// make a later step inherit the cwd of a different daemon process.
    pub(super) fn bind_local_workspaces(
        &self,
        journal: &mut SqliteJournal,
        spec: &relayflowd_core::RunSpec,
    ) -> Result<()> {
        for step in &spec.steps {
            if step.step_type() != StepType::Deterministic
                || !step
                    .requirements
                    .as_ref()
                    .is_some_and(|r| r.workspace != Some(false))
            {
                continue;
            }
            let pin = crate::workspace::pin(&std::env::current_dir()?)?;
            let route = RoutingDecision {
                profile: "batch".into(),
                provider: "local".into(),
                fallbacks_attempted: vec![],
                workspace: Some(pin.surface),
            };
            self.append(
                journal,
                &JournalEntry::new(
                    EntryType::StepRouted,
                    journal.run_id().to_owned(),
                    Some(step.id.clone()),
                    None,
                    self.clock.now_ms(),
                    route,
                ),
            )?;
        }
        Ok(())
    }

    /// Persist the decision before the attempt starts. If that append succeeds
    /// but the process dies before start, replay uses the decision already made.
    pub(super) fn route_start(
        &self,
        journal: &mut SqliteJournal,
        state: &RunState,
        entry: &mut JournalEntry,
    ) -> Result<()> {
        if entry.entry_type != EntryType::StepAttemptStarted {
            return Ok(());
        }
        let step_id = entry.step_id.as_deref().context("start has no step")?;
        let step = state
            .spec
            .step(step_id)
            .context("start names unknown step")?;
        let mut start: AttemptStartedPayload = serde_json::from_value(entry.payload.clone())?;
        let route = if let Some(route) = state.routing.get(step_id) {
            route.clone()
        } else {
            let route = if step.step_type() == StepType::Deterministic {
                if step.requirements.as_ref().and_then(|r| r.execution)
                    == Some(ExecutionMode::Interactive)
                {
                    bail!(
                        "step {step_id} requires interactive execution; local deterministic executor supports batch only"
                    );
                }
                let workspace = if step
                    .requirements
                    .as_ref()
                    .is_some_and(|r| r.workspace != Some(false))
                {
                    Some(
                        match state
                            .routing
                            .values()
                            .find(|r| r.provider == "local" && r.workspace.is_some())
                        {
                            Some(route) => route.workspace.clone().unwrap(),
                            None => std::env::current_dir()?
                                .canonicalize()?
                                .to_str()
                                .context("workspace path is not UTF-8")?
                                .to_owned(),
                        },
                    )
                } else {
                    None
                };
                RoutingDecision {
                    profile: "batch".into(),
                    provider: "local".into(),
                    fallbacks_attempted: vec![],
                    workspace,
                }
            } else {
                self.dispatcher
                    .as_ref()
                    .context("placement requires a worker")?
                    .routing_decision(
                        &state.run_id,
                        step,
                        entry.attempt.context("start has no attempt")?,
                    )?
            };
            route
                .validate()
                .map_err(anyhow::Error::msg)
                .with_context(|| format!("invalid routing decision for step {step_id}"))?;
            // Resolve source facts before appending the routing decision.
            if route.provider == "local"
                && let Some(path) = &route.workspace
            {
                crate::workspace::pin(Path::new(path))?;
            }
            self.append(
                journal,
                &JournalEntry::new(
                    EntryType::StepRouted,
                    &state.run_id,
                    Some(step_id.to_owned()),
                    None,
                    self.clock.now_ms(),
                    &route,
                ),
            )?;
            route
        };
        if step.step_type() == StepType::Deterministic {
            if route.provider != "local" {
                bail!("local executor cannot execute provider {}", route.provider);
            }
            if let Some(path) = &route.workspace {
                start.pins.workspace = vec![crate::workspace::pin(Path::new(path))?];
            }
        }
        entry.payload = serde_json::to_value(start)?;
        Ok(())
    }
}
