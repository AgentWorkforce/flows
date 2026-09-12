# NEXT — work package for this tick

**Gate:** 2 (the target file header says "gate 3" but the actual dependency is gate 2 per RFC-0001 §3 and the task itself)

**Objective:** Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `packages/sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test).

**Scope (quoted from ops/TARGET.md — the full target, not just the header):**

> Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test). Do not conflate the two.
>
> RFC-0001 §3 gate 2 is done when "hn-monitor runs as a relayflow in production, triggered by its real events, with zero bespoke persistence." Every primitive already exists in this repo — event triggers (PR #14, `kernel/relayflowd/tests/event_wake.rs`), the flow spec (`testdata/hn-monitor.flow.yaml`), the poller (`sdk/src/hn-poller.ts`), the agent worker (`sdk/src/worker.ts` from PR #53), a one-shot demo (`sdk/src/demo-hn-monitor.ts`) — but nothing has ever run them together as a continuous workload. This PR fixes that.
>
> Prior attempt (PR #83, closed) produced a functional runner but was rejected by the swarm on five real findings:
>
> 1. Fail-closed on journal errors. Only fetch-level errors (network flakiness, HN API rate limits) may be swallowed; a journal write failure MUST throw and terminate the runner. Split: `try { fetch } catch { onFetchError }` around the network call, `try { eventSubmit } catch { rethrow }` around the journal call.
>
> 2. AgentWorker.close() must release the worker (or explicitly document it does not). Either add a `workerRelease` verb to `sdk/src/protocol.ts` and call it from `close()`, OR add a one-line comment on `close()` naming exactly what shutdown intentionally does NOT do.
>
> 3. Class field declaration order. Declare ALL fields at the top of the class body, before the constructor.
>
> 4. Signal handlers must be opt-in via AbortSignal. Accept `signal?: AbortSignal` in options; the CLI wrapper (sub-PR C) can create + wire a process-signal-driven AbortController.
>
> 5. Test coverage for pollError branch. Add test cases asserting the loop survives a fetcher throw AND the loop TERMINATES on a journal throw.

**Files in scope:**

- `packages/sdk/src/hn-monitor-runner.ts` (create)
- `packages/sdk/src/worker.ts` (modify `close()` per finding #2)
- `packages/sdk/src/protocol.ts` (add `workerRelease` if chosen)
- `packages/sdk/tests/hn-monitor-runner.test.ts` (create)
- `packages/sdk/src/index.ts` (export `HnMonitorRunner`)

**Definition of done (all must hold):**

1. `packages/sdk/src/hn-monitor-runner.ts` exists, exports `HnMonitorRunner` from `packages/sdk/src/index.ts`
2. `packages/sdk/src/worker.ts` — either `close()` calls `workerRelease` (add to protocol.ts if missing), OR a one-line comment names what close() intentionally does NOT do
3. `packages/sdk/src/protocol.ts` — if you added `workerRelease`, matching request/response definitions
4. `packages/sdk/tests/hn-monitor-runner.test.ts` covers ALL of these cases:
   - fake fetch + mock journal client → runner submits an event on each tick
   - abort signal triggers clean shutdown within one tick (worker released or documented)
   - worker attach happens before first poll
   - **fetch throw → loop survives** (onPollError called, next tick still runs)
   - **journal throw → loop TERMINATES** (runner.run() rejects with the error)
5. EVERY new test confirmed to FAIL against current code (comment out the source; the test fails), with the literal failing output pasted in the summary
6. Passing test suite with literal output:
   ```
   cd packages/sdk && npm test
   [paste exact output showing all tests passing, or the specific subset that is expected to pass]
   ```
7. PR body explicitly names the non-goals (test-actually-runs is sub-PR B; CLI is sub-PR C; gate-2 declaration is sub-PR D)
8. `git status --porcelain` output pasted as the final action

**Explicit OUT OF SCOPE for this tick (DO NOT TOUCH):**

- `.github/workflows/*` — no GHA changes
- `kernel/*` — the kernel side of gate 2 already works via PR #14
- `workflows/*.yaml` — those are for later sub-PRs
- `ops/AUTODRIVE_BRIEF.md` — chief owns this file, not the drive loop
- CLI wrapper — sub-PR C, separate PR
- end-to-end integration test with real relayflowd — sub-PR B, separate PR
- ops/STATE.md gate-2 declaration — sub-PR D, separate PR
- Proving the workload actually executes end-to-end (dispatch → step complete). That is sub-PR B (integration test with real relayflowd + fake HN fetch + assert step reaches `done`). This PR ONLY proves the runner assembles and its unit tests hold.

**Prerequisites RESOLVED:**

The previous assessor correctly identified that the SDK build was broken due to missing exports from `@relayflows/surface/runtime`. This has been resolved:

1. Built `packages/surface` (which was unbilt) → `npm ci` succeeded, generated dist/runtime.d.ts with all exports
2. Copied fresh `packages/surface/dist` to `packages/sdk/node_modules/@relayflows/surface/dist` to resolve stale node_modules
3. Verified SDK build succeeds: `cd packages/sdk && npm run build` → SUCCESS
4. Verified SDK tests mostly pass: `npm test` → 1515 passed / 11 failed (the 11 failures are integration tests expecting kernel binary at specific path; this is a known environment issue per STATE.md §"Known environment faults")

The SDK is now buildable and the work package can proceed.
