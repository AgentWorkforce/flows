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

## The human contract (what actually reaches Khaliq)

1. **Merges.** The only recurring duty.
2. **needs_human escalations.** Only when a tick writes ops/NEEDS_HUMAN.md
   with an exact question. Answering unblocks the next tick.
3. Nothing else. No poking, no prodding.

## Failure honesty

A tick that fails verification or review opens no PR and logs the failure;
the next tick's assess step reads that log and continues or re-plans. Failed
runs are never reported as completed (Nabis defect #1 family — fail closed).
