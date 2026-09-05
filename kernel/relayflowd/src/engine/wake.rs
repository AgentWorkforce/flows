use anyhow::{Context, Result};
use relayflowd_core::{
    Clock, EntryType, Event, JournalEntry, RunSpawnedPayload, RunSpec, TriggerSpec,
};
use relayflowd_journal::SqliteJournal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use ulid::Ulid;

use super::{DriveOptions, Engine, RunOutcome, canonical_hash};

/// Default silence budget when a trigger does not declare its own
/// `stale_after_ms`. 5 minutes is long enough not to trip a sluggish
/// external stream during a normal quiet stretch, short enough that a
/// silently-dead poller is caught within a small multiple of that stream's
/// natural cadence. Callers who care set the field explicitly.
const DEFAULT_STALE_AFTER_MS: u64 = 5 * 60 * 1_000;

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
        // Scope the claim to this flow and subscription. A bare key is
        // globally unique, so two flows deriving the same key would suppress
        // one another.
        //
        // A claim whose run was never registered is recovered two ways, and
        // which one applies depends on whether the claiming process is still
        // alive: a claim left by a PREVIOUS boot is repaired by the registry
        // (see `claim_event`), while one this boot cannot turn into a run is
        // handed back explicitly on the failure path below. Before #160 the
        // registry did both, which is what let a concurrent delivery mistake
        // an in-flight claim for wreckage.
        // The flow's stable identity is the canonical hash of its spec — the
        // same value the engine already journals as `spec_hash`. RunSpec has
        // no id, and `name` is optional, so two unnamed flows would collide on
        // a name-derived key.
        let flow_key = crate::engine::canonical_hash(&serde_json::to_value(&spec)?);
        // Refresh subscription liveness on EVERY successful match —
        // deduped or not. Both cases prove the trigger is still firing;
        // suppressing the bump on a duplicate would let a chatty source
        // (same story ID hit twice within a poll interval) look silent to
        // the sweep. Written before claim_event so a same-key retry after
        // a crash still refreshes the row.
        // Bounds-check via the shared helper on TriggerSpec so this
        // path and `spec::validate` cannot drift. If the resolved
        // budget does not fit in i64 the subscription would be
        // un-stale-able (fail-OPEN — the silent-death mode this
        // feature guards). Spec-level validation should have caught
        // this earlier; this is defense-in-depth.
        let stale_after_ms = trigger
            .effective_stale_after_ms(DEFAULT_STALE_AFTER_MS)
            .map_err(|ms| {
                anyhow::anyhow!(
                    "trigger {id} declared stale_after_ms={ms} which exceeds i64 range; \
                     the liveness sweep cannot represent this budget. \
                     Reduce the value in the flow spec.",
                    id = trigger.id,
                )
            })?;
        self.registry()?.upsert_subscription(
            &flow_key,
            &trigger.id,
            &event.event_type,
            stale_after_ms,
            self.clock.now_ms(),
        )?;
        if self
            .registry()?
            .claim_event(&flow_key, &trigger.id, &event_key, &run_id, self.boot_id())?
            .is_some()
        {
            return Ok(EventSubmitOutcome {
                matched: true,
                deduped: true,
                subscription_id: Some(trigger.id),
                run: None,
            });
        }
        // The claim is now held by this boot, and `claim_event` will tell any
        // concurrent delivery that the event is a duplicate on the strength of
        // it. That obliges us to either turn it into a registered run or hand
        // it back: a claim kept without a run strands the event inside this
        // process.
        //
        // The span that carries that obligation is a named method rather than
        // an inline block, so its boundary is unmistakable. Work added to
        // `spawn_claimed_run` is covered by the release below; work added after
        // the call is not, and that distinction is the whole invariant.
        let spawned = self.spawn_claimed_run(
            &spec,
            &event,
            &trigger,
            &event_key,
            &run_id,
            stale_after_ms,
            created_by,
        );
        // Released only on the failure path. Once `register` has succeeded the
        // run is discoverable, so a later failure is a run that exists and
        // needs resuming -- not a claim to hand back.
        //
        // TODO(#173): a PANIC between the claim and `register` unwinds past
        // this match without releasing, stranding the event for the life of the
        // boot (a restart clears it -- the claim is then a previous boot's and
        // gets repaired). A Drop guard closes it, and is deliberately a
        // separate change: a Drop that opens a database and cannot report its
        // own failure is a mechanism with its own failure modes, and bundling
        // it here would ship it unreviewed under a fix for something else.
        let journal = match spawned {
            Ok(journal) => journal,
            Err(error) => {
                self.registry()?
                    .release_claim(&flow_key, &trigger.id, &event_key, &run_id)?;
                return Err(error);
            }
        };
        let run = self.drive(journal, spec, DriveOptions::default())?;
        Ok(EventSubmitOutcome {
            matched: true,
            deduped: false,
            subscription_id: Some(trigger.id),
            run: Some(run),
        })
    }

    /// Turn a claim this boot already holds into a registered run.
    ///
    /// Everything here is covered by the caller's release-on-failure path: if
    /// this returns `Err`, the claim is handed back. Once `register` has
    /// succeeded the run is discoverable and the claim is permanent, so
    /// `register` is deliberately the LAST thing this does. Adding work after
    /// it would put that work outside the release guarantee.
    #[allow(clippy::too_many_arguments)]
    fn spawn_claimed_run(
        &self,
        spec: &RunSpec,
        event: &Event,
        trigger: &TriggerSpec,
        event_key: &str,
        run_id: &str,
        stale_after_ms: i64,
        created_by: &str,
    ) -> Result<SqliteJournal> {
        let path = self.run_path(run_id);
        let now_ms = self.clock.now_ms();
        let mut journal =
            SqliteJournal::create(&path, run_id, now_ms).context("create event run journal")?;
        let spec_value = serde_json::to_value(spec)?;
        self.append(
            &mut journal,
            &JournalEntry::new(
                EntryType::RunSpawned,
                run_id,
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
        // Include effective_stale_after_ms so a flow author reading
        // their own journal can see the silence budget that will
        // actually be applied — whether it's the one they declared or
        // the engine default. Without this, `stale_after_ms=None` in
        // the spec was silently indistinguishable from `stale_after_ms:
        // DEFAULT_STALE_AFTER_MS` at the alert boundary.
        self.append(&mut journal, &JournalEntry::new(EntryType::SubscriptionRegistered, run_id, None, None, now_ms,
                json!({"subscription_id": trigger.id, "event_type": event.event_type, "executor": trigger.executor,
                       "effective_stale_after_ms": stale_after_ms})))?;
        self.append(&mut journal, &JournalEntry::new(EntryType::EventReceived, run_id, None, None, now_ms,
                json!({"event": event, "event_key": event_key, "matched_subscription_id": trigger.id})))?;
        self.append(&mut journal, &JournalEntry::new(EntryType::SubscriptionMatched, run_id, None, None, now_ms,
                json!({"subscription_id": trigger.id, "event_key": event_key,
                    "wake_context": {"epoch_summary": {"open_steps": spec.steps.iter().map(|step| &step.id).collect::<Vec<_>>()},
                        "triggering_event": event}})))?;
        self.registry()?
            .register(run_id, &path)
            .context("register event run")?;
        Ok(journal)
    }
}
