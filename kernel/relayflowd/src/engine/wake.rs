use anyhow::{Context, Result};
use relayflowd_core::{Clock, EntryType, Event, JournalEntry, RunSpawnedPayload, RunSpec};
use relayflowd_journal::SqliteJournal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use ulid::Ulid;

use super::{DriveOptions, Engine, RunOutcome, canonical_hash};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventSubmitOutcome {
    pub matched: bool,
    pub deduped: bool,
    pub subscription_id: Option<String>,
    pub run: Option<RunOutcome>,
}

impl<C: Clock> Engine<C> {
    pub fn submit_event(
        &self,
        spec: RunSpec,
        event: Event,
        created_by: &str,
    ) -> Result<EventSubmitOutcome> {
        spec.validate().context("invalid run spec")?;
        let Some(trigger) = spec
            .triggers
            .iter()
            .find(|trigger| {
                trigger.event_type.as_deref() == Some(&event.event_type)
                    && trigger.pattern.as_ref().is_none_or(|pattern| {
                        relayflowd_core::event::matches(pattern, &event.payload)
                    })
            })
            .cloned()
        else {
            return Ok(EventSubmitOutcome {
                matched: false,
                deduped: false,
                subscription_id: None,
                run: None,
            });
        };
        let template = trigger
            .dedupe_key_template
            .as_deref()
            .context("matched trigger has no dedupe key template")?;
        let event_key = event
            .key
            .clone()
            .map(Ok)
            .unwrap_or_else(|| relayflowd_core::event::dedupe_key(template, &event))?;
        let run_id = Ulid::new().to_string();
        if self.registry()?.claim_event(&event_key, &run_id)?.is_some() {
            return Ok(EventSubmitOutcome {
                matched: true,
                deduped: true,
                subscription_id: Some(trigger.id),
                run: None,
            });
        }
        let path = self.run_path(&run_id);
        let now_ms = self.clock.now_ms();
        let mut journal =
            SqliteJournal::create(&path, &run_id, now_ms).context("create event run journal")?;
        let spec_value = serde_json::to_value(&spec)?;
        self.append(
            &mut journal,
            &JournalEntry::new(
                EntryType::RunSpawned,
                &run_id,
                None,
                None,
                now_ms,
                RunSpawnedPayload {
                    spec: spec_value.clone(),
                    spec_hash: canonical_hash(&spec_value),
                    parent_run_id: None,
                    journal_version: relayflowd_core::JOURNAL_VERSION,
                    created_by: created_by.to_owned(),
                },
            ),
        )?;
        self.append(&mut journal, &JournalEntry::new(EntryType::SubscriptionRegistered, &run_id, None, None, now_ms,
            json!({"subscription_id": trigger.id, "event_type": event.event_type, "executor": trigger.executor})))?;
        self.append(&mut journal, &JournalEntry::new(EntryType::EventReceived, &run_id, None, None, now_ms,
            json!({"event": event, "event_key": event_key, "matched_subscription_id": trigger.id})))?;
        self.append(&mut journal, &JournalEntry::new(EntryType::SubscriptionMatched, &run_id, None, None, now_ms,
            json!({"subscription_id": trigger.id, "event_key": event_key,
                "wake_context": {"epoch_summary": {"open_steps": spec.steps.iter().map(|step| &step.id).collect::<Vec<_>>()},
                    "triggering_event": event}})))?;
        self.registry()?
            .register(&run_id, &path)
            .context("register event run")?;
        let run = self.drive(journal, spec, DriveOptions::default())?;
        Ok(EventSubmitOutcome {
            matched: true,
            deduped: false,
            subscription_id: Some(trigger.id),
            run: Some(run),
        })
    }
}
