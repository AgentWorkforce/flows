# NEXT — work package for this tick

**Scope:** Build sub-PR A of the Gate 2 push: a real hn-monitor polling runner in the SDK. CODE task, sdk/src/-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test). Do not conflate the two.

This run targets **gate 2** work (not gate 3 as the previous package said).

## Objective

Build a continuous HN monitor runner (`sdk/src/hn-monitor-runner.ts`) that composes the existing pieces (JournalClient, AgentWorker, pollHackerNewsOnce) into a continuous polling loop. This addresses all five findings from the rejected PR #83 and proves the runner assembles correctly with passing unit tests.

## Context from ops/TARGET.md

Prior attempt (PR #83, closed) produced a functional runner but was rejected by the swarm on five real findings:

1. **Fail-closed on journal errors** — #83's catch swallowed EVERY error including eventSubmit journal failures. Only fetch-level errors (network flakiness, HN API rate limits) may be swallowed; a journal write failure MUST throw and terminate the runner.

2. **AgentWorker.close() must release the worker** — #83 added await worker.close() to shutdown but the current close() only drains local promises — it does NOT tell the kernel to release the worker registration. Either add a workerRelease verb to protocol.ts and call it from close() (preferred), OR add a one-line comment on close() naming exactly what shutdown intentionally does NOT do.

3. **Class field declaration order** — #83 declared private readonly fetcher AFTER the constructor. Declare ALL fields at the top of the class body, before the constructor.

4. **Signal handlers must be opt-in via AbortSignal** — #83 registered SIGTERM/SIGINT handlers on the process directly with no opt-out. Accept signal?: AbortSignal in options; the CLI wrapper (sub-PR C) can create + wire a process-signal-driven AbortController.

5. **Test coverage for pollError branch** — #83's tests never asserted the loop survives a fetcher throw AND the loop TERMINATES on a journal throw. Add both cases.

## Files in scope

- `sdk/src/hn-monitor-runner.ts` — NEW: the continuous runner
- `sdk/src/worker.ts` — MODIFY: either add workerRelease call to close() OR add comment documenting what it doesn't do
- `sdk/src/protocol.ts` — MODIFY IF NEEDED: add workerRelease verb if we choose option A for finding #2
- `sdk/src/index.ts` — MODIFY: export HnMonitorRunner
- `sdk/tests/hn-monitor-runner.test.ts` — NEW: comprehensive test coverage

## Definition of done

ALL of the following must hold:

1. Code exists and exports:
   - sdk/src/hn-monitor-runner.ts exists
   - HnMonitorRunner exported from sdk/src/index.ts

2. Finding #1 (fail-closed) addressed:
   - Fetch-level errors caught and handled (loop survives)
   - Journal errors NOT caught (runner terminates)

3. Finding #2 (worker release) addressed:
   - Either: sdk/src/protocol.ts has workerRelease verb AND worker.close() calls it
   - Or: worker.ts has one-line comment on close() documenting what it doesn't do

4. Finding #3 (field order) addressed:
   - All class fields declared at top of class body, before constructor

5. Finding #4 (signal handling) addressed:
   - Runner accepts signal?: AbortSignal in options
   - No process-level signal handlers in the library

6. Finding #5 (test coverage) addressed:
   - Test: fake fetch + mock journal client → runner submits an event on each tick
   - Test: abort signal triggers clean shutdown within one tick (worker released or documented)
   - Test: worker attach happens before first poll
   - Test: fetch throw → loop survives (onPollError called, next tick still runs)
   - Test: journal throw → loop TERMINATES (runner.run() rejects with the error)

7. cd sdk && npm test must be green. Paste the literal command and output tail showing test counts.

8. EVERY new test confirmed to FAIL against current code (comment out the source; the test fails), with the literal failing output pasted in your summary.

9. PR body explicitly names the non-goals (test-actually-runs is sub-PR B; CLI is sub-PR C; gate-2 declaration is sub-PR D).

10. As your LAST action, run git status --porcelain and paste it.

## Explicitly OUT of scope for THIS tick — DO NOT TOUCH

- .github/workflows/* — no GHA changes
- kernel/* — the kernel side of gate 2 already works via PR #14
- workflows/*.yaml — those are for later sub-PRs
- ops/AUTODRIVE_BRIEF.md — chief owns this file, not the drive loop
- CLI wrapper (flows hn-monitor start) — sub-PR C, separate PR
- end-to-end integration test with real relayflowd — sub-PR B, separate PR
- ops/STATE.md gate-2 declaration — sub-PR D, separate PR

## If blocked

If this work is genuinely unreachable from the current state, write ops/NEEDS_HUMAN.md saying exactly why and still end with ASSESS_DONE. Do not silently substitute different work.
