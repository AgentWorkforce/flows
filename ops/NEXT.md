# NEXT — work package for this tick

**Gate:** Gate 3 (RFC-0001 §3 gate 2, sub-PR A)

**Scope (quoted from TARGET.md):**

Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test). Do not conflate the two.

Context: RFC-0001 §3 gate 2 is done when "hn-monitor runs as a relayflow in production, triggered by its real events, with zero bespoke persistence." Every primitive already exists — event triggers (PR #14), the flow spec (`testdata/hn-monitor.flow.yaml`), the poller (`sdk/src/hn-poller.ts`), the agent worker (`sdk/src/worker.ts` from PR #53), a one-shot demo (`sdk/src/demo-hn-monitor.ts`) — but nothing has ever run them together as a continuous workload. This PR fixes that.

Prior attempt (PR #83, closed) produced a functional runner but was rejected by the swarm on five real findings. Address them in this attempt.

## Objective

Create `sdk/src/hn-monitor-runner.ts` — a continuous polling runner that composes existing pieces (JournalClient, AgentWorker, pollHackerNewsOnce) into a production-ready runner, addressing all five findings from PR #83's review.

## Files in scope

- `packages/sdk/src/hn-monitor-runner.ts` (new)
- `packages/sdk/src/worker.ts` (modify `close()` only per finding #2)
- `packages/sdk/src/protocol.ts` (if adding `workerRelease` verb)
- `packages/sdk/src/index.ts` (export HnMonitorRunner)
- `packages/sdk/tests/hn-monitor-runner.test.ts` (new, comprehensive coverage)

## The five findings from PR #83 that MUST be addressed

1. **Fail-closed on journal errors.** Split error handling: `try { fetch } catch { onFetchError }` around the network call (swallow these), `try { eventSubmit } catch { rethrow }` around the journal call (never swallow). Only fetch-level errors (network flakiness, HN API rate limits) may be swallowed; a journal write failure MUST throw and terminate the runner.

2. **AgentWorker.close() must release the worker (or explicitly document it does not).** Either add a `workerRelease` verb to `sdk/src/protocol.ts` and call it from `close()` (preferred — completes the shutdown contract), OR add a one-line comment on `close()` naming exactly what shutdown intentionally does NOT do.

3. **Class field declaration order.** Declare ALL fields at the top of the class body, before the constructor. Works today because of ES2022 hoisting semantics but breaks silently if someone adds `= someDefault` to a declaration.

4. **Signal handlers must be opt-in via AbortSignal.** Accept `signal?: AbortSignal` in options; the CLI wrapper (sub-PR C) can create + wire a process-signal-driven AbortController. A library user embedding this can't cancel one runner without affecting others. Do NOT register SIGTERM/SIGINT handlers on the process directly with no opt-out.

5. **Test coverage for pollError branch.** Tests must assert BOTH cases: (a) the loop SURVIVES a fetcher throw (onPollError called, next tick still runs), AND (b) the loop TERMINATES on a journal throw. Without both cases, someone regresses `onPollError` to a no-op and every test still passes.

## Definition of done (all of it, from TARGET.md)

- `sdk/src/hn-monitor-runner.ts` exists, exports `HnMonitorRunner` from `sdk/src/index.ts`
- `sdk/src/worker.ts` — either `close()` calls `workerRelease` (add to protocol.ts if missing), OR a one-line comment names what close() intentionally does NOT do
- `sdk/src/protocol.ts` — if you added `workerRelease`, matching request/response definitions
- `sdk/tests/hn-monitor-runner.test.ts` covers ALL of these:
  - fake fetch + mock journal client → runner submits an event on each tick
  - abort signal triggers clean shutdown within one tick (worker released or documented)
  - worker attach happens before first poll
  - **fetch throw → loop survives** (onPollError called, next tick still runs)
  - **journal throw → loop TERMINATES** (runner.run() rejects with the error)
- `cd packages/sdk && npm test` green (pretest hook builds the kernel automatically per PR #69)
- EVERY new test confirmed to FAIL against current code (comment out the source; the test fails), with the literal failing output pasted in your summary
- PR body explicitly names the non-goals (test-actually-runs is sub-PR B; CLI is sub-PR C; gate-2 declaration is sub-PR D)
- ops/NEXT.md correctly says Gate 2, not Gate 3 (the assessor on #83 confused itself — TARGET says gate 3 but it's actually gate 2 work)
- As your LAST action, run `git status --porcelain` and paste it

## Explicit non-goals for THIS tick (DO NOT TOUCH)

- `.github/workflows/*` — no GHA changes
- `kernel/*` — the kernel side of gate 2 already works via PR #14
- `workflows/*.yaml` — those are for later sub-PRs
- `ops/AUTODRIVE_BRIEF.md` — chief owns this file, not the drive loop
- CLI wrapper — sub-PR C, separate PR
- End-to-end integration test with real relayflowd — sub-PR B, separate PR
- ops/STATE.md gate-2 declaration — sub-PR D, separate PR
- Proving the workload actually executes end-to-end (dispatch → step complete) — sub-PR B

## Environment constraints (cloud sandbox)

Per ops/STATE.md lines 195-207, this is a cloud sandbox with:
- No `.git` (only gitdir pointer to /home/daytona/.project-git)
- No `cargo` command (kernel cannot be built)
- No `gh` auth

SDK tests status after installing @types/node:
```
Test Files  4 failed | 97 passed | 2 skipped (103)
      Tests  11 failed | 1622 passed | 8 skipped (1641)
```

The 11 failed tests are integration tests requiring the built kernel binary (`kernel/target/debug/relayflowd` and `kernel/target/release/relayflowd`). This is expected and acceptable per PR #69 which states "pretest hook builds the kernel automatically" — but in this sandbox, the pretest hook cannot build because cargo is unavailable.

The unit tests pass. New unit tests for hn-monitor-runner.test.ts can be written and verified.

## If you cannot finish

Say so and file what you learned. A minimal runner with an honest gap description beats a complete-looking one that doesn't shut down cleanly or leaks journal errors.
