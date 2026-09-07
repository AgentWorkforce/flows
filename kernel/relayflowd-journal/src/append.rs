use relayflowd_core::{
    EffectConfirmedPayload, EffectRecordedPayload, EntryType, JournalEntry, StreamAppendedPayload,
};
use rusqlite::{OptionalExtension, Row, Transaction, TransactionBehavior, params};
use serde_json::{Map, Value};

use crate::{JournalStoreError, SqliteJournal};

impl SqliteJournal {
    pub(crate) fn append_entry(
        &mut self,
        entry: &JournalEntry,
    ) -> Result<JournalEntry, JournalStoreError> {
        if entry.run_id != self.run_id {
            return Err(JournalStoreError::WrongRun {
                expected: self.run_id.clone(),
                actual: entry.run_id.clone(),
            });
        }
        let current_segment: i64 =
            self.connection
                .query_row("SELECT MAX(segment_id) FROM segments", [], |row| row.get(0))?;
        if entry.segment_id != 0 && entry.segment_id != current_segment {
            return Err(JournalStoreError::WrongSegment {
                expected: current_segment,
                actual: entry.segment_id,
            });
        }

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let terminal: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM entries WHERE entry_type = ?1)",
            [EntryType::RunCompleted.as_str()],
            |row| row.get(0),
        )?;
        if terminal {
            return Err(JournalStoreError::RunTerminal(self.run_id.clone()));
        }
        let persisted = insert_entry(&transaction, &self.run_id, current_segment, entry)?;
        transaction.commit()?;
        Ok(persisted)
    }
}

pub(crate) fn insert_entry(
    transaction: &Transaction<'_>,
    run_id: &str,
    segment_id: i64,
    entry: &JournalEntry,
) -> Result<JournalEntry, JournalStoreError> {
    let mut persisted = entry.clone();
    persisted.segment_id = segment_id;

    let election = if entry.entry_type == EntryType::EffectRecorded {
        Some(elect_effect(transaction, entry, &mut persisted)?)
    } else {
        None
    };

    let stream = if entry.entry_type == EntryType::StreamAppended {
        let stream: StreamAppendedPayload = serde_json::from_value(entry.payload.clone())?;
        let expected: u64 = transaction.query_row(
            "SELECT COALESCE(MAX(offset) + 1, 0) FROM stream_index WHERE stream = ?1",
            [&stream.stream],
            |row| row.get(0),
        )?;
        if stream.offset != expected {
            return Err(JournalStoreError::InvalidStreamOffset {
                stream: stream.stream,
                expected,
                actual: stream.offset,
            });
        }
        Some(stream)
    } else {
        None
    };

    let payload = canonical_json(&persisted.payload)?;
    transaction.execute(
        "INSERT INTO entries(segment_id, entry_type, step_id, attempt, at_ms, payload)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            segment_id,
            entry.entry_type.as_str(),
            entry.step_id,
            entry.attempt,
            entry.at_ms,
            payload
        ],
    )?;
    let seq = transaction.last_insert_rowid();
    persisted.seq = seq;
    crate::placement::validate_entry(transaction, run_id, &persisted)?;
    crate::memory::validate_entry(transaction, run_id, &persisted)?;
    crate::channel::validate_entry(transaction, run_id, &persisted)?;

    if entry.entry_type == EntryType::EffectConfirmed {
        confirm_effect(transaction, entry, seq)?;
    }
    if let Some(Election::Won {
        step_id,
        idempotency_key,
        surface_path,
        attempt,
    }) = election
    {
        // The election row is an index of who owes the provider call. Winning
        // it a second time is a reclaim of an election nobody confirmed, so the
        // row moves to the live attempt rather than being inserted twice.
        transaction.execute(
            "INSERT INTO effects(step_id, idempotency_key, surface_path, entry_seq, attempt, confirmed_seq)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL)
             ON CONFLICT(step_id, idempotency_key, surface_path)
             DO UPDATE SET entry_seq = ?4, attempt = ?5",
            params![step_id, idempotency_key, surface_path, seq, attempt],
        )?;
    }
    if let Some(stream) = stream {
        transaction.execute(
            "INSERT INTO stream_index(stream, offset, entry_seq) VALUES (?1, ?2, ?3)",
            params![stream.stream, stream.offset, seq],
        )?;
    }
    persisted.run_id = run_id.to_owned();
    Ok(persisted)
}

/// Who owes the provider call after this `effect.recorded` append.
enum Election {
    /// This attempt must perform the writeback and then confirm it.
    Won {
        step_id: String,
        idempotency_key: String,
        surface_path: String,
        attempt: u32,
    },
    /// A confirmed election already covers it: suppress the provider call.
    Deduped,
}

/// Appendix A rule 5, made atomic with the provider call. Election alone never
/// suppresses a retry: only a *confirmed* election proves the writeback
/// happened. An election left unconfirmed — the worker died between recording
/// and calling the provider — is reclaimed by the next attempt, so the effect
/// still happens exactly once rather than never.
fn elect_effect(
    transaction: &Transaction<'_>,
    entry: &JournalEntry,
    persisted: &mut JournalEntry,
) -> Result<Election, JournalStoreError> {
    let mut effect: EffectRecordedPayload = serde_json::from_value(entry.payload.clone())?;
    let step_id = entry
        .step_id
        .as_deref()
        .ok_or(JournalStoreError::MissingStep("effect.recorded"))?;
    let attempt = entry.attempt.ok_or(JournalStoreError::MissingAttempt {
        entry: "effect.recorded",
    })?;
    let held: Option<(u32, Option<i64>)> = transaction
        .query_row(
            "SELECT attempt, confirmed_seq FROM effects
             WHERE step_id = ?1 AND idempotency_key = ?2 AND surface_path = ?3",
            params![step_id, effect.idempotency_key, effect.surface_path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    // A live attempt re-recording its own unconfirmed election has not proven
    // anything, but it is still the holder: reclaim belongs to a *later*
    // attempt, which by construction means the holder is dead.
    effect.deduped = matches!(held, Some((holder, confirmed))
        if confirmed.is_some() || holder == attempt);
    persisted.payload = serde_json::to_value(&effect)?;
    Ok(if effect.deduped {
        Election::Deduped
    } else {
        Election::Won {
            step_id: step_id.to_owned(),
            idempotency_key: effect.idempotency_key,
            surface_path: effect.surface_path,
            attempt,
        }
    })
}

/// Close the election this attempt won: the provider call happened, so no later
/// attempt may reclaim it. Fail closed — an attempt that does not hold the
/// election cannot confirm one.
fn confirm_effect(
    transaction: &Transaction<'_>,
    entry: &JournalEntry,
    seq: i64,
) -> Result<(), JournalStoreError> {
    let effect: EffectConfirmedPayload = serde_json::from_value(entry.payload.clone())?;
    let step_id = entry
        .step_id
        .as_deref()
        .ok_or(JournalStoreError::MissingStep("effect.confirmed"))?;
    let attempt = entry.attempt.ok_or(JournalStoreError::MissingAttempt {
        entry: "effect.confirmed",
    })?;
    let changed = transaction.execute(
        "UPDATE effects SET confirmed_seq = ?5
         WHERE step_id = ?1 AND idempotency_key = ?2 AND surface_path = ?3 AND attempt = ?4",
        params![
            step_id,
            effect.idempotency_key,
            effect.surface_path,
            attempt,
            seq
        ],
    )?;
    if changed == 0 {
        return Err(JournalStoreError::UnelectedEffect {
            step_id: step_id.to_owned(),
            surface_path: effect.surface_path,
            attempt,
        });
    }
    Ok(())
}

pub(crate) fn entry_from_row(row: &Row<'_>, run_id: &str) -> Result<JournalEntry, rusqlite::Error> {
    let entry_type: String = row.get(2)?;
    let payload: String = row.get(6)?;
    let attempt: Option<i64> = row.get(4)?;
    let entry_type = EntryType::parse(&entry_type).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            2,
            rusqlite::types::Type::Text,
            format!("unknown journal entry type {entry_type:?}").into(),
        )
    })?;
    let payload = serde_json::from_str(&payload).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(JournalEntry {
        seq: row.get(0)?,
        segment_id: row.get(1)?,
        entry_type,
        run_id: run_id.to_owned(),
        step_id: row.get(3)?,
        attempt: attempt.map(|value| value as u32),
        at_ms: row.get(5)?,
        payload,
    })
}

fn canonical_json(value: &Value) -> Result<String, serde_json::Error> {
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Object(object) => {
                let mut keys = object.keys().collect::<Vec<_>>();
                keys.sort_unstable();
                let mut result = Map::new();
                for key in keys {
                    result.insert(key.clone(), sorted(&object[key]));
                }
                Value::Object(result)
            }
            Value::Array(values) => Value::Array(values.iter().map(sorted).collect()),
            other => other.clone(),
        }
    }
    serde_json::to_string(&sorted(value))
}
