//! Local test router adapter; Cloud supplies its own authorized ingress.
use super::*;

impl<C: Clock> Engine<C> {
    /// Repository-owned local router adapter. Cloud performs the corresponding
    /// binding and authorization work outside this tenant-unaware kernel.
    #[doc(hidden)]
    pub fn append_local_subscription_event(
        &self,
        run_id: &str,
        event_type: &str,
        payload: Value,
        delivery_id: Option<&str>,
        actor: Option<&str>,
    ) -> Result<usize> {
        let journal = self.open_run(run_id)?;
        let entries = journal.scan_all()?;
        let run_identity = entries
            .iter()
            .find(|entry| entry.entry_type == EntryType::RunSpawned)
            .map(|entry| serde_json::from_value::<RunSpawnedPayload>(entry.payload.clone()))
            .transpose()?
            .map(|spawned| spawned.created_by);
        let matched =
            subscriptions(&journal)?
                .into_iter()
                .filter_map(|(id, state)| {
                    (state.closed.is_none()
                        && state.overflow_fence.is_none()
                        && state
                            .opened
                            .event_types
                            .iter()
                            .any(|kind| kind == event_type)
                        && state.opened.pattern.as_ref().is_none_or(|pattern| {
                            relayflowd_core::event::matches(pattern, &payload)
                        })
                        && (state.opened.include_self || actor != run_identity.as_deref()))
                    .then_some(id)
                })
                .collect::<Vec<_>>();
        drop(journal);
        if matched.is_empty() {
            return Ok(0);
        }
        let delivery_id = delivery_id
            .filter(|id| !id.is_empty())
            .context("body subscription frame requires a provider delivery id")?;
        let frame = json!({"type": event_type, "payload": payload});
        let mut appended = 0;
        for id in matched {
            if self.append_subscription_frame(run_id, &id, delivery_id, frame.clone())? {
                appended += 1;
            }
        }
        Ok(appended)
    }
}
