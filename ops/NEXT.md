# NEXT — work package for this tick

**Gate:** 3
**Pinned by:** This run is launched with an explicit target and must not work on any other gate.

## Objective

Build `sdk/src/hn-monitor-runner.ts`: a continuous polling runner that composes existing primitives (JournalClient, AgentWorker, pollHackerNewsOnce) into a production-ready relayflow workload with graceful shutdown.

## Scope (quoted from the launch brief)

> Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side.
>
> RFC-0001 §3 gate 2 is done when "hn-monitor runs as a relayflow in production, triggered by its real events, with zero bespoke persistence." Every primitive already exists in this repo — event triggers (PR #14, `kernel/relayflowd/tests/event_wake.rs`), the flow spec (`testdata/hn-monitor.flow.yaml`), the poller (`sdk/src/hn-poller.ts`), the agent worker (`sdk/src/worker.ts` from PR #53), a one-shot demo (`sdk/src/demo-hn-monitor.ts`) — but nothing has ever run them together as a continuous workload. This PR fixes that.
>
> Add `sdk/src/hn-monitor-runner.ts`. It composes the existing pieces into a continuous runner:
>
>   - constructs a `JournalClient` connected to the running `relayflowd` socket
>   - constructs an `AgentWorker` (from `sdk/src/worker.ts`) and calls `workerAttach()` for `agent` steps
>   - loops:
>     1. `pollHackerNewsOnce(spec, sink)` (from `sdk/src/hn-poller.ts`)
>     2. sleep `POLL_INTERVAL_MS` (env-configurable, default 60000 = 60s)
>     3. exit on SIGTERM/SIGINT cleanly (drain in-flight steps, close client)
>   - exported from `sdk/src/index.ts`
>
> Keep it small and honest:
>   - the worker must attach BEFORE the first poll (a run parked because no worker attached is only revived by `run.resume`; the live-kernel suite pins this)
>   - no retry inside the poller (`hn-poller.ts` already handles single-fetch failures with a typed error; the loop just moves to the next tick)
>   - no scheduling logic beyond the sleep (the kernel owns retry and dedupe policy)
>   - no LLM calls; the runner is glue, not a reviewer
>   - graceful shutdown: SIGTERM sets a shutdown flag; current poll finishes; worker drains via a `workerRelease()` protocol call (add to protocol if missing — but check `sdk/src/protocol.ts` first)

## Files in scope

- `sdk/src/hn-monitor-runner.ts` (new)
- `sdk/tests/hn-monitor-runner.test.ts` (new)
- `sdk/src/index.ts` (add export)
- `sdk/src/protocol.ts` (only if `workerRelease` is missing and needed)
- `sdk/src/worker.ts` (only if `workerRelease` needs to be added to AgentWorker.close())
- `sdk/src/journal-client.ts` (only if `workerRelease` needs to be wired through)

## Definition of done

ALL of these must hold AND be verified with pasted command output:

1. `sdk/src/hn-monitor-runner.ts` exists and exports either `HnMonitorRunner` class or `startHnMonitor` function
2. The runner is exported from `sdk/src/index.ts`
3. `sdk/tests/hn-monitor-runner.test.ts` exists with tests covering:
   - Worker attaches BEFORE first poll (ordering verified)
   - Fake fetch + mock journal client → runner submits events on each tick
   - SIGTERM handler exits the loop cleanly within one tick
4. EVERY new test CONFIRMED to FAIL against current code before implementation:
   - Comment out the new source file
   - Run the test
   - Paste the literal failing output showing the test fails without the implementation
   - Restore the source
5. `cd sdk && npm test` passes with all tests green, including the new ones. Paste the literal command and output showing test counts.
6. As the LAST action, run `git status --porcelain` and paste it.

## Explicitly OUT of scope — DO NOT TOUCH

- `.github/workflows/*` — no GHA changes
- `kernel/*` — the kernel side of gate 2 already works via PR #14
- `workflows/*.yaml` — those are for later sub-PRs
- `ops/AUTODRIVE_BRIEF.md` — the gate2-lead retargets this between sub-PRs
- CLI wrapper — that is sub-PR C, a separate PR
- End-to-end integration test that spins up a real relayflowd — that is sub-PR B, a separate PR
- Any files from the "Do not re-do these" section: picker actionability (#42), unterminated backticks (#45), deterministic-command preflight refusal (#47), gate-1 race regression test (#48), ops/NEXT.md validation (#50), SDK agent worker (#53), SDK pretest hook (#69)

## Implementation notes

From the scope constraints:

- Worker MUST attach BEFORE first poll (ordering is critical, per `sdk/src/demo-hn-monitor.ts:99-105`)
- No retry logic inside the runner (kernel owns this)
- No scheduling beyond sleep (kernel owns this)
- Graceful shutdown: finish current poll, then close cleanly
- Check if `workerRelease()` exists in `sdk/src/protocol.ts` before adding it

## If blocked

If gate 3 is genuinely unreachable from the current state, write `ops/NEEDS_HUMAN.md` with the exact blocker and the options, then still end with ASSESS_DONE. Do not silently substitute different work. A minimal runner with an honest gap description beats a complete-looking one that doesn't work.
