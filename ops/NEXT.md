# NEXT — work package for this tick

This run is pinned to **gate 3** and must not work on any other gate.

## Scope

Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test). Do not conflate the two.

RFC-0001 §3 gate 2 is done when "hn-monitor runs as a relayflow in production, triggered by its real events, with zero bespoke persistence." Every primitive already exists in this repo — event triggers (PR #14, `kernel/relayflowd/tests/event_wake.rs`), the flow spec (`testdata/hn-monitor.flow.yaml`), the poller (`sdk/src/hn-poller.ts`), the agent worker (`sdk/src/worker.ts` from PR #53), a one-shot demo (`sdk/src/demo-hn-monitor.ts`) — but nothing has ever run them together as a continuous workload. This PR fixes that.

Prior attempt (PR #83, closed) produced a functional runner but was rejected by the swarm on five real findings. Address them in this attempt:

1. **Fail-closed on journal errors.** Only fetch-level errors (network flakiness, HN API rate limits) may be swallowed; a journal write failure MUST throw and terminate the runner. Split: `try { fetch } catch { onFetchError }` around the network call, `try { eventSubmit } catch { rethrow }` around the journal call.

2. **AgentWorker.close() must release the worker (or explicitly document it does not).** Either add a `workerRelease` verb to `sdk/src/protocol.ts` and call it from `close()` (preferred), OR add a one-line comment on `close()` naming exactly what shutdown intentionally does NOT do.

3. **Class field declaration order.** Declare ALL fields at the top of the class body, before the constructor.

4. **Signal handlers must be opt-in via AbortSignal.** Accept `signal?: AbortSignal` in options; the CLI wrapper (sub-PR C) can create + wire a process-signal-driven AbortController.

5. **Test coverage for pollError branch.** Assert the loop survives a fetcher throw AND the loop TERMINATES on a journal throw.

## Objective

Add `sdk/src/hn-monitor-runner.ts` — a continuous polling runner that composes existing pieces (JournalClient, AgentWorker, pollHackerNewsOnce) into a workload that runs continuously, handles failures correctly (fail-closed on journal errors, survives fetch errors), and shuts down cleanly via AbortSignal.

## Files in scope

- `sdk/src/hn-monitor-runner.ts` (NEW)
- `sdk/src/index.ts` (MODIFY: export HnMonitorRunner)
- `sdk/src/worker.ts` (MODIFY: either add workerRelease call in close(), or document what it doesn't do)
- `sdk/src/protocol.ts` (MODIFY: add workerRelease verb IF we choose to implement it)
- `sdk/tests/hn-monitor-runner.test.ts` (NEW)

## Definition of done

ALL of the following must hold:

1. `sdk/src/hn-monitor-runner.ts` exists and exports `HnMonitorRunner` class
2. `sdk/src/index.ts` exports HnMonitorRunner
3. `sdk/src/worker.ts` — either `close()` calls `workerRelease` (add to protocol.ts if missing), OR a one-line comment names what close() intentionally does NOT do
4. `sdk/src/protocol.ts` — if workerRelease was added, matching request/response definitions
5. `sdk/tests/hn-monitor-runner.test.ts` covers ALL of these test cases:
   - fake fetch + mock journal client → runner submits an event on each tick
   - abort signal triggers clean shutdown within one tick (worker released or documented)
   - worker attach happens before first poll
   - **fetch throw → loop survives** (onPollError called, next tick still runs)
   - **journal throw → loop TERMINATES** (runner.run() rejects with the error)
6. All tests confirmed to FAIL against missing/broken source — for each new test, comment out the corresponding source code and verify the test fails, paste the literal failing output
7. Test suite passes with literal output:
   ```
   cd sdk && npm test
   ```
   Paste the command and output showing test counts.
8. Field declaration order correct — all class fields declared at top of class body, before constructor
9. AbortSignal for shutdown — signal is opt-in via options parameter, not process-level SIGTERM/SIGINT handlers
10. Fail-closed journal errors — journal errors rethrow and terminate the runner; only fetch errors are swallowed
11. As your LAST action, run `git status --porcelain` and paste it

## Explicitly OUT of scope

- Proving the workload actually executes end-to-end (dispatch → step complete). That is sub-PR B (integration test with real relayflowd + fake HN fetch + assert step reaches `done`). This PR ONLY proves the runner assembles and its unit tests hold.
- CLI wrapper (`flows hn-monitor start`). That is sub-PR C.
- ops/STATE.md gate-2 GREEN declaration. That is sub-PR D.
- `.github/workflows/*` — no GHA changes
- `kernel/*` — the kernel side of gate 2 already works via PR #14
- `workflows/*.yaml` — those are for later sub-PRs
- `ops/AUTODRIVE_BRIEF.md` — chief owns this file, not the drive loop
- end-to-end integration test with real relayflowd — sub-PR B, separate PR

## Gate

Gate 2 (proactive agent workload)

## If blocked

If gate 3 is genuinely unreachable from the current state, write ops/NEEDS_HUMAN.md saying exactly why and still end with ASSESS_DONE. Do not silently substitute different work.
