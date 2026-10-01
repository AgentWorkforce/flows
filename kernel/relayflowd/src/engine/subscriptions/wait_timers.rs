//! Timer claims for human and exact-event waits sharing the run journal.
use super::*;

impl<C: Clock> Engine<C> {
    pub(super) fn claim_non_activity_wait_timeouts_in_journal(
        &self,
        journal: &mut SqliteJournal,
        now: i64,
    ) -> Result<usize> {
        let mut open = BTreeMap::<String, (Option<String>, Option<u32>, i64)>::new();
        for entry in journal.scan_all()? {
            match entry.entry_type {
                EntryType::WaitHuman => {
                    let wait: relayflowd_core::WaitHumanPayload =
                        serde_json::from_value(entry.payload)?;
                    if let Some(timeout) = wait.timeout_at_ms {
                        open.insert(wait.wait_id, (entry.step_id, entry.attempt, timeout));
                    }
                }
                EntryType::WaitEvent => {
                    let wait: WaitEventPayload = serde_json::from_value(entry.payload)?;
                    if wait.stream.is_none()
                        && let Some(timeout) = wait.timeout_at_ms
                    {
                        open.insert(wait.wait_id, (entry.step_id, entry.attempt, timeout));
                    }
                }
                EntryType::WaitCompleted => {
                    open.remove(
                        &serde_json::from_value::<WaitCompletedPayload>(entry.payload)?.wait_id,
                    );
                }
                _ => {}
            }
        }
        let due = open
            .into_iter()
            .filter(|(_, (_, _, timeout))| *timeout <= now)
            .collect::<Vec<_>>();
        for (wait_id, (step_id, attempt, _)) in &due {
            self.append(
                journal,
                &JournalEntry::new(
                    EntryType::WaitCompleted,
                    journal.run_id(),
                    step_id.clone(),
                    *attempt,
                    now,
                    WaitCompletedPayload {
                        wait_id: wait_id.clone(),
                        completion_reason: WaitCompletionReason::Timeout,
                        result: json!({"timeout": "timeout"}),
                    },
                ),
            )?;
        }
        Ok(due.len())
    }
}
