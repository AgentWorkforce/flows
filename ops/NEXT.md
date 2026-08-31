# NEXT — work package for this tick

**Gate:** 2 (proactive agent)

**Scope:** Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK that composes existing primitives into a continuous workload.

## Objective

Build `sdk/src/hn-monitor-runner.ts` that runs `hn-monitor` as a continuous relayflow — proving the SDK can execute a proactive agent workload by composing the journal client, agent worker, and poller into a production-ready runner.

## Context

Gate 2 (RFC-0001 §3) is done when "hn-monitor runs as a relayflow in production, triggered by its real events, with zero bespoke persistence." Every primitive already exists in this repo:

- Event triggers: PR #14, `kernel/relayflowd/tests/event_wake.rs`
- Flow spec: `testdata/hn-monitor.flow.yaml`
- Poller: `sdk/src/hn-poller.ts`
- Agent worker: `sdk/src/worker.ts` (PR #53)
- One-shot demo: `sdk/src/demo-hn-monitor.ts`

Nothing has ever run them together as a continuous workload. This PR fixes that, addressing all five findings from the rejected PR #83:

1. **Fail-closed on journal errors** — only fetch-level errors may be swallowed; journal write failures MUST throw and terminate
2. **Worker.close() must release the worker** — add `workerRelease` protocol verb OR document what close() does not do
3. **Class field declaration order** — declare ALL fields before constructor
4. **Signal handlers via AbortSignal** — accept `signal?: AbortSignal` in options (no process-level handlers)
5. **Test coverage for pollError branch** — assert loop survives fetcher throw AND terminates on journal throw

## Files in scope

- `sdk/src/hn-monitor-runner.ts` — new runner implementation
- `sdk/src/worker.ts` — MAY modify `close()` per finding #2, but do NOT rewrite attach/dispatch/complete flow
- `sdk/src/protocol.ts` — if adding `workerRelease` verb
- `sdk/tests/hn-monitor-runner.test.ts` — comprehensive test coverage
- `sdk/src/index.ts` — export `HnMonitorRunner`

## Definition of done

ALL of the following must hold:

1. `sdk/src/hn-monitor-runner.ts` exists, exports `HnMonitorRunner` from `sdk/src/index.ts`

2. The runner composes existing pieces:
   - Constructs `JournalClient` connected to running `relayflowd` socket
   - Constructs `AgentWorker` and calls `workerAttach()` for `agent` steps
   - **Worker attaches BEFORE first poll** (a run parked because no worker attached requires `run.resume` to revive)
   - Loops: `pollHackerNewsOnce(spec, sink)` → sleep `POLL_INTERVAL_MS` (env-configurable, default 60000ms) → repeat
   - Exit cleanly on `AbortSignal.abort` (drain in-flight steps, close client, release worker)

3. Error handling per findings #1 and #5:
   - Fetch-level errors (network flakiness, HN API rate limits) → swallowed, loop continues
   - Journal write failures → MUST throw and terminate runner
   - Split: `try { fetch } catch { onFetchError }` around network, `try { eventSubmit } catch { rethrow }` around journal

4. `sdk/src/worker.ts` — either `close()` calls `workerRelease` (add to protocol.ts if missing), OR a one-line comment names what `close()` intentionally does NOT do

5. `sdk/tests/hn-monitor-runner.test.ts` covers ALL test cases:
   - Fake fetch + mock journal client → runner submits an event on each tick
   - Abort signal triggers clean shutdown within one tick (worker released or documented)
   - Worker attach happens before first poll
   - **Fetch throw → loop survives** (onPollError called, next tick still runs)
   - **Journal throw → loop TERMINATES** (runner.run() rejects with the error)

6. EVERY new test confirmed to FAIL against current code (comment out the source; the test fails), with the literal failing output pasted in the summary

7. The following commands pass with literal output pasted:
   ```
   cd sdk && npm test
   ```

8. PR body explicitly names the non-goals:
   - Sub-PR B: end-to-end integration test proving workload actually executes (dispatch → step complete)
   - Sub-PR C: CLI wrapper (`flows hn-monitor start`)
   - Sub-PR D: ops/STATE.md gate-2 GREEN declaration

9. As the LAST action, run `git status --porcelain` and paste the output

## Explicitly OUT of scope

DO NOT TOUCH:

- `.github/workflows/*` — no GHA changes
- `kernel/*` — kernel side of gate 2 already works via PR #14
- `workflows/*.yaml` — for later sub-PRs
- `ops/AUTODRIVE_BRIEF.md` — chief owns this file
- `ops/STATE.md` gate-2 declaration — sub-PR D, separate PR
- CLI wrapper — sub-PR C, separate PR
- End-to-end integration test with real relayflowd — sub-PR B, separate PR

No scheduling logic beyond the sleep (kernel owns retry/dedupe policy). No LLM calls (runner is glue, not a reviewer).

## If blocked

If genuinely unreachable, write `ops/NEEDS_HUMAN.md` saying exactly why and still end with ASSESS_DONE. Do not silently substitute different work.
