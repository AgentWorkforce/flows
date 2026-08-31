Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side.

**Context:** RFC-0001 §3 gate 2 is done when "hn-monitor runs as a relayflow in production, triggered by its real events, with zero bespoke persistence." Every primitive already exists in this repo — event triggers (PR #14, `kernel/relayflowd/tests/event_wake.rs`), the flow spec (`testdata/hn-monitor.flow.yaml`), the poller (`sdk/src/hn-poller.ts`), the agent worker (`sdk/src/worker.ts` from PR #53), a one-shot demo (`sdk/src/demo-hn-monitor.ts`) — but nothing has ever run them together as a continuous workload. This PR fixes that.

## Do not re-do these

Merged and closed; a PR redoing any will be closed:
  - picker actionability (#42), unterminated backticks (#45)
  - deterministic-command preflight refusal (#47) — do not touch preflight
  - gate-1 race regression test (#48) — do not touch `kernel/relayflowd/src/server/tests.rs` or `server.rs`
  - ops/NEXT.md validation (#50) — do not touch `sdk/src/work-package-validator.ts`
  - SDK agent worker (#53) — `sdk/src/worker.ts` is done and shipped; use it, don't rewrite it
  - SDK pretest hook (#69) — `sdk/package.json` builds the kernel before `npm test`; don't touch

## The task

Add `sdk/src/hn-monitor-runner.ts`. It composes the existing pieces into a continuous runner:

  - constructs a `JournalClient` connected to the running `relayflowd` socket
  - constructs an `AgentWorker` (from `sdk/src/worker.ts`) and calls `workerAttach()` for `agent` steps
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
  - graceful shutdown: SIGTERM sets a shutdown flag; current poll finishes; worker drains via a `workerRelease()` protocol call (add to protocol if missing — but check `sdk/src/protocol.ts` first)

## Definition of done, all of it

  - `sdk/src/hn-monitor-runner.ts` exists, exports `HnMonitorRunner` class (or `startHnMonitor` function — pick and justify) from `sdk/src/index.ts`
  - `sdk/tests/hn-monitor-runner.test.ts` exists and covers:
    - fake fetch + mock journal client → runner submits an event on each tick
    - SIGTERM handler exits the loop cleanly within one tick
    - worker attach happens before first poll
  - `cd sdk && npm test` green with the new tests running (pretest hook builds the kernel automatically)
  - EVERY new test confirmed to FAIL against current code (comment out the new source; test fails), with the literal failing output pasted in your summary
  - as your LAST action, run `git status --porcelain` and paste it

## Out of scope for this tick — DO NOT TOUCH

  - `.github/workflows/*` — no GHA changes
  - `kernel/*` — the kernel side of gate 2 already works via PR #14
  - `workflows/*.yaml` — those are for later sub-PRs
  - `ops/AUTODRIVE_BRIEF.md` — the gate2-lead retargets this between sub-PRs
  - CLI wrapper — that is sub-PR C, a separate PR
  - end-to-end integration test that spins up a real relayflowd — that is sub-PR B, a separate PR

## If you cannot finish

Say so and file what you learned. A minimal runner with an honest gap description beats a complete-looking one that doesn't shut down cleanly.
