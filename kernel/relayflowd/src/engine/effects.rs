//! Appendix A rules 3 and 5: an external effect is a journaled fact, and it
//! happens exactly once. Recording is two-phase — elect, perform, confirm — so
//! the election can never outlive a worker that died before calling its
//! provider. Split from `remote.rs` so the effect protocol reads on its own.

use anyhow::{Context, Result, bail};
use relayflowd_core::{
    Clock, CompletionReason, EffectConfirmedPayload, EffectRecordedPayload, EffectRef, EntryType,
    JournalEntry, StepKind, StepState,
};
use relayflowd_journal::SqliteJournal;

use super::{Engine, remote::OutOfBandCompletion};
use crate::clock::WallClock;

impl Engine<WallClock> {
    /// Phase one of Appendix A rule 5: elect one attempt to perform the
    /// writeback, before it calls its provider. The journal decides the winner
    /// atomically. `false` means this attempt owes the provider call and must
    /// [`confirm_effect`](Self::confirm_effect) once it has made it; `true`
    /// means a *confirmed* election already covers it and the call is
    /// suppressed. An election that was never confirmed does not suppress
    /// anything — the crash window between electing and calling is exactly
    /// what the second phase closes.
    #[allow(clippy::too_many_arguments)]
    pub fn record_effect(
        &self,
        run_id: &str,
        step_id: &str,
        attempt: u32,
        idempotency_key: &str,
        surface_path: &str,
        revision_before: &str,
        revision_after: &str,
        agent_identity: &str,
    ) -> Result<bool> {
        let mut journal = self.open_run(run_id)?;
        self.check_effect_lease(
            &journal,
            run_id,
            step_id,
            attempt,
            idempotency_key,
            surface_path,
        )?;
        let persisted = self.append(
            &mut journal,
            &JournalEntry::new(
                EntryType::EffectRecorded,
                run_id,
                Some(step_id.to_owned()),
                Some(attempt),
                self.clock.now_ms(),
                EffectRecordedPayload {
                    surface_path: surface_path.to_owned(),
                    idempotency_key: idempotency_key.to_owned(),
                    revision_before: revision_before.to_owned(),
                    revision_after: revision_after.to_owned(),
                    agent_identity: agent_identity.to_owned(),
                    deduped: false,
                },
            ),
        )?;
        let effect: EffectRecordedPayload = serde_json::from_value(persisted.payload)?;
        Ok(effect.deduped)
    }

    /// Phase two: the provider call this attempt was elected for has happened.
    /// Confirming closes the election, so no later attempt reclaims it. Only
    /// the attempt that holds the election may confirm it; the journal refuses
    /// anything else.
    pub fn confirm_effect(
        &self,
        run_id: &str,
        step_id: &str,
        attempt: u32,
        idempotency_key: &str,
        surface_path: &str,
        agent_identity: &str,
    ) -> Result<()> {
        let mut journal = self.open_run(run_id)?;
        self.check_effect_lease(
            &journal,
            run_id,
            step_id,
            attempt,
            idempotency_key,
            surface_path,
        )?;
        self.append(
            &mut journal,
            &JournalEntry::new(
                EntryType::EffectConfirmed,
                run_id,
                Some(step_id.to_owned()),
                Some(attempt),
                self.clock.now_ms(),
                EffectConfirmedPayload {
                    surface_path: surface_path.to_owned(),
                    idempotency_key: idempotency_key.to_owned(),
                    agent_identity: agent_identity.to_owned(),
                },
            ),
        )?;
        Ok(())
    }

    /// Both effect phases are writes by the attempt that holds the lease, on a
    /// surface its step declared. Anything else is undeclared or stale.
    fn check_effect_lease(
        &self,
        journal: &SqliteJournal,
        run_id: &str,
        step_id: &str,
        attempt: u32,
        idempotency_key: &str,
        surface_path: &str,
    ) -> Result<()> {
        let spec = journal.run_spec().context("read run spec")?;
        let state = self.load_state(journal, spec.clone())?;
        let step = spec
            .step(step_id)
            .with_context(|| format!("run {run_id} has no step {step_id}"))?;
        let StepKind::Agent { surfaces, .. } = &step.kind else {
            bail!("step {step_id} is not an agent step")
        };
        if !surfaces.external.iter().any(|path| path == surface_path) {
            bail!("effect path {surface_path} is not declared by agent step {step_id}")
        }
        let StepState::Running {
            attempt: active_attempt,
            idempotency_key: active_key,
            ..
        } = &state.steps[step_id].state
        else {
            bail!("step {step_id} has no active lease")
        };
        if *active_attempt != attempt || active_key != idempotency_key {
            bail!("effect does not match the active agent attempt")
        }
        Ok(())
    }
}

/// Surfaces this attempt was elected to write and never confirmed writing.
/// Derived from the journal alone: an `effect.recorded` this attempt won
/// (`deduped: false`) with no matching `effect.confirmed` behind it.
pub(super) fn unconfirmed_elections(
    journal: &SqliteJournal,
    step: &relayflowd_core::StepSpec,
    attempt: u32,
) -> Result<Vec<String>> {
    let entries = journal.scan_all().context("read effect elections")?;
    let mine = |entry: &JournalEntry| {
        entry.step_id.as_deref() == Some(step.id.as_str()) && entry.attempt == Some(attempt)
    };
    let mut won = std::collections::BTreeSet::new();
    let mut confirmed = std::collections::BTreeSet::new();
    for entry in entries {
        if !mine(&entry) {
            continue;
        }
        match entry.entry_type {
            EntryType::EffectRecorded => {
                let effect: EffectRecordedPayload = serde_json::from_value(entry.payload)?;
                if !effect.deduped {
                    won.insert(effect.surface_path);
                }
            }
            EntryType::EffectConfirmed => {
                let effect: EffectConfirmedPayload = serde_json::from_value(entry.payload)?;
                confirmed.insert(effect.surface_path);
            }
            _ => {}
        }
    }
    Ok(won.difference(&confirmed).cloned().collect())
}

pub(super) fn recorded_effects(
    journal: &SqliteJournal,
    step: &relayflowd_core::StepSpec,
    attempt: u32,
) -> Result<Vec<EffectRef>> {
    let recorded = journal
        .scan_all()
        .context("read recorded effects")?
        .into_iter()
        .filter(|entry| {
            entry.entry_type == EntryType::EffectRecorded
                && entry.step_id.as_deref() == Some(step.id.as_str())
                && entry.attempt == Some(attempt)
        })
        .map(|entry| {
            let effect: EffectRecordedPayload = serde_json::from_value(entry.payload)?;
            Ok((effect.surface_path, effect.idempotency_key))
        })
        .collect::<Result<std::collections::BTreeSet<_>>>()?;
    Ok(recorded
        .into_iter()
        .map(|(surface_path, idempotency_key)| EffectRef {
            surface_path,
            idempotency_key,
        })
        .collect())
}

/// Appendix A rule 5's second phase, enforced at the completion boundary: an
/// attempt that won an election and never confirmed it cannot claim success —
/// the provider call it owes is unaccounted for. The election stays
/// reclaimable, so the next attempt still performs the effect exactly once.
pub(super) fn reject_unconfirmed_elections(
    completion: &OutOfBandCompletion,
    unconfirmed: &[String],
) -> Result<()> {
    if completion.completion_reason == CompletionReason::Success && !unconfirmed.is_empty() {
        bail!(
            "agent completed successfully with unconfirmed effect elections: {}",
            unconfirmed.join(", ")
        )
    }
    Ok(())
}
