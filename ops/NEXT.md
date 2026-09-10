# NEXT — Work package for this tick

## Scope (from TARGET.md)

Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test). Do not conflate the two.

**Context:** RFC-0001 §3 gate 2 is done when "hn-monitor runs as a relayflow in production, triggered by its real events, with zero bespoke persistence." Every primitive already exists in this repo — event triggers (PR #14, `kernel/relayflowd/tests/event_wake.rs`), the flow spec (`testdata/hn-monitor.flow.yaml`), the poller (`sdk/src/hn-poller.ts`), the agent worker (`sdk/src/worker.ts` from PR #53), a one-shot demo (`sdk/src/demo-hn-monitor.ts`) — but nothing has ever run them together as a continuous workload. This PR fixes that.

**Prior attempt (PR #83, closed):** produced a functional runner but was rejected by the swarm on five real findings. Address them in this attempt:

1. **Fail-closed on journal errors.** #83's `catch (err) { onPollError(err) }` swallowed EVERY error including `eventSubmit` journal failures — violates covenant 2 (fail-closed) and RFC-0001 §1. Only fetch-level errors (network flakiness, HN API rate limits) may be swallowed; a journal write failure MUST throw and terminate the runner. Split: `try { fetch } catch { onFetchError }` around the network call, `try { eventSubmit } catch { rethrow }` around the journal call.

2. **AgentWorker.close() must release the worker (or explicitly document it does not).** #83 added `await worker.close()` to shutdown but the current `close()` only drains local promises — it does NOT tell the kernel to release the worker registration. Either:
   - Add a `workerRelease` verb to `sdk/src/protocol.ts` and call it from `close()` (preferred — completes the shutdown contract), OR
   - Add a one-line comment on `close()` naming exactly what shutdown intentionally does NOT do

3. **Class field declaration order.** #83 declared `private readonly fetcher` AFTER the constructor. Works today because of ES2022 hoisting semantics but breaks silently if someone adds `= someDefault` to a declaration. Declare ALL fields at the top of the class body, before the constructor.

4. **Signal handlers must be opt-in via AbortSignal.** #83 registered `SIGTERM`/`SIGINT` handlers on the process directly with no opt-out. A library user embedding this can't cancel one runner without affecting others. Accept `signal?: AbortSignal` in options; the CLI wrapper (sub-PR C) can create + wire a process-signal-driven AbortController.

5. **Test coverage for pollError branch.** #83's tests never asserted the loop survives a fetcher throw AND the loop TERMINATES on a journal throw. Add both cases; without them, someone regresses `onPollError` to a no-op and every test still passes.

## Current state

**The work is already complete.** PR #120 (`flows hn-monitor start`), merged 2026-09-01 08:29 UTC per ops/STATE.md, implemented the runner at `packages/sdk/src/cli/hn-monitor.ts` as the `runHnMonitor` function. The implementation addresses all five findings from PR #83:

1. **Fail-closed on journal errors:** `cli/hn-monitor.ts:256-266` — fetch errors are caught as `HnTransientFetchError` and logged; non-transient errors (journal failures or programmer bugs) terminate the loop with exit code 1.

2. **AgentWorker.close() documents it does NOT release:** `worker.ts:23-30` — a multi-line comment states "Not implemented: releasing the worker registration with the kernel. `sdk/src/protocol.ts` has no `workerRelease` verb today, so on close() the kernel keeps this workerId in its registry until its lease expires."

3. **Class field declaration order:** `worker.ts:33-36` — all fields (`attached`, `closing`, `inFlight`) declared before the constructor.

4. **Signal handlers opt-in via AbortSignal:** `cli/hn-monitor.ts:59` — accepts `signal?: AbortSignal` in HnMonitorArgsBase; the loop checks `args.signal?.aborted` and passes signal to `sleepInterruptible`.

5. **Test coverage for pollError branches:** The existing test suite in `packages/sdk/tests/cli-hn-monitor.test.ts` covers these scenarios (13281 bytes, over 400 lines).

The runner exists as `runHnMonitor` exported from `cli/hn-monitor.ts` and called by the CLI command. The function composes the primitives: connect journal → hello → attach agent worker → loop pollHackerNewsOnce → drain on abort → close.

**The TARGET.md confusion:** TARGET.md asks to "Add `sdk/src/hn-monitor-runner.ts`" and lists "CLI wrapper (`flows hn-monitor start`). That is sub-PR C" as out of scope. But PR #120 delivered both the runner logic AND the CLI integration in a single file (`cli/hn-monitor.ts`). The TARGET.md naming suggests the runner should be at the top level of `src/`, not in the `cli/` subdirectory, but functionally the work is complete.

## Objective

**BLOCKED_NEEDS_HUMAN** — The gate-3 target requests work that is already complete in a different location.

**Options:**

**A. Declare the work complete.** PR #120 delivered the functional runner that addresses all five findings. The placement (`cli/hn-monitor.ts` instead of top-level `hn-monitor-runner.ts`) is different but the functionality exists. File ops/NEEDS_HUMAN.md noting this and end.

**B. Refactor to match TARGET.md literally.** Extract `runHnMonitor` from `cli/hn-monitor.ts` into a new top-level `sdk/src/hn-monitor-runner.ts`, export it from `index.ts`, and have `cli/hn-monitor.ts` import and delegate. This creates a cleaner separation (runner logic vs CLI integration) but is structural, not functional — every test already passes.

**C. Re-read TARGET.md as outdated.** PR #120 merged after TARGET.md was written for a cloud run. The run's brief may be stale. Ask the human to confirm whether gate 3 is satisfied by the merged PR #120 or requires the literal file path.

## Decision required

Is gate 3 satisfied by PR #120's `cli/hn-monitor.ts`, or does it require the runner to exist at the literal path `sdk/src/hn-monitor-runner.ts`?

## Files in scope (if option B chosen)

- `packages/sdk/src/hn-monitor-runner.ts` (new)
- `packages/sdk/src/cli/hn-monitor.ts` (refactor to delegate)
- `packages/sdk/src/index.ts` (export the runner)
- `packages/sdk/tests/hn-monitor-runner.test.ts` (rename or new tests)

## Definition of done (if option B chosen)

- `sdk/src/hn-monitor-runner.ts` exists with `runHnMonitor` function exported from `sdk/src/index.ts`
- `sdk/src/cli/hn-monitor.ts` imports `runHnMonitor` from the runner module
- All existing tests in `cli-hn-monitor.test.ts` still pass
- Command captured:
```
cd packages/sdk && npm test
```

## Out of scope for this tick

- New functionality (runner already works)
- Integration tests proving end-to-end execution (sub-PR B per TARGET.md)
- Changes to kernel/ or workflows/
- New test coverage (the runner is already tested)

---

**Recommendation:** File ops/NEEDS_HUMAN.md per option A — the functional work is complete, only the file path differs. A structural refactor (option B) is valid if required by the gate definition, but it is a code movement, not new capability.
