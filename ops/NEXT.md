# NEXT — work package (BLOCKED on SDK build)

## Objective

Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK.

## Scope (quoted from TARGET.md)

Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test).

Context: RFC-0001 §3 gate 2 is done when "hn-monitor runs as a relayflow in production, triggered by its real events, with zero bespoke persistence." Every primitive already exists in this repo — event triggers (PR #14), the flow spec (testdata/hn-monitor.flow.yaml), the poller (sdk/src/hn-poller.ts), the agent worker (sdk/src/worker.ts from PR #53), a one-shot demo (sdk/src/demo-hn-monitor.ts) — but nothing has ever run them together as a continuous workload. This PR fixes that.

Prior attempt (PR #83, closed) produced a functional runner but was rejected on five real findings:
1. Fail-closed on journal errors - only fetch-level errors may be swallowed; journal write failures MUST throw
2. AgentWorker.close() must release the worker or explicitly document it does not  
3. Class field declaration order - all fields before constructor
4. Signal handlers must be opt-in via AbortSignal
5. Test coverage for pollError branch - loop survives fetcher throw AND terminates on journal throw

## BLOCKED

**The SDK cannot build.** `cd packages/sdk && npm ci` fails with 14 TypeScript compilation errors. See ops/NEEDS_HUMAN.md for the decision needed (fix build first vs. report blocked).

Until the build works, the work package cannot proceed. The definition of done requires `cd sdk && npm test` green.

## Files in scope (once unblocked)

- packages/sdk/src/hn-monitor-runner.ts (create)
- packages/sdk/src/worker.ts (modify close() per finding #2)
- packages/sdk/src/protocol.ts (add workerRelease if needed)
- packages/sdk/tests/hn-monitor-runner.test.ts (create)
- packages/sdk/src/index.ts (export HnMonitorRunner)

## Definition of done

- sdk/src/hn-monitor-runner.ts exists, exports HnMonitorRunner from index.ts
- sdk/src/worker.ts — either close() calls workerRelease (add to protocol.ts if missing), OR one-line comment names what close() intentionally does NOT do
- sdk/src/protocol.ts — if workerRelease added, matching request/response definitions
- sdk/tests/hn-monitor-runner.test.ts covers ALL of:
  - fake fetch + mock journal client → runner submits event on each tick
  - abort signal triggers clean shutdown within one tick (worker released or documented)
  - worker attach happens before first poll
  - fetch throw → loop survives (onPollError called, next tick still runs)
  - journal throw → loop TERMINATES (runner.run() rejects with the error)
- `cd sdk && npm test` green (pretest hook builds kernel automatically)
- EVERY new test confirmed to FAIL against current code (comment out source; paste failing output)
- PR body explicitly names non-goals (test-actually-runs is sub-PR B; CLI is sub-PR C; gate-2 declaration is sub-PR D)
- As LAST action: `git status --porcelain` and paste it

## Explicitly OUT of scope

- .github/workflows/* — no GHA changes
- kernel/* — kernel side already works via PR #14
- workflows/*.yaml — for later sub-PRs
- ops/AUTODRIVE_BRIEF.md — chief owns this
- CLI wrapper — sub-PR C, separate PR
- end-to-end integration test with real relayflowd — sub-PR B, separate PR
- ops/STATE.md gate-2 declaration — sub-PR D, separate PR

