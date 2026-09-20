//! A body re-executes from the beginning; each pull must replay its own wake.
use anyhow::{Result, Context, bail};
use relayflowd_core::{Clock, EntryType, WaitCompletedPayload};

use super::{Engine, SubscriptionWake, state::{subscriptions, wake_from_completed}};

impl<C: Clock> Engine<C> {
    pub fn replay_subscription_wake(
        &self, run_id: &str, subscription_id: &str, sequence: u64,
    ) -> Result<Option<(SubscriptionWake, Option<String>)>> {
        let journal = self.open_run(run_id)?;
        let states = subscriptions(&journal)?;
        let state = states.get(subscription_id).context("unknown subscription")?;
        let wait_id = format!("{subscription_id}/next/{sequence}");
        for entry in journal.scan_all()? {
            if entry.entry_type == EntryType::WaitCompleted {
                let completed: WaitCompletedPayload = serde_json::from_value(entry.payload)?;
                if completed.wait_id == wait_id {
                    let wake = wake_from_completed(&journal, state, &completed)?;
                    let receipt = matches!(wake, SubscriptionWake::Events { .. } | SubscriptionWake::Idle)
                        .then(|| wait_id.clone());
                    return Ok(Some((wake, receipt)));
                }
            }
        }
        if sequence != state.next_wait_sequence
            && !state.active_wait.as_ref().is_some_and(|wait| wait.wait_id == wait_id) {
            bail!("subscription pull sequence has no replayable wake");
        }
        Ok(None)
    }
}
