# ops/NEXT.md — work package for this tick

**Date:** 2026-09-12
**Current gate:** Gate 2 (per RFC-0001 §3; gate 1 is GREEN per STATE.md)
**Assessor:** Relayflow Lead
**Target:** Gate 3 per ops/TARGET.md (though the work directly advances Gate 2's "hn-monitor runs as a relayflow in production" done-when)

## Scope (quoted from ops/TARGET.md)

Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test). Do not conflate the two.

RFC-0001 §3 gate 2 is done when "hn-monitor runs as a relayflow in production, triggered by its real events, with zero bespoke persistence." Every primitive already exists in this repo — event triggers (PR #14), the flow spec (`testdata/hn-monitor.flow.yaml`), the poller (`sdk/src/hn-poller.ts`), the agent worker (`sdk/src/worker.ts` from PR #53), a one-shot demo (`sdk/src/demo-hn-monitor.ts`) — but nothing has ever run them together as a continuous workload. This PR fixes that.

Prior attempt (PR #83, closed) produced a functional runner but was rejected by the swarm on five real findings. Address them in this attempt:

1. **Fail-closed on journal errors.** Only fetch-level errors (network flakiness, HN API rate limits) may be swallowed; a journal write failure MUST throw and terminate the runner. Split: `try { fetch } catch { onFetchError }` around the network call, `try { eventSubmit } catch { rethrow }` around the journal call.

2. **AgentWorker.close() must release the worker (or explicitly document it does not).** Either add a `workerRelease` verb and call it from `close()`, OR add a one-line comment on `close()` naming exactly what shutdown intentionally does NOT do. **Current state:** `sdk/src/worker.ts:32-37` already has the comment documenting this. No changes needed for finding #2.

3. **Class field declaration order.** Declare ALL fields at the top of the class body, before the constructor.

4. **Signal handlers must be opt-in via AbortSignal.** Accept `signal?: AbortSignal` in options; the CLI wrapper (sub-PR C) can create + wire a process-signal-driven AbortController.

5. **Test coverage for pollError branch.** Tests must assert the loop survives a fetcher throw AND the loop TERMINATES on a journal throw.

## Objective

Add `sdk/src/hn-monitor-runner.ts` that composes existing pieces into a continuous runner addressing all five findings from PR #83.

## Files in scope

- `sdk/src/hn-monitor-runner.ts` (new file)
- `sdk/src/index.ts` (export `HnMonitorRunner`)
- `sdk/tests/hn-monitor-runner.test.ts` (new file with comprehensive test coverage)

## Definition of done

ALL of the following must hold:

1. `sdk/src/hn-monitor-runner.ts` exists, exports `HnMonitorRunner` from `sdk/src/index.ts`

2. The runner implementation:
   - Constructs a `JournalClient` connected to the running `relayflowd` socket
   - Constructs an `AgentWorker` and calls `workerAttach()` BEFORE first poll
   - Loops: `pollHackerNewsOnce(spec, sink)` → sleep `POLL_INTERVAL_MS` (env-configurable, default 60000) → repeat
   - Exits cleanly on `AbortSignal.abort` (drain in-flight steps, close client)
   - All class fields declared at top of class body (finding #3)
   - Accepts `signal?: AbortSignal` in options (finding #4)
   - Fail-closed on journal errors: fetch errors swallowed, journal errors thrown (finding #1)
   - NO scheduling logic beyond the sleep
   - NO LLM calls

3. `sdk/tests/hn-monitor-runner.test.ts` covers ALL of these (finding #5):
   - fake fetch + mock journal client → runner submits an event on each tick
   - abort signal triggers clean shutdown within one tick
   - worker attach happens before first poll
   - **fetch throw → loop survives** (onPollError called, next tick still runs)
   - **journal throw → loop TERMINATES** (runner.run() rejects with the error)

4. `cd packages/sdk && npm test` green (pretest hook builds the kernel automatically)

5. EVERY new test confirmed to FAIL against current code (comment out the source; the test fails), with the literal failing output pasted in the PR body

6. As final action: run `git status --porcelain` and paste it

## Explicit non-goals for THIS PR

- Proving the workload actually executes end-to-end (dispatch → step complete). That is sub-PR B.
- CLI wrapper (`flows hn-monitor start`). That is sub-PR C.
- ops/STATE.md gate-2 GREEN declaration. That is sub-PR D.

## Out of scope — DO NOT TOUCH

- `.github/workflows/*`
- `kernel/*`
- `workflows/*.yaml`
- `ops/AUTODRIVE_BRIEF.md`
- `sdk/src/worker.ts` (finding #2 already satisfied by existing comment at lines 32-37)
- CLI wrapper (sub-PR C)
- end-to-end integration test (sub-PR B)
- ops/STATE.md gate-2 declaration (sub-PR D)

## BLOCKED: SDK does not compile

**STATUS:** BLOCKED_NEEDS_HUMAN

The SDK currently has TypeScript compilation errors preventing `npm test` from running. Attempting `cd packages/sdk && npm ci && npm test` fails with:

```
error TS2339: Property 'cwd' does not exist on type 'AgentOptions'.
error TS2339: Property 'handlers' does not exist on type 'AuthoredFlowDefinition<unknown>'.
error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperProviders'.
error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperClients'.
error TS2305: Module '"@relayflows/surface"' has no exported member 'TriggerSource'.
error TS2305: Module '"@relayflows/surface"' has no exported member 'SlackHelper'.
error TS2305: Module '"@relayflows/surface"' has no exported member 'providerEventTypes'.
```

These errors indicate missing or incompatible dependencies from the `@relayflows/surface` package. The work package CANNOT be completed without a working SDK test suite.

**Question for human:** Should the Lead fix the SDK compilation errors first (which appears out of scope for the gate 3 hn-monitor-runner target), or is there an environment/dependency issue that needs resolution before this work can proceed?

The target is pinned to gate 3 and must not work on any other gate. If gate 3 is genuinely unreachable from the current state (SDK doesn't compile), this is the honest report of that blocker.
