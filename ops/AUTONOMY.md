# How this build runs for weeks without a human driving it

## The loop

`workflows/drive.yaml` is the Relayflow Lead's tick: sync → assess (one work
package) → build (bounded iterations) → deterministic verify → adversarial
review → PR → honest log. One package per tick, no new work over unfinished
work, PRs only — a human merges.

## Scheduling (silent-death-proof)

The schedule lives in RelayCron (Agent Relay Cloud): a durable alarm plus a
sweep worker that revives any schedule whose alarm was lost. One dropped tick
cannot kill the chain — there is no chain, only a row and a sweep.

    agent-relay cloud schedule workflows/drive.yaml \
      --cron "0 */4 * * *" --timezone Europe/Berlin --name flows-drive

    agent-relay cloud schedules      # inspect
    # pause: delete the schedule; resume: recreate it

## The watchdog (who watches the driver)

A second, daily schedule checks liveness and posts a digest:
- ops/DRIVE-LOG.md fresh within 24h? open PRs not stale > 48h? NEEDS_HUMAN.md
  present? If unhealthy or blocked → escalate to Khaliq. Otherwise a one-line
  digest. Registered as `flows-watchdog` (workflows/watchdog.yaml).

## The human contract (what actually reaches Khaliq)

1. **Merges.** The only recurring duty. The daily digest carries the merge
   queue with evidence; merging from the phone is enough.
2. **needs_human escalations.** Only when a tick writes ops/NEEDS_HUMAN.md
   with an exact question. Answering unblocks the next tick.
3. Nothing else. No poking, no prodding. Silence from the system means the
   watchdog verified health — and the watchdog says so daily, so silence
   from the *watchdog* is itself a signal to check.

## Failure honesty

A tick that fails verification or review opens no PR and logs the failure;
the next tick's assess step reads that log and continues or re-plans. Failed
runs are never reported as completed (Nabis defect #1 family — fail closed).
