use std::collections::BTreeMap;

use thiserror::Error;

use crate::entry::{EntryType, EpochSummaryPayload, JournalEntry, SegmentClosedPayload};

pub trait Journal {
    fn append(&mut self, entry: &JournalEntry) -> Result<JournalEntry, JournalError>;
    fn scan_segment(&self, segment_id: i64) -> Result<Vec<JournalEntry>, JournalError>;
    fn current_segment(&self) -> Result<i64, JournalError>;
    fn rollover(
        &mut self,
        summary: EpochSummaryPayload,
        at_ms: i64,
    ) -> Result<Vec<JournalEntry>, JournalError>;
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("journal operation failed: {0}")]
pub struct JournalError(pub String);

/// In-memory protocol implementation for pure state-machine tests.
#[derive(Debug, Clone)]
pub struct MemoryJournal {
    run_id: String,
    current_segment: i64,
    next_seq: i64,
    segments: BTreeMap<i64, Vec<JournalEntry>>,
}

impl MemoryJournal {
    pub fn new(run_id: impl Into<String>) -> Self {
        Self {
            run_id: run_id.into(),
            current_segment: 1,
            next_seq: 1,
            segments: BTreeMap::from([(1, Vec::new())]),
        }
    }
}

impl Journal for MemoryJournal {
    fn append(&mut self, entry: &JournalEntry) -> Result<JournalEntry, JournalError> {
        if entry.run_id != self.run_id {
            return Err(JournalError("run id mismatch".to_owned()));
        }
        if entry.segment_id != 0 && entry.segment_id != self.current_segment {
            return Err(JournalError("entry targets a closed segment".to_owned()));
        }
        let mut persisted = entry.clone();
        persisted.seq = self.next_seq;
        persisted.segment_id = self.current_segment;
        self.next_seq += 1;
        self.segments
            .get_mut(&self.current_segment)
            .expect("current in-memory segment")
            .push(persisted.clone());
        Ok(persisted)
    }

    fn scan_segment(&self, segment_id: i64) -> Result<Vec<JournalEntry>, JournalError> {
        self.segments
            .get(&segment_id)
            .cloned()
            .ok_or_else(|| JournalError(format!("unknown segment {segment_id}")))
    }

    fn current_segment(&self) -> Result<i64, JournalError> {
        Ok(self.current_segment)
    }

    fn rollover(
        &mut self,
        mut summary: EpochSummaryPayload,
        at_ms: i64,
    ) -> Result<Vec<JournalEntry>, JournalError> {
        let next_segment = self.current_segment + 1;
        summary.epoch = next_segment;
        summary.prev_segment_id = self.current_segment;
        let closed = self.append(&JournalEntry::new(
            EntryType::SegmentClosed,
            self.run_id.clone(),
            None,
            None,
            at_ms,
            SegmentClosedPayload {
                next_segment_id: next_segment,
            },
        ))?;
        self.current_segment = next_segment;
        self.segments.insert(next_segment, Vec::new());
        let opened = self.append(&JournalEntry::new(
            EntryType::EpochSummary,
            self.run_id.clone(),
            None,
            None,
            at_ms,
            summary,
        ))?;
        Ok(vec![closed, opened])
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::JOURNAL_VERSION;
    use crate::entry::Budget;

    #[test]
    fn memory_journal_assigns_sequences_and_rolls_epochs() {
        let mut journal = MemoryJournal::new("run");
        let first = journal
            .append(&JournalEntry::new(
                EntryType::RunSpawned,
                "run",
                None,
                None,
                0,
                serde_json::json!({}),
            ))
            .unwrap();
        assert_eq!((first.seq, first.segment_id), (1, 1));
        let entries = journal
            .rollover(
                EpochSummaryPayload {
                    epoch: 0,
                    prev_segment_id: 0,
                    journal_version: JOURNAL_VERSION,
                    steps_done: BTreeMap::new(),
                    steps_open: BTreeMap::new(),
                    open_waits: BTreeMap::new(),
                    stream_state: BTreeMap::new(),
                    pinned_revisions: BTreeMap::new(),
                    budget_spent: Budget::default(),
                    memory: BTreeMap::new(),
                },
                10,
            )
            .unwrap();
        assert_eq!(entries[0].entry_type, EntryType::SegmentClosed);
        assert_eq!((entries[1].seq, entries[1].segment_id), (3, 2));
    }
}
