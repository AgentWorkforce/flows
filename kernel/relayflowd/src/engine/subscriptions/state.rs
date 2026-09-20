//! Durable journal folds for body-local event subscriptions.

use std::collections::BTreeMap;

use anyhow::{Context, Result, bail};
use relayflowd_core::{
    EntryType, JournalEntry, StreamAppendedPayload, SubscriptionAcknowledgedPayload,
    SubscriptionClosedPayload, SubscriptionOpenedPayload, SubscriptionOverflowFencedPayload,
    SubscriptionPreparedPayload, WaitCompletedPayload, WaitEventPayload,
};
use relayflowd_journal::SqliteJournal;
use serde_json::Value;

use super::{PendingRange, SubscriptionState, SubscriptionWake};

pub(super) fn subscriptions(
    journal: &SqliteJournal,
) -> Result<BTreeMap<String, SubscriptionState>> {
    let mut states = BTreeMap::new();
    for entry in journal.scan_all()? {
        match entry.entry_type {
            EntryType::SubscriptionOpened => {
                let opened: SubscriptionOpenedPayload = serde_json::from_value(entry.payload)?;
                states.insert(
                    opened.subscription_id.clone(),
                    SubscriptionState {
                        opened,
                        closed: None,
                        acknowledged_offset: 0,
                        last_wake_at_ms: entry.at_ms,
                        active_wait: None,
                        ready: None,
                        overflow_fence: None,
                        next_wait_sequence: 0,
                    },
                );
            }
            EntryType::SubscriptionClosed => {
                let closed: SubscriptionClosedPayload = serde_json::from_value(entry.payload)?;
                if let Some(state) = states.get_mut(&closed.subscription_id) {
                    state.closed = Some(closed.completion_reason);
                }
            }
            EntryType::SubscriptionOverflowFenced => {
                let fence: SubscriptionOverflowFencedPayload =
                    serde_json::from_value(entry.payload)?;
                if let Some(state) = states.get_mut(&fence.subscription_id) {
                    state.overflow_fence = Some(fence);
                }
            }
            EntryType::SubscriptionAcknowledged => {
                let acknowledged: SubscriptionAcknowledgedPayload =
                    serde_json::from_value(entry.payload)?;
                if let Some(state) = states.get_mut(&acknowledged.subscription_id) {
                    state.ready = state
                        .ready
                        .take()
                        .filter(|ready| ready.wait_id != acknowledged.wait_id);
                    if let Some(next) = acknowledged.next_offset {
                        state.acknowledged_offset = state.acknowledged_offset.max(next);
                    }
                }
            }
            EntryType::WaitEvent => {
                let wait: WaitEventPayload = serde_json::from_value(entry.payload)?;
                if let Some(stream) = &wait.stream {
                    if let Some(state) = states.values_mut().find(|state| state.stream() == stream)
                    {
                        state.active_wait = Some(wait);
                        state.next_wait_sequence = state.next_wait_sequence.saturating_add(1);
                    }
                }
            }
            EntryType::WaitCompleted => {
                let completed: WaitCompletedPayload = serde_json::from_value(entry.payload)?;
                for state in states.values_mut() {
                    if state
                        .active_wait
                        .as_ref()
                        .is_some_and(|wait| wait.wait_id == completed.wait_id)
                    {
                        state.active_wait = None;
                        state.last_wake_at_ms = entry.at_ms;
                        state.ready = Some(completed.clone());
                    }
                }
            }
            _ => {}
        }
    }
    Ok(states)
}

/// Prepared records are intentionally absent from the active cursor fold.
/// Cloud owns prepared-only cleanup; this fold permits activation retry after
/// a cell crash without exposing the request to ingress.
pub(super) fn prepared_subscriptions(
    journal: &SqliteJournal,
) -> Result<BTreeMap<String, SubscriptionPreparedPayload>> {
    let mut prepared = BTreeMap::new();
    for entry in journal.scan_all()? {
        match entry.entry_type {
            EntryType::SubscriptionPrepared => {
                let value: SubscriptionPreparedPayload = serde_json::from_value(entry.payload)?;
                prepared.insert(value.subscription_id.clone(), value);
            }
            EntryType::SubscriptionOpened | EntryType::SubscriptionClosed => {
                let id = entry
                    .payload
                    .get("subscription_id")
                    .and_then(Value::as_str)
                    .context("subscription lifecycle entry has no subscription_id")?;
                prepared.remove(id);
            }
            _ => {}
        }
    }
    Ok(prepared)
}

pub(super) fn activity_wait(state: &SubscriptionState, _now: i64) -> WaitEventPayload {
    let idle_at_ms = state.last_wake_at_ms.saturating_add(state.opened.idle_ms);
    WaitEventPayload {
        wait_id: format!(
            "{}/next/{}",
            state.opened.subscription_id, state.next_wait_sequence
        ),
        event_key: state.opened.subscription_id.clone(),
        timeout_at_ms: Some(state.opened.deadline_at_ms),
        stream: Some(state.stream().to_owned()),
        from_offset: Some(state.acknowledged_offset),
        settle_ms: Some(state.opened.settle_ms),
        idle_at_ms: Some(idle_at_ms),
        deadline_at_ms: Some(state.opened.deadline_at_ms),
    }
}
pub(super) fn unread_frames(
    entries: &[JournalEntry],
    state: &SubscriptionState,
) -> Result<Vec<(JournalEntry, StreamAppendedPayload)>> {
    let mut unread = Vec::new();
    for entry in entries
        .iter()
        .filter(|entry| entry.entry_type == EntryType::StreamAppended)
    {
        let append: StreamAppendedPayload = serde_json::from_value(entry.payload.clone())
            .context("decode stream.appended while reading subscription")?;
        if append.stream == state.stream() && append.offset >= state.acknowledged_offset {
            unread.push((entry.clone(), append));
        }
    }
    Ok(unread)
}

pub(super) fn next_stream_offset(entries: &[JournalEntry], stream: &str) -> Result<u64> {
    let mut next = 0;
    for entry in entries
        .iter()
        .filter(|entry| entry.entry_type == EntryType::StreamAppended)
    {
        let append: StreamAppendedPayload = serde_json::from_value(entry.payload.clone())?;
        if append.stream == stream {
            next = next.max(
                append
                    .offset
                    .checked_add(1)
                    .context("subscription offset overflow")?,
            );
        }
    }
    Ok(next)
}

pub(super) fn events_wake(
    unread: &[(JournalEntry, StreamAppendedPayload)],
) -> Result<SubscriptionWake> {
    Ok(SubscriptionWake::Events {
        events: unread
            .iter()
            .map(|(_, append)| append.message.clone())
            .collect(),
        offset: unread
            .last()
            .context("nonempty")?
            .1
            .offset
            .saturating_add(1),
    })
}
pub(super) fn wake_from_completed(
    journal: &SqliteJournal,
    state: &SubscriptionState,
    completed: &WaitCompletedPayload,
) -> Result<SubscriptionWake> {
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
        Some("deadline") => {
            return Ok(SubscriptionWake::Deadline {
                pending: serde_json::from_value(
                    completed
                        .result
                        .get("pending")
                        .context("deadline completion lacks pending range")?
                        .clone(),
                )
                .context("decode deadline pending range")?,
            });
        }
        _ => {}
    }
    let from = completed
        .result
        .get("from_offset")
        .and_then(Value::as_u64)
        .context("activity event completion lacks from_offset")?;
    let next = completed
        .result
        .get("next_offset")
        .and_then(Value::as_u64)
        .context("activity event completion lacks next_offset")?;
    if next <= from {
        bail!("activity completion has an invalid cursor range");
    }
    let mut events = Vec::new();
    for entry in journal
        .scan_all()?
        .into_iter()
        .filter(|entry| entry.entry_type == EntryType::StreamAppended)
    {
        let append: StreamAppendedPayload = serde_json::from_value(entry.payload)
            .context("decode stream.appended while replaying wake")?;
        if append.stream == state.stream() && append.offset >= from && append.offset < next {
            if append.offset != from + events.len() as u64 {
                bail!("activity wake has missing or unordered frames");
            }
            events.push(append.message);
        }
    }
    if next - from != events.len() as u64 {
        bail!("activity wake is missing journaled frames");
    }
    Ok(SubscriptionWake::Events {
        events,
        offset: next,
    })
}
pub(super) fn unread_bytes(unread: &[(JournalEntry, StreamAppendedPayload)]) -> usize {
    unread
        .iter()
        .map(|(_, append)| append.message.to_string().len())
        .sum()
}
pub(super) fn pending(unread: &[(JournalEntry, StreamAppendedPayload)]) -> Option<PendingRange> {
    Some(PendingRange {
        from: unread.first()?.1.offset,
        to: unread.last()?.1.offset.saturating_add(1),
    })
}
