# Work package — gate 2, sub-PR A: HN monitor polling runner

**Scope (quoted from target):**

Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test). Do not conflate the two.

Prior attempt (PR #83, closed) produced a functional runner but was rejected by the swarm on five real findings. Address them in this attempt:

1. **Fail-closed on journal errors.** Split: `try { fetch } catch { onFetchError }` around the network call, `try { eventSubmit } catch { rethrow }` around the journal call.

2. **AgentWorker.close() must release the worker (or explicitly document it does not).** Either add a `workerRelease` verb to `sdk/src/protocol.ts` and call it from `close()` (preferred), OR add a one-line comment on `close()` naming exactly what shutdown intentionally does NOT do.

3. **Class field declaration order.** Declare ALL fields at the top of the class body, before the constructor.

4. **Signal handlers must be opt-in via AbortSignal.** Accept `signal?: AbortSignal` in options; the CLI wrapper (sub-PR C) can create + wire a process-signal-driven AbortController.

5. **Test coverage for pollError branch.** Add both cases: the loop survives a fetcher throw AND the loop TERMINATES on a journal throw.

## The task

Add `sdk/src/hn-monitor-runner.ts`. It composes the existing pieces into a continuous runner:

  - constructs a `JournalClient` connected to the running `relayflowd` socket
  - constructs an `AgentWorker` (from `sdk/src/worker.ts`) and calls `workerAttach()` for `agent` steps — attach BEFORE first poll
  - loops: `pollHackerNewsOnce(spec, sink)` → sleep `POLL_INTERVAL_MS` (env-configurable, default 60000 = 60s) → repeat
  - exit cleanly on `AbortSignal.abort` (drain in-flight steps, close client, release worker per finding #2)
  - exported from `sdk/src/index.ts`

Keep it small and honest:
  - the worker must attach BEFORE the first poll
  - the poller layer handles single-fetch failures with a typed error; the loop just moves to the next tick — but journal errors MUST fail the runner (finding #1)
  - no scheduling logic beyond the sleep (the kernel owns retry and dedupe policy)
  - no LLM calls; the runner is glue, not a reviewer

## Explicit non-goals for THIS PR (belongs to later sub-PRs)

  - Proving the workload actually executes end-to-end (dispatch → step complete). That is sub-PR B (integration test with real relayflowd + fake HN fetch + assert step reaches `done`).
  - CLI wrapper (`flows hn-monitor start`). That is sub-PR C.
  - ops/STATE.md gate-2 GREEN declaration. That is sub-PR D.

## Definition of done (all of it)

  - `sdk/src/hn-monitor-runner.ts` exists, exports `HnMonitorRunner` from `sdk/src/index.ts`
  - `sdk/src/worker.ts` — either `close()` calls `workerRelease` (add to protocol.ts if missing), OR a one-line comment names what close() intentionally does NOT do
  - `sdk/src/protocol.ts` — if you added `workerRelease`, matching request/response definitions
  - `sdk/tests/hn-monitor-runner.test.ts` covers ALL of these:
    - fake fetch + mock journal client → runner submits an event on each tick
    - abort signal triggers clean shutdown within one tick (worker released or documented)
    - worker attach happens before first poll
    - **fetch throw → loop survives** (onPollError called, next tick still runs)
    - **journal throw → loop TERMINATES** (runner.run() rejects with the error)
  - `cd sdk && npm test` green (pretest hook builds the kernel automatically), with literal output pasted
  - EVERY new test confirmed to FAIL against current code (comment out the source; the test fails), with the literal failing output pasted
  - PR body explicitly names the non-goals (test-actually-runs is sub-PR B; CLI is sub-PR C; gate-2 declaration is sub-PR D)
  - as your LAST action, run `git status --porcelain` and paste it

## Out of scope for THIS tick — DO NOT TOUCH

  - `.github/workflows/*` — no GHA changes
  - `kernel/*` — the kernel side of gate 2 already works via PR #14
  - `workflows/*.yaml` — those are for later sub-PRs
  - `ops/AUTODRIVE_BRIEF.md` — chief owns this file, not the drive loop
  - CLI wrapper — sub-PR C, separate PR
  - end-to-end integration test with real relayflowd — sub-PR B, separate PR
  - ops/STATE.md gate-2 declaration — sub-PR D, separate PR

## Files in scope

  - `sdk/src/hn-monitor-runner.ts` (NEW)
  - `sdk/src/worker.ts` (modify `close()` only)
  - `sdk/src/protocol.ts` (add `workerRelease` if needed)
  - `sdk/src/index.ts` (export the runner)
  - `sdk/tests/hn-monitor-runner.test.ts` (NEW)

## Objective

Compose existing primitives (JournalClient, AgentWorker, pollHackerNewsOnce) into a continuous polling runner that addresses the five review findings from PR #83, with comprehensive test coverage proving fail-closed journal error handling and fetch error survival.

## Current state

Both test suites pass:

```
$ cd /project/workflows/runs/bc7818d9-80e8-405f-8913-9866c78c8ff1/kernel && sh ../ops/cargo.sh test --workspace 2>&1 | tail -20
   Running unittests src/lib.rs (/home/daytona/.relayflows-toolchain/target/326323060/debug/deps/relayflowd_journal-e575ab403beb54a9)

running 6 tests
test registry::tests::registry_is_a_rebuildable_run_locator ... ok
test tests::an_unconfirmed_election_is_reclaimed_by_the_next_attempt_not_treated_as_done ... ok
test tests::append_is_durable_and_monotonic_after_reopen ... ok
test tests::effects_are_deduplicated_at_the_journal_boundary ... ok
test tests::failed_commit_is_returned_not_swallowed ... ok
test tests::rollover_is_atomic_scaffolding_for_epoch_resume ... ok

test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
```

```
$ cd /project/workflows/runs/bc7818d9-80e8-405f-8913-9866c78c8ff1/sdk && npm test 2>&1 | tail -20
 ✓ tests/hn-poller.test.ts (3 tests) 4ms

 Test Files  15 passed (15)
      Tests  203 passed (203)
   Start at  05:19:12
   Duration  43.50s (transform 320ms, setup 0ms, collect 613ms, tests 40.86s, environment 2ms, prepare 532ms)
```

Kernel: 44 tests passed (4+1+26+5+6+doc tests across all crates)
SDK: 203 tests passed across 15 test files

`sdk/src/hn-monitor-runner.ts` does not exist. The work package is to create it along with its tests, addressing the five findings from PR #83.
