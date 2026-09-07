//! Routing is an append-only fact, including across epoch boundaries.
use crate::{JournalStoreError, append::entry_from_row};
use relayflowd_core::{EntryType, EpochSummaryPayload, JournalEntry, RoutingDecision, StateError};
use rusqlite::Transaction;
use std::collections::BTreeMap;

fn decisions(
    tx: &Transaction<'_>,
    run_id: &str,
    before_seq: i64,
) -> Result<BTreeMap<String, RoutingDecision>, JournalStoreError> {
    let mut query = tx.prepare("SELECT seq, segment_id, entry_type, step_id, attempt, at_ms, payload FROM entries WHERE entry_type IN ('step.routed', 'epoch.summary') AND seq < ?1 ORDER BY seq")?;
    let entries = query
        .query_map([before_seq], |row| entry_from_row(row, run_id))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut routing = BTreeMap::new();
    for entry in entries {
        if entry.entry_type == EntryType::EpochSummary {
            routing = serde_json::from_value::<EpochSummaryPayload>(entry.payload)?.routing;
            continue;
        }
        let id = entry.step_id.ok_or(StateError::MissingStep(entry.seq))?;
        let route: RoutingDecision = serde_json::from_value(entry.payload)?;
        if routing.contains_key(&id) {
            return Err(StateError::InvalidRouting {
                step: id,
                detail: "routing decision already recorded".into(),
            }
            .into());
        }
        route
            .validate()
            .map_err(|detail| StateError::InvalidRouting {
                step: id.clone(),
                detail,
            })?;
        routing.insert(id, route);
    }
    Ok(routing)
}

pub(crate) fn validate_entry(
    tx: &Transaction<'_>,
    run_id: &str,
    entry: &JournalEntry,
) -> Result<(), JournalStoreError> {
    if entry.entry_type == EntryType::EpochSummary {
        let summary: EpochSummaryPayload = serde_json::from_value(entry.payload.clone())?;
        if !summary.routing.is_empty() {
            let payload: String = tx.query_row(
                "SELECT payload FROM entries WHERE entry_type = 'run.spawned' ORDER BY seq LIMIT 1",
                [],
                |row| row.get(0),
            )?;
            let spawn: relayflowd_core::RunSpawnedPayload = serde_json::from_str(&payload)?;
            let spec = relayflowd_core::RunSpec::parse(&spawn.spec).map_err(StateError::from)?;
            for (id, route) in &summary.routing {
                if spec.step(id).is_none() {
                    return Err(StateError::UnknownStep(id.clone()).into());
                }
                route
                    .validate()
                    .map_err(|detail| StateError::InvalidRouting {
                        step: id.clone(),
                        detail,
                    })?;
            }
        }
        let previous = decisions(tx, run_id, entry.seq)?;
        if summary.routing != previous {
            return Err(StateError::InvalidRouting {
                step: String::new(),
                detail: "epoch must preserve recorded routing decisions".into(),
            }
            .into());
        }
    }
    if entry.entry_type == EntryType::StepRouted {
        let id = entry
            .step_id
            .as_deref()
            .ok_or(StateError::MissingStep(entry.seq))?;
        let payload: String = tx.query_row(
            "SELECT payload FROM entries WHERE entry_type = 'run.spawned' ORDER BY seq LIMIT 1",
            [],
            |row| row.get(0),
        )?;
        let spawn: relayflowd_core::RunSpawnedPayload = serde_json::from_str(&payload)?;
        let spec = relayflowd_core::RunSpec::parse(&spawn.spec).map_err(StateError::from)?;
        if spec.step(id).is_none() {
            return Err(StateError::UnknownStep(id.into()).into());
        }
        if entry.attempt.is_some() {
            return Err(StateError::InvalidRouting {
                step: id.into(),
                detail: "routing decision must not specify an attempt".into(),
            }
            .into());
        }
        decisions(tx, run_id, i64::MAX)?;
    }
    Ok(())
}

pub(crate) fn carry_summary(
    tx: &Transaction<'_>,
    run_id: &str,
    summary: &mut EpochSummaryPayload,
) -> Result<(), JournalStoreError> {
    summary.routing = decisions(tx, run_id, i64::MAX)?;
    Ok(())
}
