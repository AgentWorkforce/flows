//! Channel decisions and writes share a SQLite IMMEDIATE transaction. This
//! serializes independent connections too, not just callers sharing a hub.
use relayflowd_core::{
    EntryType, JournalEntry, RunSpawnedPayload, RunSpec, RunState,
    channel::{ChannelActor, ChannelCommand, ChannelState, validate_channel_actor},
};
use rusqlite::{Transaction, TransactionBehavior};

use crate::{
    JournalStoreError, SqliteJournal,
    append::{entry_from_row, insert_entry},
};

impl SqliteJournal {
    /// Returns (result, newly_appended). Existing send/ack results are returned
    /// unchanged on retry. No delivery is visible before the commit succeeds.
    pub fn channel_command(
        &mut self,
        actor: &ChannelActor,
        channel: &str,
        command: ChannelCommand,
        at_ms: i64,
    ) -> Result<(Option<JournalEntry>, bool), JournalStoreError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        // TODO(epoch-compaction): #212 — replace retained-history folds here
        // and in validate_entry with bounded epoch channel snapshots before
        // archived segments can be removed. insert_entry currently folds again.
        let entries = read_entries(&tx, &self.run_id)?;
        if entries
            .iter()
            .any(|e| e.entry_type == EntryType::RunCompleted)
        {
            return Err(JournalStoreError::RunTerminal(self.run_id.clone()));
        }
        let spawned = entries
            .iter()
            .find(|e| e.entry_type == EntryType::RunSpawned)
            .ok_or_else(|| {
                relayflowd_core::channel::ChannelError::Invalid("run has no spawn fact".into())
            })?;
        let payload: RunSpawnedPayload = serde_json::from_value(spawned.payload.clone())?;
        let spec = RunSpec::parse(&payload.spec).map_err(relayflowd_core::StateError::from)?;
        let state = RunState::fold(&self.run_id, spec, &entries)?;
        validate_channel_actor(&state, actor, channel, &command)?;
        // Like stream reads, scan retained segments: a message or its delivery
        // can precede an epoch boundary while its acknowledgement follows it.
        let channels = ChannelState::fold(&entries)?;
        let entry = channels.decide(actor, channel, command, at_ms)?;
        let newly_appended = entry.as_ref().is_some_and(|e| e.seq == 0);
        let result = if newly_appended {
            let entry = entry.expect("new entry");
            let segment =
                tx.query_row("SELECT MAX(segment_id) FROM segments", [], |row| row.get(0))?;
            Some(insert_entry(&tx, &self.run_id, segment, &entry)?)
        } else {
            // A repeated send/ack returns an existing durable fact.
            entry
        };
        tx.commit()?;
        Ok((result, newly_appended))
    }
}

fn read_entries(
    tx: &Transaction<'_>,
    run_id: &str,
) -> Result<Vec<JournalEntry>, JournalStoreError> {
    let mut query = tx.prepare("SELECT seq, segment_id, entry_type, step_id, attempt, at_ms, payload FROM entries ORDER BY seq")?;
    Ok(query
        .query_map([], |row| entry_from_row(row, run_id))?
        .collect::<Result<Vec<_>, _>>()?)
}

/// Also enforce invariants on raw Journal::append, inside its transaction.
pub(crate) fn validate_entry(
    tx: &Transaction<'_>,
    run_id: &str,
    entry: &JournalEntry,
) -> Result<(), JournalStoreError> {
    if !matches!(
        entry.entry_type,
        EntryType::ChannelAppended | EntryType::ChannelDelivered | EntryType::ChannelAcknowledged
    ) {
        return Ok(());
    }
    let mut entries = read_entries(tx, run_id)?;
    entries.retain(|e| e.seq < entry.seq);
    let mut state = ChannelState::fold(&entries)?;
    state.apply(entry)?;
    Ok(())
}

#[cfg(test)]
mod tests;
