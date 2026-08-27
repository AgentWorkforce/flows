use relayflowd_core::{EffectRecordedPayload, EntryType, JournalEntry, StreamAppendedPayload};
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

    let new_effect = if entry.entry_type == EntryType::EffectRecorded {
        let mut effect: EffectRecordedPayload = serde_json::from_value(entry.payload.clone())?;
        let step_id = entry
            .step_id
            .as_deref()
            .ok_or(JournalStoreError::MissingStep("effect.recorded"))?;
        let winner: Option<i64> = transaction
            .query_row(
                "SELECT entry_seq FROM effects
                 WHERE step_id = ?1 AND idempotency_key = ?2 AND surface_path = ?3",
                params![step_id, effect.idempotency_key, effect.surface_path],
                |row| row.get(0),
            )
            .optional()?;
        effect.deduped = winner.is_some();
        persisted.payload = serde_json::to_value(&effect)?;
        (!effect.deduped).then_some((step_id.to_owned(), effect))
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

    if let Some((step_id, effect)) = new_effect {
        transaction.execute(
            "INSERT INTO effects(step_id, idempotency_key, surface_path, entry_seq)
             VALUES (?1, ?2, ?3, ?4)",
            params![step_id, effect.idempotency_key, effect.surface_path, seq],
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
