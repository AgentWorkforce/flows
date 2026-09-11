use super::Engine;
use anyhow::{Context, Result};
use relayflowd_core::{Clock, EntryType, JournalEntry, RunSpec, memoization};
use relayflowd_journal::SqliteJournal;

#[derive(Debug)]
pub struct ReuseError {
    pub code: &'static str,
    pub detail: String,
}
impl std::fmt::Display for ReuseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.detail)
    }
}
impl std::error::Error for ReuseError {}

impl<C: Clock> Engine<C> {
    pub(super) fn reuse_source(&self, run_id: &str, spec: &RunSpec) -> Result<Vec<JournalEntry>> {
        let refusal = |code, detail| ReuseError { code, detail };
        // An untrusted run id must never escape the daemon's data directory.
        if run_id.is_empty()
            || !run_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(refusal(
                "reuse_run_not_found",
                format!("Run {run_id:?} was not found"),
            )
            .into());
        }
        let path = self.run_path(run_id);
        match std::fs::metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(refusal(
                    "reuse_run_not_found",
                    format!("Run {run_id:?} was not found"),
                )
                .into());
            }
            Err(error) => {
                return Err(refusal("reuse_journal_read_failed", error.to_string()).into());
            }
            Ok(_) => {}
        }
        let read = || -> Result<(RunSpec, Vec<JournalEntry>)> {
            let journal = SqliteJournal::open_read_only(&path)?;
            anyhow::ensure!(
                journal.run_id() == run_id,
                "source journal run id differs from requested id"
            );
            Ok((
                journal.run_spec()?,
                memoization::candidates(&journal.scan_all()?)?,
            ))
        };
        let (prior, entries) =
            read().map_err(|error| refusal("reuse_journal_read_failed", format!("{error:#}")))?;
        if spec.name.is_none() || spec.name != prior.name {
            return Err(refusal(
                "reuse_spec_mismatch",
                format!(
                    "Run {run_id:?} must name the same flow (source {:?}, requested {:?})",
                    prior.name, spec.name
                ),
            )
            .into());
        }
        Ok(entries)
    }

    pub(super) fn reuse_snapshot(&self, journal: &SqliteJournal) -> Result<Vec<JournalEntry>> {
        let first = journal.scan_from(1, 1)?;
        match first
            .first()
            .and_then(|entry| entry.payload.get("reuse_candidates"))
        {
            Some(value) => {
                let entries: Vec<JournalEntry> =
                    serde_json::from_value(value.clone()).context("invalid reuse snapshot")?;
                Ok(memoization::candidates(&entries)?)
            }
            None => Ok(Vec::new()),
        }
    }

    /// Central append seam covers local, remote, recovery and cancellation.
    pub(super) fn stamp_completion(
        &self,
        journal: &SqliteJournal,
        entry: &mut JournalEntry,
    ) -> Result<()> {
        if entry.entry_type != EntryType::StepCompleted {
            return Ok(());
        }
        let state = self.load_state(journal, journal.run_spec()?)?;
        let step = state
            .spec
            .step(
                entry
                    .step_id
                    .as_deref()
                    .context("completion step missing")?,
            )
            .context("unknown completion step")?;
        entry.payload["step_spec_hash"] = memoization::step_spec_hash(step).into();
        // Null marks unresolved input on a failed attempt, which is ineligible.
        let input = memoization::resolved_input(&state, step).unwrap_or(serde_json::Value::Null);
        entry.payload["input_hash"] = memoization::canonical_hash(&input).into();
        Ok(())
    }
}
