# NEXT — work package for this tick

**Scope:** Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test). Do not conflate the two.

This run is pinned to **gate 2** and must not work on any other gate.

## Objective

Add `sdk/src/hn-monitor-runner.ts`: a continuous runner that composes existing pieces (JournalClient from protocol.ts, AgentWorker from worker.ts, pollHackerNewsOnce from hn-poller.ts) into a workload that polls Hacker News, submits events to the journal, and executes dispatched agent steps.

## Context

RFC-0001 §3 gate 2 is done when "hn-monitor runs as a relayflow in production, triggered by its real events, with zero bespoke persistence." Every primitive already exists in this repo:
- Event triggers (PR #14, `kernel/relayflowd/tests/event_wake.rs`)
- The flow spec (`testdata/hn-monitor.flow.yaml`)
- The poller (`sdk/src/hn-poller.ts`)
- The agent worker (`sdk/src/worker.ts` from PR #53)
- A one-shot demo (`sdk/src/demo-hn-monitor.ts`)

But nothing has ever run them together as a continuous workload. This PR fixes that.

Prior attempt (PR #83, closed) produced a functional runner but was rejected by the swarm on five real findings. This attempt must address:

1. **Fail-closed on journal errors.** Only fetch-level errors (network flakiness, HN API rate limits) may be swallowed; a journal write failure MUST throw and terminate the runner. Split: `try { fetch } catch { onFetchError }` around the network call, `try { eventSubmit } catch { rethrow }` around the journal call.

2. **AgentWorker.close() must release the worker (or explicitly document it does not).** Current `close()` only drains local promises — it does NOT tell the kernel to release the worker registration. Either:
   - Add a `workerRelease` verb to `sdk/src/protocol.ts` and call it from `close()` (preferred), OR
   - Add a one-line comment on `close()` naming exactly what shutdown intentionally does NOT do

3. **Class field declaration order.** Declare ALL fields at the top of the class body, before the constructor.

4. **Signal handlers must be opt-in via AbortSignal.** Accept `signal?: AbortSignal` in options; the CLI wrapper (sub-PR C) can create + wire a process-signal-driven AbortController.

5. **Test coverage for pollError branch.** Tests must assert the loop survives a fetcher throw AND the loop TERMINATES on a journal throw.

## Files in scope

- `sdk/src/hn-monitor-runner.ts` — new file, exports `HnMonitorRunner`
- `sdk/src/worker.ts` — either add `workerRelease` call to `close()`, OR add a one-line comment
- `sdk/src/protocol.ts` — if adding `workerRelease`, add request/response definitions
- `sdk/src/index.ts` — export the runner
- `sdk/tests/hn-monitor-runner.test.ts` — new test file with all coverage cases

## Definition of done

ALL of the following must hold:

1. `sdk/src/hn-monitor-runner.ts` exists, exports `HnMonitorRunner` from `sdk/src/index.ts`

2. `sdk/src/worker.ts` — either `close()` calls `workerRelease` (add to protocol.ts if missing), OR a one-line comment names what close() intentionally does NOT do

3. `sdk/src/protocol.ts` — if you added `workerRelease`, matching request/response definitions

4. `sdk/tests/hn-monitor-runner.test.ts` covers ALL of these:
   - fake fetch + mock journal client → runner submits an event on each tick
   - abort signal triggers clean shutdown within one tick (worker released or documented)
   - worker attach happens before first poll
   - **fetch throw → loop survives** (onPollError called, next tick still runs)
   - **journal throw → loop TERMINATES** (runner.run() rejects with the error)

5. The runner implementation:
   - constructs a `JournalClient` connected to the running `relayflowd` socket
   - constructs an `AgentWorker` (from `sdk/src/worker.ts`) and calls `workerAttach()` for `agent` steps — attach BEFORE first poll
   - loops: `pollHackerNewsOnce(spec, sink)` → sleep `POLL_INTERVAL_MS` (env-configurable, default 60000 = 60s) → repeat
   - exit cleanly on `AbortSignal.abort` (drain in-flight steps, close client, release worker)
   - no scheduling logic beyond the sleep (the kernel owns retry and dedupe policy)
   - no LLM calls; the runner is glue, not a reviewer

6. `cd sdk && npm test` passes. Run and paste literal output showing test counts.

7. `cd kernel && sh ../ops/cargo.sh test` passes. Run and paste literal output tail showing test counts.

8. EVERY new test confirmed to FAIL against current code (comment out the source; the test fails), with the literal failing output pasted in the summary.

9. As your LAST action, run `git status --porcelain` and paste it.

## Explicit non-goals for THIS PR (belongs to later sub-PRs)

- Proving the workload actually executes end-to-end (dispatch → step complete). That is sub-PR B (integration test with real relayflowd + fake HN fetch + assert step reaches `done`). This PR ONLY proves the runner assembles and its unit tests hold.
- CLI wrapper (`flows hn-monitor start`). That is sub-PR C.
- ops/STATE.md gate-2 GREEN declaration. That is sub-PR D.

## Explicitly OUT of scope — DO NOT TOUCH

- `.github/workflows/*` — no GHA changes
- `kernel/*` — the kernel side of gate 2 already works via PR #14
- `workflows/*.yaml` — those are for later sub-PRs
- `ops/AUTODRIVE_BRIEF.md` — chief owns this file, not the drive loop
- CLI wrapper — sub-PR C, separate PR
- end-to-end integration test with real relayflowd — sub-PR B, separate PR
- ops/STATE.md gate-2 declaration — sub-PR D, separate PR

## If blocked

If gate 2 is genuinely unreachable from the current state, write ops/NEEDS_HUMAN.md saying exactly why and still end with ASSESS_DONE. Do not silently substitute different work: a run that reports progress on the wrong gate is worse than one that reports it is blocked.
