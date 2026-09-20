//! Transfer a leased attempt to an existing subscription's durable wait.
use std::collections::BTreeMap;

use anyhow::{Context, Result, bail};
use relayflowd_core::{Clock, EntryType, JournalEntry, StepState, WaitCompletedPayload,
    WaitCompletionReason, WaitEventPayload};
use relayflowd_journal::SqliteJournal;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{Engine, state::{prepared_subscriptions, subscriptions}};
use crate::engine::{DriveOptions, RunOutcome};

pub const PARK_PREFIX: &str = "subscription.park:";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionWaitPhase { Activation, EventWait }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubscriptionPark {
    pub subscription_id: String,
    pub phase: SubscriptionWaitPhase,
}

impl<C: Clock> Engine<C> {
    pub fn park_subscription_step(
        &self, run_id: &str, step_id: &str, attempt: u32,
        idempotency_key: &str, park: SubscriptionPark,
    ) -> Result<RunOutcome> {
        let mut journal = self.open_run(run_id)?;
        let spec = journal.run_spec()?;
        let state = self.load_state(&journal, spec.clone())?;
        if state.cancel_requested.is_some() || state.completion.is_some() {
            bail!("run {run_id} no longer accepts subscription waits");
        }
        let runtime = state.steps.get(step_id).context("unknown subscription waiter step")?;
        if !matches!(&runtime.state, StepState::Running { attempt: active, idempotency_key: key, .. }
            if *active == attempt && key == idempotency_key) {
            bail!("subscription wait does not match the active lease");
        }
        let prepared = prepared_subscriptions(&journal)?;
        let active = subscriptions(&journal)?;
        let known = match park.phase {
            SubscriptionWaitPhase::Activation => prepared.contains_key(&park.subscription_id)
                || active.contains_key(&park.subscription_id),
            SubscriptionWaitPhase::EventWait => active.get(&park.subscription_id)
                .is_some_and(|s| s.active_wait.is_some() || s.ready.is_some() || s.closed.is_some()),
        };
        if !known { bail!("subscription has no durable boundary to park on"); }
        let event_key = format!("{PARK_PREFIX}{}", serde_json::to_string(&park)?);
        let wait_id = format!("{step_id}/subscription-park/{attempt}");
        self.append(&mut journal, &JournalEntry::new(
            EntryType::WaitEvent, run_id, Some(step_id.to_owned()), Some(attempt), self.clock.now_ms(),
            WaitEventPayload { wait_id, event_key, timeout_at_ms: None, stream: None,
                from_offset: None, settle_ms: None, idle_at_ms: None, deadline_at_ms: None },
        ))?;
        // Do not redispatch to the departing worker, even if activation or a
        // delivery raced the handoff. Resume reconciles the recorded boundary.
        self.drive(journal, spec, DriveOptions::default())
    }

    pub(super) fn wake_subscription_steps(&self, journal: &mut SqliteJournal, now: i64) -> Result<usize> {
        let mut parked = BTreeMap::new();
        for entry in journal.scan_all()? {
            match entry.entry_type {
                EntryType::WaitEvent if entry.step_id.is_some() => {
                    let wait: WaitEventPayload = serde_json::from_value(entry.payload)?;
                    if let Some(encoded) = wait.event_key.strip_prefix(PARK_PREFIX) {
                        let park: SubscriptionPark = serde_json::from_str(encoded)?;
                        parked.insert(wait.wait_id, (entry.step_id, entry.attempt, park));
                    }
                }
                EntryType::WaitCompleted => {
                    let done: WaitCompletedPayload = serde_json::from_value(entry.payload)?;
                    parked.remove(&done.wait_id);
                }
                _ => {}
            }
        }
        let active = subscriptions(journal)?;
        let mut count = 0;
        for (wait_id, (step_id, attempt, park)) in parked {
            let ready = active.get(&park.subscription_id).is_some_and(|state| match park.phase {
                SubscriptionWaitPhase::Activation => true,
                SubscriptionWaitPhase::EventWait => state.ready.is_some() || state.closed.is_some(),
            });
            if ready {
                self.append(journal, &JournalEntry::new(
                    EntryType::WaitCompleted, journal.run_id(), step_id, attempt, now,
                    WaitCompletedPayload { wait_id, completion_reason: WaitCompletionReason::EventReceived,
                        result: json!({"subscription_id": park.subscription_id}) },
                ))?;
                count += 1;
            }
        }
        Ok(count)
    }
}
