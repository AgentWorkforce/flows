# NEXT — work package for this tick

**Gate:** Gate 2 (proactive agent workload — hn-monitor runs as a relayflow)

**Scope:** Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test).

## Objective

Add `sdk/src/hn-monitor-runner.ts` that composes existing pieces (JournalClient from `sdk/src/journal-client.ts`, AgentWorker from `sdk/src/worker.ts`, pollHackerNewsOnce from `sdk/src/hn-poller.ts`) into a continuous runner for the hn-monitor workload.

This addresses five findings from closed PR #83:

1. **Fail-closed on journal errors** — only fetch errors may be swallowed; journal write failures MUST throw
2. **AgentWorker.close() must release the worker** — either add workerRelease verb or document what close() does NOT do
3. **Class field declaration order** — all fields before constructor
4. **Signal handlers opt-in via AbortSignal** — no process-wide signal handlers
5. **Test coverage for pollError branch** — loop survives fetch throw AND terminates on journal throw

## Context

RFC-0001 §3 gate 2 is done when "hn-monitor runs as a relayflow in production, triggered by its real events, with zero bespoke persistence." Every primitive already exists: event triggers (PR #14), the flow spec (`testdata/hn-monitor.flow.yaml`), the poller (`sdk/src/hn-poller.ts`), the agent worker (`sdk/src/worker.ts` from PR #53), and a one-shot demo (`sdk/src/demo-hn-monitor.ts`). Nothing has run them together as a continuous workload. This PR fixes that.

## Files in scope

- `sdk/src/hn-monitor-runner.ts` — NEW, the continuous runner
- `sdk/src/worker.ts` — MAY modify close() per finding #2 (add workerRelease or document)
- `sdk/src/protocol.ts` — IF workerRelease verb needs to be added
- `sdk/tests/hn-monitor-runner.test.ts` — NEW, test coverage
- `sdk/src/index.ts` — export HnMonitorRunner

## Definition of done

ALL of the following must hold:

1. `sdk/src/hn-monitor-runner.ts` exists and exports `HnMonitorRunner`
2. Exported from `sdk/src/index.ts`
3. Runner constructs JournalClient and AgentWorker
4. **Worker attach happens BEFORE first poll** (a parked run needs run.resume)
5. Loop: pollHackerNewsOnce → sleep POLL_INTERVAL_MS (env-configurable, default 60000) → repeat
6. **Fetch errors caught and handled** — loop continues to next tick
7. **Journal errors MUST throw and terminate the runner** (fail-closed)
8. Clean shutdown on AbortSignal.abort (drain in-flight, close client, release/document worker)
9. `sdk/src/worker.ts` — either close() calls workerRelease, OR one-line comment naming what close() does NOT do
10. `sdk/src/protocol.ts` — IF workerRelease added, include request/response definitions
11. `sdk/tests/hn-monitor-runner.test.ts` covers ALL of:
    - fake fetch + mock journal → runner submits event on each tick
    - abort signal triggers clean shutdown within one tick (worker released/documented)
    - worker attach before first poll
    - **fetch throw → loop survives** (onPollError called, next tick runs)
    - **journal throw → loop TERMINATES** (runner.run() rejects)
12. EVERY new test confirmed to FAIL against current code — comment out source, capture failure output
13. PR body explicitly names non-goals: integration test (sub-PR B), CLI wrapper (sub-PR C), gate-2 declaration (sub-PR D)

Commands that MUST pass with literal output captured:

```bash
cd sdk && npm test
```

Exit 0, all tests passing.

```bash
git status --porcelain
```

Shows only intended modifications. Run this as LAST action.

## Explicitly OUT of scope

- Proving the workload actually executes end-to-end (sub-PR B: integration test with real relayflowd)
- CLI wrapper `flows hn-monitor start` (sub-PR C)
- ops/STATE.md gate-2 GREEN declaration (sub-PR D)
- `.github/workflows/*` — no GHA changes
- `kernel/*` — kernel side already works via PR #14
- `workflows/*.yaml` — for later sub-PRs
- `ops/AUTODRIVE_BRIEF.md` — chief owns this file
- Scheduling logic beyond the sleep — kernel owns retry/dedupe policy
- LLM calls — runner is glue, not a reviewer
- Rewriting worker.ts attach/dispatch/complete flow (PR #53 closed this)
