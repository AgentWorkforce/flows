//! Enforce one memory fact per step and validate the charge in the same
//! transaction as its append, including raw Journal::append callers.
use crate::{JournalStoreError, append::entry_from_row};
use relayflowd_core::{EntryType, JournalEntry, RunSpawnedPayload, RunSpec, RunState, StateError};
use rusqlite::Transaction;

pub(crate) fn validate_entry(
    tx: &Transaction<'_>,
    run_id: &str,
    entry: &JournalEntry,
) -> Result<(), JournalStoreError> {
    if entry.entry_type != EntryType::MemoryInjected {
        return Ok(());
    }
    let count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM entries WHERE entry_type = 'memory.injected' AND step_id = ?1",
        [&entry.step_id],
        |row| row.get(0),
    )?;
    if count != 1 {
        return Err(StateError::InvalidMemory {
            step: entry.step_id.clone().unwrap_or_default(),
            detail: "a step cannot inject memory twice".into(),
        }
        .into());
    }
    replay(tx, run_id)?;
    Ok(())
}

fn replay(tx: &Transaction<'_>, run_id: &str) -> Result<RunState, JournalStoreError> {
    // TODO(epoch-compaction): #220 must retain memory facts or their summary
    // before historical segments can be removed.
    let mut query = tx.prepare("SELECT seq, segment_id, entry_type, step_id, attempt, at_ms, payload FROM entries ORDER BY seq")?;
    let entries = query
        .query_map([], |row| entry_from_row(row, run_id))?
        .collect::<Result<Vec<_>, _>>()?;
    let spawn = entries
        .iter()
        .find(|entry| entry.entry_type == EntryType::RunSpawned)
        .ok_or_else(|| StateError::InvalidMemory {
            step: String::new(),
            detail: "memory requires a spawned run".into(),
        })?;
    let spawn: RunSpawnedPayload = serde_json::from_value(spawn.payload.clone())?;
    let spec = RunSpec::parse(&spawn.spec).map_err(StateError::from)?;
    Ok(RunState::fold(run_id, spec, &entries)?)
}

/// An epoch must carry packs even if its caller predates step memory. The charge
/// is already included in budget_spent; restoring a pack does not add it again.
pub(crate) fn carry_summary(
    tx: &Transaction<'_>,
    run_id: &str,
    summary: &mut relayflowd_core::EpochSummaryPayload,
) -> Result<(), JournalStoreError> {
    let has_memory: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM entries WHERE entry_type = 'memory.injected')",
        [],
        |row| row.get(0),
    )?;
    if !has_memory {
        return Ok(());
    }
    let state = replay(tx, run_id)?;
    if summary.budget_spent != state.budget {
        return Err(StateError::InvalidMemory {
            step: String::new(),
            detail: "epoch budget must preserve recorded memory spend".into(),
        }
        .into());
    }
    summary.memory = state
        .steps
        .into_iter()
        .filter_map(|(id, step)| step.memory.map(|pack| (id, pack)))
        .collect();
    Ok(())
}
