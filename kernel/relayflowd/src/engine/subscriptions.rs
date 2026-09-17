//! Body-local event activities: durable cursors over journal streams.
//!
//! Provider bindings are deliberately not implemented here. Cloud fences its
//! tenant/provider binding, then calls `subscription.open`; this module owns
//! only the cell-local journal ordering, cursor, and timers.

use std::collections::BTreeMap;

use anyhow::{Context, Result, bail};
use relayflowd_core::{
    Clock, EntryType, JournalEntry, RunSpawnedPayload, StreamAppendedPayload, SubscriptionAcknowledgedPayload, SubscriptionClosedPayload,
    SubscriptionCompletionReason, SubscriptionOpenedPayload, WaitCompletedPayload,
    SubscriptionOverflowFencedPayload, WaitCompletionReason, WaitEventPayload,
};
use relayflowd_journal::SqliteJournal;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::Engine;

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingRange {
    pub from: u64,
    pub to: u64,
}

#[derive(Debug, Clone)]
struct SubscriptionState {
    opened: SubscriptionOpenedPayload,
    closed: Option<SubscriptionCompletionReason>,
    acknowledged_offset: u64,
    last_wake_at_ms: i64,
    active_wait: Option<WaitEventPayload>,
    ready: Option<WaitCompletedPayload>,
    overflow_fence: Option<SubscriptionOverflowFencedPayload>,
    next_wait_sequence: u64,
}

impl SubscriptionState {
    fn stream(&self) -> &str { &self.opened.stream }
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
    ) -> Result<(String, i64)> {
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
                return Ok((existing.opened.stream, existing.opened.deadline_at_ms));
            }
            bail!("subscription {subscription_id} is closed")
        }
        let now = self.clock.now_ms();
        let deadline_at_ms = now.checked_add(deadline_ms).context("subscription deadline overflow")?;
        let stream = format!("subscription/{subscription_id}");
        self.append(&mut journal, &JournalEntry::new(
            EntryType::SubscriptionOpened, run_id, None, None, now,
            SubscriptionOpenedPayload {
                subscription_id: subscription_id.to_owned(), event_types, pattern, stream: stream.clone(),
                settle_ms, idle_ms, deadline_at_ms, include_self, ingress_offset: 0,
                // The local daemon is not a provider router. Cloud replaces
                // this neutral receipt after it durably fenced its binding.
                router_binding: json!({"transport": "local-daemon"}),
            },
        ))?;
        Ok((stream, deadline_at_ms))
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

    /// Block only at the daemon edge. Every wait boundary and wake result is
    /// journaled first, so a restarted caller observes the same state.
    pub fn next_subscription(&self, run_id: &str, subscription_id: &str) -> Result<SubscriptionWake> {
        loop {
            self.claim_subscription_timeouts(run_id)?;
            let mut journal = self.open_run(run_id)?;
            let states = subscriptions(&journal)?;
            let state = states.get(subscription_id).context("unknown subscription")?;
            let now = self.clock.now_ms();
            if let Some(completed) = &state.ready {
                let wake = wake_from_completed(&journal, state, completed)?;
                if matches!(wake, SubscriptionWake::Events { .. } | SubscriptionWake::Idle) {
                    self.acknowledge_normal_wake(&mut journal, state, completed, now)?;
                }
                return Ok(wake);
            }
            if let Some(reason) = state.closed { return self.closed_wake(&journal, state, reason); }
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
                    self.acknowledge_normal_wake(&mut journal, state, &WaitCompletedPayload {
                        wait_id: wait.wait_id, completion_reason: WaitCompletionReason::EventReceived,
                        result: json!({"next_offset": unread.last().expect("nonempty").1.offset.saturating_add(1)}),
                    }, now)?;
                    return events_wake(&unread);
                }
            }
            if let Some(wait) = &state.active_wait {
                // A completed wait is reconstructed by the timer claimant on
                // the next loop iteration. Leave it durable while parked.
                let sleep_ms = wait.deadline_at_ms.unwrap_or(state.opened.deadline_at_ms).saturating_sub(now).clamp(1, 10);
                drop(journal);
                std::thread::sleep(std::time::Duration::from_millis(sleep_ms as u64));
                continue;
            }
            let wait = activity_wait(state, now);
            self.append(&mut journal, &JournalEntry::new(EntryType::WaitEvent, run_id, None, None, now, wait))?;
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
            self.complete_wait(journal, wait, WaitCompletionReason::Timeout, result, now)?;
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

    fn acknowledge_normal_wake(&self, journal: &mut SqliteJournal, state: &SubscriptionState, completed: &WaitCompletedPayload, now: i64) -> Result<()> {
        self.append(journal, &JournalEntry::new(EntryType::SubscriptionAcknowledged, journal.run_id(), None, None, now,
            SubscriptionAcknowledgedPayload { subscription_id: state.opened.subscription_id.clone(), wait_id: completed.wait_id.clone(), next_offset: completed.result.get("next_offset").and_then(Value::as_u64) }))?;
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

fn subscriptions(journal: &SqliteJournal) -> Result<BTreeMap<String, SubscriptionState>> {
    let mut states = BTreeMap::new();
    for entry in journal.scan_all()? {
        match entry.entry_type {
            EntryType::SubscriptionOpened => {
                let opened: SubscriptionOpenedPayload = serde_json::from_value(entry.payload)?;
                states.insert(opened.subscription_id.clone(), SubscriptionState { opened, closed: None, acknowledged_offset: 0, last_wake_at_ms: entry.at_ms, active_wait: None, ready: None, overflow_fence: None, next_wait_sequence: 0 });
            }
            EntryType::SubscriptionClosed => {
                let closed: SubscriptionClosedPayload = serde_json::from_value(entry.payload)?;
                if let Some(state) = states.get_mut(&closed.subscription_id) { state.closed = Some(closed.completion_reason); }
            }
            EntryType::SubscriptionOverflowFenced => {
                let fence: SubscriptionOverflowFencedPayload = serde_json::from_value(entry.payload)?;
                if let Some(state) = states.get_mut(&fence.subscription_id) { state.overflow_fence = Some(fence); }
            }
            EntryType::SubscriptionAcknowledged => {
                let acknowledged: SubscriptionAcknowledgedPayload = serde_json::from_value(entry.payload)?;
                if let Some(state) = states.get_mut(&acknowledged.subscription_id) {
                    state.ready = state.ready.take().filter(|ready| ready.wait_id != acknowledged.wait_id);
                    if let Some(next) = acknowledged.next_offset { state.acknowledged_offset = state.acknowledged_offset.max(next); }
                }
            }
            EntryType::WaitEvent => {
                let wait: WaitEventPayload = serde_json::from_value(entry.payload)?;
                if let Some(stream) = &wait.stream {
                    if let Some(state) = states.values_mut().find(|state| state.stream() == stream) {
                        state.active_wait = Some(wait);
                        state.next_wait_sequence = state.next_wait_sequence.saturating_add(1);
                    }
                }
            }
            EntryType::WaitCompleted => {
                let completed: WaitCompletedPayload = serde_json::from_value(entry.payload)?;
                for state in states.values_mut() {
                    if state.active_wait.as_ref().is_some_and(|wait| wait.wait_id == completed.wait_id) {
                        state.active_wait = None;
                        state.last_wake_at_ms = entry.at_ms;
                        state.ready = Some(completed.clone());
                        if let Some(next) = completed.result.get("next_offset").and_then(Value::as_u64) { state.acknowledged_offset = next; }
                    }
                }
            }
            _ => {}
        }
    }
    Ok(states)
}

fn activity_wait(state: &SubscriptionState, _now: i64) -> WaitEventPayload {
    let idle_at_ms = state.last_wake_at_ms.saturating_add(state.opened.idle_ms);
    WaitEventPayload {
        wait_id: format!("{}/next/{}", state.opened.subscription_id, state.next_wait_sequence), event_key: state.opened.subscription_id.clone(), timeout_at_ms: Some(state.opened.deadline_at_ms),
        stream: Some(state.stream().to_owned()), from_offset: Some(state.acknowledged_offset), settle_ms: Some(state.opened.settle_ms), idle_at_ms: Some(idle_at_ms), deadline_at_ms: Some(state.opened.deadline_at_ms),
    }
}

fn unread_frames(entries: &[JournalEntry], state: &SubscriptionState) -> Result<Vec<(JournalEntry, StreamAppendedPayload)>> {
    let mut unread = Vec::new();
    for entry in entries.iter().filter(|entry| entry.entry_type == EntryType::StreamAppended) {
        let append: StreamAppendedPayload = serde_json::from_value(entry.payload.clone())
            .context("decode stream.appended while reading subscription")?;
        if append.stream == state.stream() && append.offset >= state.acknowledged_offset {
            unread.push((entry.clone(), append));
        }
    }
    Ok(unread)
}

fn next_stream_offset(entries: &[JournalEntry], stream: &str) -> u64 {
    entries.iter().filter(|entry| entry.entry_type == EntryType::StreamAppended).filter_map(|entry| serde_json::from_value::<StreamAppendedPayload>(entry.payload.clone()).ok()).filter(|append| append.stream == stream).map(|append| append.offset.saturating_add(1)).max().unwrap_or(0)
}

fn events_wake(unread: &[(JournalEntry, StreamAppendedPayload)]) -> Result<SubscriptionWake> {
    Ok(SubscriptionWake::Events { events: unread.iter().map(|(_, append)| append.message.clone()).collect(), offset: unread.last().context("nonempty")?.1.offset.saturating_add(1) })
}
fn wake_from_completed(journal: &SqliteJournal, state: &SubscriptionState, completed: &WaitCompletedPayload) -> Result<SubscriptionWake> {
    if completed.result.get("wake").and_then(Value::as_str) == Some("overflow") {
        let unread = unread_frames(&journal.scan_all()?, state)?;
        let fence = state.overflow_fence.as_ref();
        return Ok(SubscriptionWake::Overflow {
            retained: fence.map_or(unread.len() as u64, |fence| fence.retained),
            bytes: fence.map_or(unread_bytes(&unread) as u64, |fence| fence.bytes),
            from: fence.map_or(state.acknowledged_offset, |fence| fence.from),
        });
    }
    match completed.result.get("timeout").and_then(Value::as_str) {
        Some("idle") => return Ok(SubscriptionWake::Idle),
        Some("deadline") => return Ok(SubscriptionWake::Deadline { pending: completed.result.get("pending").cloned().and_then(|value| serde_json::from_value(value).ok()) }),
        _ => {}
    }
    let from = completed.result.get("from_offset").and_then(Value::as_u64).context("activity event completion lacks from_offset")?;
    let next = completed.result.get("next_offset").and_then(Value::as_u64).context("activity event completion lacks next_offset")?;
    let events = journal.scan_all()?.into_iter().filter(|entry| entry.entry_type == EntryType::StreamAppended).filter_map(|entry| serde_json::from_value::<StreamAppendedPayload>(entry.payload).ok()).filter(|append| append.stream == state.stream() && append.offset >= from && append.offset < next).map(|append| append.message).collect();
    Ok(SubscriptionWake::Events { events, offset: next })
}
fn unread_bytes(unread: &[(JournalEntry, StreamAppendedPayload)]) -> usize { unread.iter().filter_map(|(_, append)| serde_json::to_vec(&append.message).ok()).map(|bytes| bytes.len()).sum() }
fn pending(unread: &[(JournalEntry, StreamAppendedPayload)]) -> Option<PendingRange> { Some(PendingRange { from: unread.first()?.1.offset, to: unread.last()?.1.offset.saturating_add(1) }) }
