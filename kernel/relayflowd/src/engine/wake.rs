use std::path::PathBuf;

use anyhow::{Context, Result};
use relayflowd_core::{
    Clock, EntryType, Event, JournalEntry, RunSpawnedPayload, RunSpec, TriggerSpec,
};
use relayflowd_journal::{Registry, SqliteJournal};
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
        // `spawn_claimed_run` is covered by the guard below; work added after
        // `disarm()` is not, and that distinction is the whole invariant.
        //
        // The obligation is discharged by a Drop guard rather than by the `?`
        // paths alone, because an early `return` is not the only way to leave
        // this span: a PANIC unwinds past every match arm, and before #173 that
        // stranded the event for the life of the boot -- every later delivery
        // told "duplicate" with no run to carry it. A restart cleared it, since
        // the claim then belonged to a previous boot, but nothing short of one
        // did.
        let mut claim = ClaimGuard {
            data_dir: self.data_dir.clone(),
            flow_key: flow_key.clone(),
            subscription_id: trigger.id.clone(),
            event_key: event_key.clone(),
            run_id: run_id.clone(),
            armed: true,
        };
        let spawned = self.spawn_claimed_run(
            &spec,
            &event,
            &trigger,
            &event_key,
            &run_id,
            stale_after_ms,
            created_by,
        );
        // The ORDINARY failure path releases explicitly and propagates, because
        // a release that fails is a claim left stranded while later deliveries
        // are told "deduped" with no run behind it -- a runtime failure the
        // caller must see, not one to report and swallow. Routing this through
        // `Drop` alone would have downgraded it to best-effort; the guard is
        // for the path that has no `?` to take.
        //
        // Release BEFORE disarming, so a failing release leaves the guard armed
        // and the unwind still attempts a best-effort cleanup on the way out.
        let journal = match spawned {
            Ok(journal) => journal,
            Err(error) => {
                self.registry()?
                    .release_claim(&flow_key, &trigger.id, &event_key, &run_id)?;
                claim.disarm();
                return Err(error);
            }
        };
        // Disarmed once `register` has succeeded. After that the run is
        // discoverable, so a later failure is a run that exists and needs
        // resuming -- not a claim to hand back.
        claim.disarm();
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

/// Releases an event claim unless the run it names became real.
///
/// `claim_event` tells every concurrent delivery that an event is a duplicate on
/// the strength of a claim row. Whoever takes that claim owes the event either a
/// registered run or the claim back; a claim kept without a run strands the
/// event inside this process, because the same-boot rule then answers
/// "duplicate" to every retry with no run to carry it.
///
/// This exists for the exit that has no `?` to take. The ordinary `Err` path
/// releases explicitly and propagates the failure, because a release that fails
/// there is a runtime failure the caller must see. A panic has no such path: it
/// unwinds past every match arm, and a claim leaked that way survives until the
/// process restarts (#173). Best-effort cleanup is the right trade only where
/// the alternative is no cleanup at all.
///
/// It is the first `Drop` impl in this crate, so the trade is worth stating: a
/// `Drop` cannot return an error and cannot be `?`-ed. A release that fails here
/// is therefore reported and swallowed -- which leaves the event exactly where a
/// leak would have left it, no worse, and never masks the error that caused the
/// unwind in the first place.
struct ClaimGuard {
    data_dir: PathBuf,
    flow_key: String,
    subscription_id: String,
    event_key: String,
    run_id: String,
    armed: bool,
}

impl ClaimGuard {
    /// Called once the run is registered and the claim is permanent.
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ClaimGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        // Open a fresh registry rather than borrowing the engine's: `Drop` runs
        // during an unwind, when holding a borrow of the engine would constrain
        // the guard's lifetime to it for no benefit. `Registry::open` is what
        // every other caller here does per operation anyway.
        let released = Registry::open(self.data_dir.join("relayflowd.sqlite3")).and_then(
            |registry| {
                registry.release_claim(
                    &self.flow_key,
                    &self.subscription_id,
                    &self.event_key,
                    &self.run_id,
                )
            },
        );
        if let Err(error) = released {
            // Report, do not panic. Panicking in `Drop` during an unwind aborts
            // the process, which would turn a stranded event into a dead daemon.
            eprintln!(
                "relayflowd: failed to release event claim for run {run_id} \
                 (flow {flow_key}, subscription {subscription_id}); the event \
                 stays deduped until this process restarts: {error}",
                run_id = self.run_id,
                flow_key = self.flow_key,
                subscription_id = self.subscription_id,
            );
        }
    }
}

#[cfg(test)]
mod claim_guard_tests {
    use super::*;

    const FLOW: &str = "flow";
    const SUB: &str = "sub";
    const KEY: &str = "event-key";
    const BOOT: &str = "boot-1";

    fn guard(data_dir: &std::path::Path, run_id: &str) -> ClaimGuard {
        ClaimGuard {
            data_dir: data_dir.to_path_buf(),
            flow_key: FLOW.to_owned(),
            subscription_id: SUB.to_owned(),
            event_key: KEY.to_owned(),
            run_id: run_id.to_owned(),
            armed: true,
        }
    }

    fn registry(data_dir: &std::path::Path) -> Registry {
        Registry::open(data_dir.join("relayflowd.sqlite3")).unwrap()
    }

    /// Take a claim the way `submit_event` does, without registering a run.
    fn claim(data_dir: &std::path::Path, run_id: &str) {
        assert_eq!(
            registry(data_dir).claim_event(FLOW, SUB, KEY, run_id, BOOT).unwrap(),
            None,
            "the first claim must be granted"
        );
    }

    /// Is the event still deduped? Same-boot, so a surviving claim answers
    /// `Some` and a released one answers `None`.
    fn still_claimed(data_dir: &std::path::Path, next_run: &str) -> bool {
        registry(data_dir)
            .claim_event(FLOW, SUB, KEY, next_run, BOOT)
            .unwrap()
            .is_some()
    }

    #[test]
    fn an_armed_guard_releases_the_claim_when_dropped() {
        let directory = tempfile::tempdir().unwrap();
        claim(directory.path(), "run-a");
        drop(guard(directory.path(), "run-a"));
        assert!(
            !still_claimed(directory.path(), "run-b"),
            "a dropped armed guard must hand the event back"
        );
    }

    #[test]
    fn a_disarmed_guard_leaves_the_claim_alone() {
        let directory = tempfile::tempdir().unwrap();
        claim(directory.path(), "run-a");
        let mut held = guard(directory.path(), "run-a");
        held.disarm();
        drop(held);
        assert!(
            still_claimed(directory.path(), "run-b"),
            "once the run is registered the claim is permanent"
        );
    }

    /// #173 itself. A panic is not an early `return`: it unwinds past every
    /// match arm, and before the guard that leaked the claim for the life of the
    /// boot -- every later delivery told "duplicate" with no run to carry it.
    #[test]
    fn a_panic_between_claim_and_register_still_releases() {
        let directory = tempfile::tempdir().unwrap();
        claim(directory.path(), "run-a");

        let path = directory.path().to_path_buf();
        let unwound = std::panic::catch_unwind(move || {
            let _claim = guard(&path, "run-a");
            panic!("spawn_claimed_run blew up between the claim and register");
        });
        assert!(unwound.is_err(), "the test must actually panic");

        assert!(
            !still_claimed(directory.path(), "run-b"),
            "a claim leaked by a panic strands the event until the process restarts"
        );
    }

    /// A release must not take a claim some other delivery legitimately holds.
    #[test]
    fn a_guard_only_releases_its_own_run() {
        let directory = tempfile::tempdir().unwrap();
        claim(directory.path(), "run-a");
        drop(guard(directory.path(), "run-someone-else"));
        assert!(
            still_claimed(directory.path(), "run-b"),
            "releasing a run that does not hold the claim must be a no-op"
        );
    }
}
