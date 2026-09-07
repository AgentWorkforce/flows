use relayflowd_core::{EntryType, EpochSummaryPayload, JournalEntry, SegmentClosedPayload};
use rusqlite::{TransactionBehavior, params};

use crate::{JournalStoreError, SqliteJournal, append::insert_entry};

impl SqliteJournal {
    pub(crate) fn rollover_segment(
        &mut self,
        mut summary: EpochSummaryPayload,
        at_ms: i64,
    ) -> Result<Vec<JournalEntry>, JournalStoreError> {
        let current_segment: i64 =
            self.connection
                .query_row("SELECT MAX(segment_id) FROM segments", [], |row| row.get(0))?;
        let next_segment = current_segment + 1;
        summary.epoch = next_segment;
        summary.prev_segment_id = current_segment;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        crate::memory::carry_summary(&transaction, &self.run_id, &mut summary)?;

        let closed = insert_entry(
            &transaction,
            &self.run_id,
            current_segment,
            &JournalEntry::new(
                EntryType::SegmentClosed,
                self.run_id.clone(),
                None,
                None,
                at_ms,
                SegmentClosedPayload {
                    next_segment_id: next_segment,
                },
            ),
        )?;
        let opened_seq = closed.seq + 1;
        transaction.execute(
            "INSERT INTO segments(segment_id, journal_version, opened_seq) VALUES (?1, ?2, ?3)",
            params![next_segment, summary.journal_version, opened_seq],
        )?;
        let opened = insert_entry(
            &transaction,
            &self.run_id,
            next_segment,
            &JournalEntry::new(
                EntryType::EpochSummary,
                self.run_id.clone(),
                None,
                None,
                at_ms,
                summary,
            ),
        )?;
        transaction.commit()?;
        Ok(vec![closed, opened])
    }
}
