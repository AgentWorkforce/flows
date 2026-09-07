//! Run-local, acknowledged FIFO channels. Receiving journals a delivery before
//! exposing its message; only an acknowledgement advances the consumer cursor.
//! Consumer and producer identities are stable step ids, never worker sessions.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::{EntryType, JournalEntry, RunState, StepKind, StepState};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelActor {
    pub run_id: String,
    pub step_id: String,
    pub attempt: u32,
    pub idempotency_key: String,
}

#[derive(Debug, Clone)]
pub enum ChannelCommand {
    Append { message_id: String, message: Value },
    Receive,
    Acknowledge { delivery_seq: i64 },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ChannelAppendedPayload {
    pub channel: String,
    /// One-based; consumer offset zero means nothing acknowledged.
    pub offset: u64,
    pub producer: String,
    /// Stable within (channel, producer), including across attempt retries.
    pub message_id: String,
    pub message: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ChannelDeliveredPayload {
    pub channel: String,
    pub consumer: String,
    pub offset: u64,
    pub message: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ChannelAcknowledgedPayload {
    pub channel: String,
    pub consumer: String,
    pub offset: u64,
    pub delivery_seq: i64,
}

#[derive(Debug, Error)]
pub enum ChannelError {
    #[error("invalid channel operation: {0}")]
    Invalid(String),
    #[error("invalid channel payload: {0}")]
    Payload(#[from] serde_json::Error),
}

fn require(condition: bool, detail: &str) -> Result<(), ChannelError> {
    if condition {
        Ok(())
    } else {
        Err(ChannelError::Invalid(detail.to_owned()))
    }
}

/// Decode once when applying a fact; decisions use typed fields while replies
/// and replay retain the original journal entry, including its metadata.
#[derive(Debug, Clone, PartialEq)]
struct ChannelFact<P> {
    entry: JournalEntry,
    payload: P,
}

/// A projection of journal facts, with no I/O, timers, or session state.
/// Retained entries also supply append deduplication and historical deliveries.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChannelState {
    messages: BTreeMap<String, Vec<ChannelFact<ChannelAppendedPayload>>>,
    deliveries: BTreeMap<i64, ChannelFact<ChannelDeliveredPayload>>,
    acknowledgements: BTreeMap<(String, String), ChannelFact<ChannelAcknowledgedPayload>>,
}

impl ChannelState {
    pub fn fold(entries: &[JournalEntry]) -> Result<Self, ChannelError> {
        let mut state = Self::default();
        for entry in entries {
            state.apply(entry)?;
        }
        Ok(state)
    }

    pub fn offset(&self, channel: &str, consumer: &str) -> u64 {
        self.acknowledgements
            .get(&(channel.to_owned(), consumer.to_owned()))
            .map(|fact| fact.payload.offset)
            .unwrap_or(0)
    }

    /// Historical delivery order, including retries. Replay never calls receive
    /// or executes consumer code: it reads these already committed facts.
    pub fn deliveries(&self) -> impl Iterator<Item = &JournalEntry> {
        self.deliveries.values().map(|fact| &fact.entry)
    }

    pub fn apply(&mut self, entry: &JournalEntry) -> Result<(), ChannelError> {
        match entry.entry_type {
            EntryType::ChannelAppended => {
                let p: ChannelAppendedPayload = serde_json::from_value(entry.payload.clone())?;
                require(
                    !p.channel.is_empty() && !p.message_id.is_empty(),
                    "empty channel or message id",
                )?;
                require(
                    entry.step_id.as_deref() == Some(&p.producer),
                    "producer does not match step",
                )?;
                let messages = self
                    .messages
                    .get(&p.channel)
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                require(
                    p.offset == messages.len() as u64 + 1,
                    "append offset is not consecutive",
                )?;
                require(
                    !messages.iter().any(|e| {
                        e.payload.producer == p.producer && e.payload.message_id == p.message_id
                    }),
                    "duplicate message id",
                )?;
                self.messages
                    .entry(p.channel.clone())
                    .or_default()
                    .push(ChannelFact {
                        entry: entry.clone(),
                        payload: p,
                    });
            }
            EntryType::ChannelDelivered => {
                let p: ChannelDeliveredPayload = serde_json::from_value(entry.payload.clone())?;
                require(
                    entry.step_id.as_deref() == Some(&p.consumer),
                    "consumer does not match step",
                )?;
                require(
                    p.offset == self.offset(&p.channel, &p.consumer) + 1,
                    "delivery must be next unacknowledged message",
                )?;
                let message = self
                    .message(&p.channel, p.offset)
                    .ok_or_else(|| ChannelError::Invalid("delivery has no append".into()))?;
                require(
                    message.payload.message == p.message,
                    "delivery differs from appended message",
                )?;
                require(
                    !self.deliveries.contains_key(&entry.seq),
                    "duplicate delivery sequence",
                )?;
                self.deliveries.insert(
                    entry.seq,
                    ChannelFact {
                        entry: entry.clone(),
                        payload: p,
                    },
                );
            }
            EntryType::ChannelAcknowledged => {
                let p: ChannelAcknowledgedPayload = serde_json::from_value(entry.payload.clone())?;
                require(
                    entry.step_id.as_deref() == Some(&p.consumer),
                    "consumer does not match step",
                )?;
                let delivery = self.delivery(&p.channel, &p.consumer, p.delivery_seq)?;
                require(
                    delivery.payload.offset == p.offset,
                    "acknowledgement offset differs from delivery",
                )?;
                require(
                    p.offset == self.offset(&p.channel, &p.consumer) + 1,
                    "acknowledgement must advance exactly one message",
                )?;
                self.acknowledgements.insert(
                    (p.channel.clone(), p.consumer.clone()),
                    ChannelFact {
                        entry: entry.clone(),
                        payload: p,
                    },
                );
            }
            _ => {}
        }
        Ok(())
    }

    fn message(&self, channel: &str, offset: u64) -> Option<&ChannelFact<ChannelAppendedPayload>> {
        let index = usize::try_from(offset.checked_sub(1)?).ok()?;
        self.messages.get(channel)?.get(index)
    }

    fn delivery(
        &self,
        channel: &str,
        consumer: &str,
        seq: i64,
    ) -> Result<&ChannelFact<ChannelDeliveredPayload>, ChannelError> {
        let delivery = self
            .deliveries
            .get(&seq)
            .ok_or_else(|| ChannelError::Invalid("unknown delivery sequence".into()))?;
        require(
            delivery.payload.channel == channel && delivery.payload.consumer == consumer,
            "delivery belongs to another channel or consumer",
        )?;
        Ok(delivery)
    }

    /// Returns a proposed entry (`seq == 0`), an existing idempotent result,
    /// or None for an empty receive. The caller MUST persist proposals before
    /// returning them to a worker, under the same lock used to load this state.
    pub fn decide(
        &self,
        actor: &ChannelActor,
        channel: &str,
        command: ChannelCommand,
        at_ms: i64,
    ) -> Result<Option<JournalEntry>, ChannelError> {
        require(!channel.is_empty(), "empty channel")?;
        let (kind, payload) = match command {
            ChannelCommand::Append {
                message_id,
                message,
            } => {
                require(!message_id.is_empty(), "empty message id")?;
                let messages = self
                    .messages
                    .get(channel)
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                if let Some(existing) = messages.iter().find(|e| {
                    e.payload.producer == actor.step_id && e.payload.message_id == message_id
                }) {
                    require(
                        existing.payload.message == message,
                        "message id reused with different content",
                    )?;
                    return Ok(Some(existing.entry.clone()));
                }
                (
                    EntryType::ChannelAppended,
                    serde_json::to_value(ChannelAppendedPayload {
                        channel: channel.to_owned(),
                        offset: messages.len() as u64 + 1,
                        producer: actor.step_id.clone(),
                        message_id,
                        message,
                    })?,
                )
            }
            ChannelCommand::Receive => {
                let offset = self.offset(channel, &actor.step_id) + 1;
                let Some(message) = self.message(channel, offset) else {
                    return Ok(None);
                };
                (
                    EntryType::ChannelDelivered,
                    serde_json::to_value(ChannelDeliveredPayload {
                        channel: channel.to_owned(),
                        consumer: actor.step_id.clone(),
                        offset,
                        message: message.payload.message.clone(),
                    })?,
                )
            }
            ChannelCommand::Acknowledge { delivery_seq } => {
                let delivery = self.delivery(channel, &actor.step_id, delivery_seq)?;
                let offset = delivery.payload.offset;
                let current = self.offset(channel, &actor.step_id);
                if offset <= current {
                    return Ok(self
                        .acknowledgements
                        .get(&(channel.to_owned(), actor.step_id.clone()))
                        .map(|fact| fact.entry.clone()));
                }
                require(offset == current + 1, "acknowledgement would skip messages")?;
                (
                    EntryType::ChannelAcknowledged,
                    serde_json::to_value(ChannelAcknowledgedPayload {
                        channel: channel.to_owned(),
                        consumer: actor.step_id.clone(),
                        offset,
                        delivery_seq,
                    })?,
                )
            }
        };
        Ok(Some(JournalEntry::new(
            kind,
            &actor.run_id,
            Some(actor.step_id.clone()),
            Some(actor.attempt),
            at_ms,
            payload,
        )))
    }
}

/// The socket additionally verifies that the caller holds this worker lease.
/// Keep the durable attempt check inside the journal transaction as well.
pub fn validate_channel_actor(
    state: &RunState,
    actor: &ChannelActor,
    channel: &str,
    command: &ChannelCommand,
) -> Result<(), ChannelError> {
    require(state.run_id == actor.run_id, "run id mismatch")?;
    require(
        state.completion.is_none() && state.cancel_requested.is_none(),
        "run is terminal or canceling",
    )?;
    let step = state
        .spec
        .step(&actor.step_id)
        .ok_or_else(|| ChannelError::Invalid("unknown step".into()))?;
    let StepKind::Agent { surfaces, .. } = &step.kind else {
        return Err(ChannelError::Invalid(
            "channel caller must be an agent".into(),
        ));
    };
    if matches!(command, ChannelCommand::Append { .. }) {
        require(
            surfaces
                .streams
                .iter()
                .any(|surface| surface.stream == channel),
            "channel is not a declared writable stream",
        )?;
    }
    require(
        matches!(&state.steps[&actor.step_id].state, StepState::Running { attempt, idempotency_key, .. }
        if *attempt == actor.attempt && *idempotency_key == actor.idempotency_key),
        "channel caller does not match active attempt",
    )
}

#[cfg(test)]
mod tests;
