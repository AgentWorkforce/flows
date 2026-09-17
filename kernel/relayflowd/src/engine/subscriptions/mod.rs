//! Body-local event activities: durable cursors over journal streams.
//!
//! Provider bindings are deliberately not implemented here. Cloud first
//! records a prepared request, then fences its tenant/provider binding and
//! calls `subscription.activate`; this module owns only journal ordering,
//! cursor state, and timers.

use std::collections::BTreeMap;

use anyhow::{Context, Result, bail};
use relayflowd_core::{
    Clock, EntryType, JournalEntry, RunSpawnedPayload, StreamAppendedPayload, SubscriptionAcknowledgedPayload, SubscriptionClosedPayload,
    SubscriptionCompletionReason, SubscriptionOpenedPayload, SubscriptionPreparedPayload, WaitCompletedPayload,
    SubscriptionOverflowFencedPayload, WaitCompletionReason, WaitEventPayload,
};
use relayflowd_journal::SqliteJournal;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::Engine;

mod state;
use state::*;

const MAX_UNREAD_FRAMES: usize = 1_000;
const MAX_UNREAD_BYTES: usize = 1_024 * 1_024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SubscriptionWake {
    Events { events: Vec<Value>, offset: u64 },
    Idle,
    Deadline { pending: Option<PendingRange> },
    Overflow { retained: u64, bytes: u64, from: u64 },
}

/// A daemon response never sleeps while waiting for an external event. The
/// caller publishes this durable boundary and returns to its control plane.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SubscriptionNext {
    Wake(SubscriptionWake),
    Suspended { subscription_id: String, stream: String, deadline_at_ms: i64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SubscriptionOpen {
    /// The exact immutable request that Cloud must bind before the body can
    /// resume. These fields come from `subscription.prepared`, never from the
    /// authored source on a retry, so Cloud need not parse a sandbox journal.
    Prepared {
        subscription_id: String,
        event_types: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pattern: Option<Value>,
        stream: String,
        settle_ms: i64,
        idle_ms: i64,
        deadline_at_ms: i64,
        include_self: bool,
    },
    Active { subscription_id: String, stream: String, deadline_at_ms: i64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingRange {
    pub from: u64,
    pub to: u64,
}

#[derive(Debug, Clone)]
pub(super) struct SubscriptionState {
    pub(super) opened: SubscriptionOpenedPayload,
    pub(super) closed: Option<SubscriptionCompletionReason>,
    pub(super) acknowledged_offset: u64,
    pub(super) last_wake_at_ms: i64,
    pub(super) active_wait: Option<WaitEventPayload>,
    pub(super) ready: Option<WaitCompletedPayload>,
    pub(super) overflow_fence: Option<SubscriptionOverflowFencedPayload>,
    pub(super) next_wait_sequence: u64,
}

impl SubscriptionState {
    pub(super) fn stream(&self) -> &str { &self.opened.stream }
}

impl<C: Clock> Engine<C> {
    /// Repository-owned local router adapter. Cloud performs the corresponding
    /// binding and authorization work outside this tenant-unaware kernel.
    #[doc(hidden)]
    pub fn append_local_subscription_event(&self, run_id: &str, event_type: &str, payload: Value, delivery_id: Option<&str>, actor: Option<&str>) -> Result<usize> {
        let journal = self.open_run(run_id)?;
        let entries = journal.scan_all()?;
        let run_identity = entries.iter().find(|entry| entry.entry_type == EntryType::RunSpawned)
            .map(|entry| serde_json::from_value::<RunSpawnedPayload>(entry.payload.clone())).transpose()?
            .map(|spawned| spawned.created_by);
        let matched = subscriptions(&journal)?.into_iter().filter_map(|(id, state)| {
            (state.closed.is_none() && state.overflow_fence.is_none()
                && state.opened.event_types.iter().any(|kind| kind == event_type)
                && state.opened.pattern.as_ref().is_none_or(|pattern| relayflowd_core::event::matches(pattern, &payload))
                && (state.opened.include_self || actor != run_identity.as_deref())).then_some(id)
        }).collect::<Vec<_>>();
        drop(journal);
        if matched.is_empty() { return Ok(0); }
        let delivery_id = delivery_id.filter(|id| !id.is_empty()).context("body subscription frame requires a provider delivery id")?;
        let frame = json!({"type": event_type, "payload": payload});
        let mut appended = 0;
        for id in matched { if self.append_subscription_frame(run_id, &id, delivery_id, frame.clone())? { appended += 1; } }
        Ok(appended)
    }

    pub(super) fn close_subscriptions_for_terminal(&self, journal: &mut SqliteJournal, reason: SubscriptionCompletionReason, now: i64) -> Result<()> {
        let ids = subscriptions(journal)?.into_iter().filter_map(|(id, state)| state.closed.is_none().then_some(id)).collect::<Vec<_>>();
        for id in ids { self.close_subscription_in_journal(journal, &id, reason, now)?; }
        Ok(())
    }

    pub fn open_subscription(
        &self,
        run_id: &str,
        subscription_id: &str,
        event_types: Vec<String>,
        pattern: Option<Value>,
        settle_ms: i64,
        idle_ms: i64,
        deadline_ms: i64,
        include_self: bool,
    ) -> Result<SubscriptionOpen> {
        if subscription_id.is_empty() || event_types.is_empty() || event_types.iter().any(String::is_empty)
            || settle_ms < 0 || idle_ms <= 0 || deadline_ms <= 0 {
            bail!("invalid durable subscription bounds or identity")
        }
        if let Some(pattern) = &pattern { relayflowd_core::event::validate_pattern(pattern)?; }
        let mut journal = self.open_run(run_id)?;
        let mut current = subscriptions(&journal)?;
        let existing = current.remove(subscription_id);
        if let Some(existing) = existing {
            if existing.closed.is_none() {
                return Ok(SubscriptionOpen::Active { subscription_id: subscription_id.to_owned(), stream: existing.opened.stream, deadline_at_ms: existing.opened.deadline_at_ms });
            }
            bail!("subscription {subscription_id} is closed")
        }
        if let Some(prepared) = prepared_subscriptions(&journal)?.remove(subscription_id) {
            return Ok(SubscriptionOpen::Prepared {
                subscription_id: subscription_id.to_owned(), event_types: prepared.event_types,
                pattern: prepared.pattern, stream: prepared.stream, settle_ms: prepared.settle_ms,
                idle_ms: prepared.idle_ms, deadline_at_ms: prepared.deadline_at_ms,
                include_self: prepared.include_self,
            });
        }
        let now = self.clock.now_ms();
        let deadline_at_ms = now.checked_add(deadline_ms).context("subscription deadline overflow")?;
        let stream = format!("subscription/{subscription_id}");
        let prepared = SubscriptionPreparedPayload {
            subscription_id: subscription_id.to_owned(), event_types, pattern, stream,
            settle_ms, idle_ms, deadline_at_ms, include_self,
        };
        self.append(&mut journal, &JournalEntry::new(
            EntryType::SubscriptionPrepared, run_id, None, None, now, prepared.clone(),
        ))?;
        Ok(SubscriptionOpen::Prepared {
            subscription_id: prepared.subscription_id, event_types: prepared.event_types,
            pattern: prepared.pattern, stream: prepared.stream, settle_ms: prepared.settle_ms,
            idle_ms: prepared.idle_ms, deadline_at_ms: prepared.deadline_at_ms,
            include_self: prepared.include_self,
        })
    }

    /// Commit the second half of the open handshake after Cloud has persisted
    /// its binding receipt and ingress cursor. Retries are idempotent.
    pub fn activate_subscription(
        &self, run_id: &str, subscription_id: &str, ingress_offset: u64, router_binding: Value,
    ) -> Result<SubscriptionOpen> {
        let mut journal = self.open_run(run_id)?;
        if let Some(active) = subscriptions(&journal)?.remove(subscription_id) {
            return Ok(SubscriptionOpen::Active { subscription_id: subscription_id.to_owned(), stream: active.opened.stream, deadline_at_ms: active.opened.deadline_at_ms });
        }
        let prepared = prepared_subscriptions(&journal)?.remove(subscription_id)
            .context("subscription activation requires a prepared binding")?;
        self.append(&mut journal, &JournalEntry::new(
            EntryType::SubscriptionOpened, run_id, None, None, self.clock.now_ms(),
            SubscriptionOpenedPayload {
                subscription_id: prepared.subscription_id,
                event_types: prepared.event_types,
                pattern: prepared.pattern,
                stream: prepared.stream.clone(),
                settle_ms: prepared.settle_ms,
                idle_ms: prepared.idle_ms,
                deadline_at_ms: prepared.deadline_at_ms,
                include_self: prepared.include_self,
                ingress_offset,
                router_binding,
            },
        ))?;
        Ok(SubscriptionOpen::Active { subscription_id: subscription_id.to_owned(), stream: prepared.stream, deadline_at_ms: prepared.deadline_at_ms })
    }

    pub fn close_subscription(
        &self, run_id: &str, subscription_id: &str, reason: SubscriptionCompletionReason,
    ) -> Result<bool> {
        let mut journal = self.open_run(run_id)?;
        let states = subscriptions(&journal)?;
        let Some(state) = states.get(subscription_id) else { bail!("unknown subscription {subscription_id}") };
        if state.closed.is_some() || state.overflow_fence.is_some() { return Ok(false); }
        self.close_subscription_in_journal(&mut journal, subscription_id, reason, self.clock.now_ms())?;
        Ok(true)
    }

    /// Appends one router-delivered frame. `delivery_id` is the provider's
    /// idempotency key; a duplicate is a successful no-op. The caller has
    /// already performed provider binding and self-actor authorization.
    pub fn append_subscription_frame(
        &self, run_id: &str, subscription_id: &str, delivery_id: &str, frame: Value,
    ) -> Result<bool> {
        if delivery_id.is_empty() { bail!("subscription frame requires a provider delivery id") }
        let mut journal = self.open_run(run_id)?;
        let states = subscriptions(&journal)?;
        let Some(state) = states.get(subscription_id) else { bail!("unknown subscription {subscription_id}") };
        if state.closed.is_some() || state.overflow_fence.is_some() { return Ok(false); }
        let entries = journal.scan_all()?;
        let unread = unread_frames(&entries, state)?;
        if unread.iter().any(|(_, append)| append.provider_delivery_id.as_deref() == Some(delivery_id))
            || entries.iter().filter(|entry| entry.entry_type == EntryType::StreamAppended).any(|entry| {
                serde_json::from_value::<StreamAppendedPayload>(entry.payload.clone()).ok()
                    .is_some_and(|append| append.stream == state.stream() && append.provider_delivery_id.as_deref() == Some(delivery_id))
            }) {
            return Ok(false);
        }
        let encoded = serde_json::to_vec(&frame).context("encode subscription frame")?;
        let unread_bytes = unread.iter().try_fold(0usize, |sum, (_, append)| {
            serde_json::to_vec(&append.message).map(|bytes| sum.saturating_add(bytes.len()))
        })?;
        if unread.len() >= MAX_UNREAD_FRAMES || unread_bytes.saturating_add(encoded.len()) > MAX_UNREAD_BYTES {
            // In Cloud the router's durable binding fence precedes this
            // command. Locally this append and close share the per-run journal
            // sequencer, so there is no post-fence crash window to replay.
            self.fence_subscription_overflow_in_journal(&mut journal, subscription_id, unread.len() as u64, unread_bytes as u64, state.acknowledged_offset, self.clock.now_ms())?;
            self.complete_fenced_overflows_in_journal(&mut journal, self.clock.now_ms())?;
            return Ok(false);
        }
        let offset = next_stream_offset(&entries, state.stream());
        self.append(&mut journal, &JournalEntry::new(
            EntryType::StreamAppended, run_id, None, None, self.clock.now_ms(),
            StreamAppendedPayload { stream: state.stream().to_owned(), offset, producer: "event-router".to_owned(), message: frame, provider_delivery_id: Some(delivery_id.to_owned()) },
        ))?;
        Ok(true)
    }

    /// Complete any persisted activity wait whose recorded timer is due. This
    /// is called by resume and by the daemon's parked `next` loop; it is also a
    /// deterministic test seam for a simulated clock.
    pub fn claim_subscription_timeouts(&self, run_id: &str) -> Result<usize> {
        let mut journal = self.open_run(run_id)?;
        let now = self.clock.now_ms();
        let fenced = self.complete_fenced_overflows_in_journal(&mut journal, now)?;
        let states = subscriptions(&journal)?;
        let entries = journal.scan_all()?;
        let mut claimed = fenced;
        for (id, state) in states {
            if state.closed.is_some() { continue; }
            // Deadline is deliberately first: at an exact tie it beats an
            // append already visible in this journal snapshot.
            if now >= state.opened.deadline_at_ms {
                self.close_subscription_in_journal(&mut journal, &id, SubscriptionCompletionReason::Deadline, now)?;
                claimed += 1;
                continue;
            }
            let Some(ref wait) = state.active_wait else { continue; };
            let unread = unread_frames(&entries, &state)?;
            if !unread.is_empty() {
                let newest_at = unread.last().map(|(entry, _)| entry.at_ms).unwrap_or(now);
                if now >= newest_at.saturating_add(state.opened.settle_ms) || now >= wait.idle_at_ms.unwrap_or(i64::MAX) {
                    self.complete_events(&mut journal, &state, &wait, &unread, now)?;
                    claimed += 1;
                }
            } else if now >= wait.idle_at_ms.unwrap_or(i64::MAX) {
                self.complete_wait(&mut journal, &wait, WaitCompletionReason::Timeout, json!({"subscription_id": id, "timeout": "idle"}), now)?;
                claimed += 1;
            }
        }
        claimed += self.claim_non_activity_wait_timeouts_in_journal(&mut journal, now)?;
        Ok(claimed)
    }

    /// Return only a durable wake. Callers that need to wait must hand the
    /// suspended outcome to their control plane rather than occupying a daemon.
    pub fn next_subscription(&self, run_id: &str, subscription_id: &str) -> Result<SubscriptionWake> {
        self.next_subscription_after_ack(run_id, subscription_id, None)
    }

    /// Return the next durable wake, optionally acknowledging the prior wake
    /// first. A normal wake deliberately stays unacknowledged until the body
    /// asks for another one: committing an acknowledgement before the socket
    /// reply can lose a wake if the daemon dies in that hand-off window.
    pub fn next_subscription_after_ack(
        &self,
        run_id: &str,
        subscription_id: &str,
        acknowledge_wait_id: Option<&str>,
    ) -> Result<SubscriptionWake> {
        self.next_subscription_after_ack_with_receipt(run_id, subscription_id, acknowledge_wait_id)
            .map(|(wake, _)| wake)
    }

    /// Same as [`Self::next_subscription_after_ack`], retaining the opaque
    /// receipt id needed by a protocol client to acknowledge a recovered wake
    /// whose durable sequence predates that client process.
    pub fn next_subscription_after_ack_with_receipt(
        &self,
        run_id: &str,
        subscription_id: &str,
        acknowledge_wait_id: Option<&str>,
    ) -> Result<(SubscriptionWake, Option<String>)> {
        match self.next_subscription_outcome(run_id, subscription_id, acknowledge_wait_id)? {
            (SubscriptionNext::Wake(wake), receipt) => Ok((wake, receipt)),
            (SubscriptionNext::Suspended { subscription_id, .. }, _) => bail!("subscription {subscription_id} is durably suspended"),
        }
    }

    pub fn next_subscription_outcome(
        &self,
        run_id: &str,
        subscription_id: &str,
        acknowledge_wait_id: Option<&str>,
    ) -> Result<(SubscriptionNext, Option<String>)> {
        let mut acknowledge_wait_id = acknowledge_wait_id;
        loop {
            self.claim_subscription_timeouts(run_id)?;
            let mut journal = self.open_run(run_id)?;
            let states = subscriptions(&journal)?;
            let state = states.get(subscription_id).context("unknown subscription")?;
            let now = self.clock.now_ms();
            if let Some(wait_id) = acknowledge_wait_id.take() {
                self.acknowledge_normal_wake(&mut journal, state, wait_id, now)?;
                continue;
            }
            if let Some(completed) = &state.ready {
                let wake = wake_from_completed(&journal, state, completed)?;
                let receipt = matches!(wake, SubscriptionWake::Events { .. } | SubscriptionWake::Idle)
                    .then(|| completed.wait_id.clone());
                return Ok((SubscriptionNext::Wake(wake), receipt));
            }
            if let Some(reason) = state.closed { return self.closed_wake(&journal, state, reason).map(|wake| (SubscriptionNext::Wake(wake), None)); }
            let entries = journal.scan_all()?;
            let unread = unread_frames(&entries, state)?;
            if !unread.is_empty() {
                let newest_at = unread.last().unwrap().0.at_ms;
                if now >= newest_at.saturating_add(state.opened.settle_ms)
                    || now >= state.last_wake_at_ms.saturating_add(state.opened.idle_ms) {
                    let wait = state.active_wait.clone().unwrap_or_else(|| activity_wait(state, now));
                    // A completion without its preceding wait cannot be
                    // recovered: after a crash the fold has no activity to
                    // associate it with and would offer the same frames
                    // again. Persist the wait first even when a ready batch
                    // lets this call complete without parking.
                    if state.active_wait.is_none() {
                        self.append(&mut journal, &JournalEntry::new(
                            EntryType::WaitEvent, run_id, None, None, now, wait.clone(),
                        ))?;
                    }
                    self.complete_events(&mut journal, state, &wait, &unread, now)?;
                    return events_wake(&unread).map(|wake| (SubscriptionNext::Wake(wake), Some(wait.wait_id)));
                }
            }
            if let Some(wait) = &state.active_wait {
                return Ok((SubscriptionNext::Suspended { subscription_id: subscription_id.to_owned(), stream: state.stream().to_owned(), deadline_at_ms: wait.deadline_at_ms.unwrap_or(state.opened.deadline_at_ms) }, None));
            }
            let wait = activity_wait(state, now);
            self.append(&mut journal, &JournalEntry::new(EntryType::WaitEvent, run_id, None, None, now, wait))?;
            return Ok((SubscriptionNext::Suspended { subscription_id: subscription_id.to_owned(), stream: state.stream().to_owned(), deadline_at_ms: state.opened.deadline_at_ms }, None));
        }
    }

    fn close_subscription_in_journal(&self, journal: &mut SqliteJournal, subscription_id: &str, reason: SubscriptionCompletionReason, now: i64) -> Result<()> {
        let states = subscriptions(journal)?;
        if let Some(state) = states.get(subscription_id)
            && let Some(wait) = &state.active_wait
        {
            let result = match reason {
                SubscriptionCompletionReason::Overflow => json!({"subscription_id": subscription_id, "wake": "overflow"}),
                SubscriptionCompletionReason::Deadline => json!({"subscription_id": subscription_id, "timeout": "deadline", "pending": pending(&unread_frames(&journal.scan_all()?, state)?) }),
                _ => json!({"subscription_id": subscription_id, "closed": true}),
            };
            let completion_reason = if reason == SubscriptionCompletionReason::Overflow {
                WaitCompletionReason::EventReceived
            } else {
                WaitCompletionReason::Timeout
            };
            self.complete_wait(journal, wait, completion_reason, result, now)?;
        }
        self.append(journal, &JournalEntry::new(EntryType::SubscriptionClosed, journal.run_id(), None, None, now,
            SubscriptionClosedPayload { subscription_id: subscription_id.to_owned(), completion_reason: reason }))?;
        Ok(())
    }

    /// The Cloud router calls this only after it has durably fenced its own
    /// binding. It is intentionally separate from close so a process death at
    /// that boundary is visible to recovery rather than reopening the stream.
    #[doc(hidden)]
    pub fn fence_subscription_overflow(&self, run_id: &str, subscription_id: &str) -> Result<()> {
        let mut journal = self.open_run(run_id)?;
        let states = subscriptions(&journal)?;
        let state = states.get(subscription_id).context("unknown subscription")?;
        let unread = unread_frames(&journal.scan_all()?, state)?;
        self.fence_subscription_overflow_in_journal(&mut journal, subscription_id, unread.len() as u64, unread_bytes(&unread) as u64, state.acknowledged_offset, self.clock.now_ms())
    }

    fn fence_subscription_overflow_in_journal(&self, journal: &mut SqliteJournal, subscription_id: &str, retained: u64, bytes: u64, from: u64, now: i64) -> Result<()> {
        let states = subscriptions(journal)?;
        let state = states.get(subscription_id).context("unknown subscription")?;
        if state.closed.is_some() || state.overflow_fence.is_some() { return Ok(()); }
        self.append(journal, &JournalEntry::new(EntryType::SubscriptionOverflowFenced, journal.run_id(), None, None, now,
            SubscriptionOverflowFencedPayload { subscription_id: subscription_id.to_owned(), retained, bytes, from }))?;
        Ok(())
    }

    fn complete_fenced_overflows_in_journal(&self, journal: &mut SqliteJournal, now: i64) -> Result<usize> {
        let states = subscriptions(journal)?;
        let fenced = states.into_iter().filter_map(|(id, state)| (state.closed.is_none() && state.overflow_fence.is_some()).then_some(id)).collect::<Vec<_>>();
        for id in &fenced { self.close_subscription_in_journal(journal, id, SubscriptionCompletionReason::Overflow, now)?; }
        Ok(fenced.len())
    }

    fn claim_non_activity_wait_timeouts_in_journal(&self, journal: &mut SqliteJournal, now: i64) -> Result<usize> {
        let mut open = BTreeMap::<String, (Option<String>, Option<u32>, i64)>::new();
        for entry in journal.scan_all()? {
            match entry.entry_type {
                EntryType::WaitHuman => {
                    let wait: relayflowd_core::WaitHumanPayload = serde_json::from_value(entry.payload)?;
                    if let Some(timeout) = wait.timeout_at_ms { open.insert(wait.wait_id, (entry.step_id, entry.attempt, timeout)); }
                }
                EntryType::WaitEvent => {
                    let wait: WaitEventPayload = serde_json::from_value(entry.payload)?;
                    if wait.stream.is_none() && let Some(timeout) = wait.timeout_at_ms { open.insert(wait.wait_id, (entry.step_id, entry.attempt, timeout)); }
                }
                EntryType::WaitCompleted => { open.remove(&serde_json::from_value::<WaitCompletedPayload>(entry.payload)?.wait_id); }
                _ => {}
            }
        }
        let due = open.into_iter().filter(|(_, (_, _, timeout))| *timeout <= now).collect::<Vec<_>>();
        for (wait_id, (step_id, attempt, _)) in &due {
            self.append(journal, &JournalEntry::new(EntryType::WaitCompleted, journal.run_id(), step_id.clone(), *attempt, now,
                WaitCompletedPayload { wait_id: wait_id.clone(), completion_reason: WaitCompletionReason::Timeout, result: json!({"timeout": "timeout"}) }))?;
        }
        Ok(due.len())
    }

    fn complete_events(&self, journal: &mut SqliteJournal, state: &SubscriptionState, wait: &WaitEventPayload, unread: &[(JournalEntry, StreamAppendedPayload)], now: i64) -> Result<()> {
        let from = state.acknowledged_offset;
        let next = unread.last().expect("nonempty").1.offset.saturating_add(1);
        self.complete_wait(journal, wait, WaitCompletionReason::EventReceived,
            json!({"subscription_id": state.opened.subscription_id, "from_offset": from, "next_offset": next}), now)
    }

    fn complete_wait(&self, journal: &mut SqliteJournal, wait: &WaitEventPayload, reason: WaitCompletionReason, result: Value, now: i64) -> Result<()> {
        self.append(journal, &JournalEntry::new(EntryType::WaitCompleted, journal.run_id(), None, None, now,
            WaitCompletedPayload { wait_id: wait.wait_id.clone(), completion_reason: reason, result }))?;
        Ok(())
    }

    fn acknowledge_normal_wake(&self, journal: &mut SqliteJournal, state: &SubscriptionState, wait_id: &str, now: i64) -> Result<()> {
        if state.ready.as_ref().is_some_and(|ready| ready.wait_id == wait_id) {
            let completed = state.ready.as_ref().expect("checked ready wake");
            if !matches!(wake_from_completed(journal, state, completed)?, SubscriptionWake::Events { .. } | SubscriptionWake::Idle) {
                bail!("subscription {} cannot acknowledge terminal wake {}", state.opened.subscription_id, wait_id);
            }
            self.append(journal, &JournalEntry::new(EntryType::SubscriptionAcknowledged, journal.run_id(), None, None, now,
                SubscriptionAcknowledgedPayload { subscription_id: state.opened.subscription_id.clone(), wait_id: wait_id.to_owned(), next_offset: completed.result.get("next_offset").and_then(Value::as_u64) }))?;
            return Ok(());
        }
        let already_acknowledged = journal.scan_all()?.into_iter().any(|entry| {
            entry.entry_type == EntryType::SubscriptionAcknowledged
                && serde_json::from_value::<SubscriptionAcknowledgedPayload>(entry.payload)
                    .is_ok_and(|ack| ack.subscription_id == state.opened.subscription_id && ack.wait_id == wait_id)
        });
        if !already_acknowledged {
            bail!("subscription {} has no normal wake {} to acknowledge", state.opened.subscription_id, wait_id);
        }
        Ok(())
    }

    fn closed_wake(&self, journal: &SqliteJournal, state: &SubscriptionState, reason: SubscriptionCompletionReason) -> Result<SubscriptionWake> {
        let unread = unread_frames(&journal.scan_all()?, state)?;
        Ok(match reason {
            SubscriptionCompletionReason::Overflow => {
                let fence = state.overflow_fence.as_ref();
                SubscriptionWake::Overflow { retained: fence.map_or(unread.len() as u64, |fence| fence.retained), bytes: fence.map_or(unread_bytes(&unread) as u64, |fence| fence.bytes), from: fence.map_or(state.acknowledged_offset, |fence| fence.from) }
            }
            SubscriptionCompletionReason::Deadline => SubscriptionWake::Deadline { pending: pending(&unread) },
            SubscriptionCompletionReason::Closed | SubscriptionCompletionReason::RunCompleted | SubscriptionCompletionReason::Canceled => bail!("subscription {} is closed", state.opened.subscription_id),
        })
    }
}
