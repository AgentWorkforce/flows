# NEXT — work package for this tick

**Scope:** Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side.

**Context:** RFC-0001 §3 gate 2 is done when "hn-monitor runs as a relayflow in production, triggered by its real events, with zero bespoke persistence." Every primitive already exists in this repo — event triggers (PR #14, `kernel/relayflowd/tests/event_wake.rs`), the flow spec (`testdata/hn-monitor.flow.yaml`), the poller (`sdk/src/hn-poller.ts`), the agent worker (`sdk/src/worker.ts` from PR #53), a one-shot demo (`sdk/src/demo-hn-monitor.ts`) — but nothing has ever run them together as a continuous workload. This PR fixes that.

## Objective

Add `sdk/src/hn-monitor-runner.ts`. It composes the existing pieces into a continuous runner:

- constructs a `JournalClient` connected to the running `relayflowd` socket
- constructs an `AgentWorker` (from `sdk/src/worker.ts`) and calls `worker.attach()` for `agent` steps
- loops:
  1. `pollHackerNewsOnce(spec, sink)` (from `sdk/src/hn-poller.ts`)
  2. sleep `POLL_INTERVAL_MS` (env-configurable, default 60000 = 60s)
  3. exit on SIGTERM/SIGINT cleanly (drain in-flight steps, close client)
- exported from `sdk/src/index.ts`

Keep it small and honest:
- the worker must attach BEFORE the first poll (a run parked because no worker attached is only revived by `run.resume`; the live-kernel suite pins this)
- no retry inside the poller (`hn-poller.ts` already handles single-fetch failures with a typed error; the loop just moves to the next tick)
- no scheduling logic beyond the sleep (the kernel owns retry and dedupe policy)
- no LLM calls; the runner is glue, not a reviewer
- graceful shutdown: SIGTERM sets a shutdown flag; current poll finishes; worker drains via `worker.close()` (already exists in `sdk/src/worker.ts:41`)

## Files in scope

- `sdk/src/hn-monitor-runner.ts` (new)
- `sdk/src/index.ts` (add export)
- `sdk/tests/hn-monitor-runner.test.ts` (new)

## Definition of done

- `sdk/src/hn-monitor-runner.ts` exists, exports `HnMonitorRunner` class or `startHnMonitor` function (implementation choice justified in code comments)
- `sdk/src/index.ts` exports the new runner
- `sdk/tests/hn-monitor-runner.test.ts` exists and covers:
  - fake fetch + mock journal client → runner submits an event on each tick
  - SIGTERM handler exits the loop cleanly within one tick
  - worker attach happens before first poll
- EVERY new test confirmed to FAIL against current code (comment out the new source; test fails), with the literal failing output pasted in the delivery
- Tests pass with implementation present. Literal output of `cd sdk && npm test` pasted in the delivery, showing the new tests running and green
- `git status --porcelain` output pasted as final verification

## Out of scope for this tick — DO NOT TOUCH

- `.github/workflows/*` — no GHA changes
- `kernel/*` — the kernel side of gate 2 already works via PR #14
- `workflows/*.yaml` — those are for later sub-PRs
- `ops/AUTODRIVE_BRIEF.md` — the gate2-lead retargets this between sub-PRs
- CLI wrapper — that is sub-PR C, a separate PR
- end-to-end integration test that spins up a real relayflowd — that is sub-PR B, a separate PR
- `sdk/src/demo-hn-monitor.ts` — leave the one-shot demo unchanged
- `sdk/src/hn-poller.ts` — already complete, do not modify
- `sdk/src/worker.ts` — already complete (PR #53), do not modify
