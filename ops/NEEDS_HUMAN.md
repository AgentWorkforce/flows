# NEEDS_HUMAN — gate 3 target appears satisfied by merged PR #120

## The question

Is gate 3 satisfied by PR #120's `cli/hn-monitor.ts`, or does it require the runner to exist at the literal path `sdk/src/hn-monitor-runner.ts`?

## Context

ops/TARGET.md pins this run to **gate 3** and scopes it: "Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side."

TARGET.md requests:
- Add `sdk/src/hn-monitor-runner.ts` 
- It composes: JournalClient → AgentWorker → loop pollHackerNewsOnce → clean shutdown
- Address 5 findings from closed PR #83 (fail-closed journal errors, worker release documentation, field order, AbortSignal, test coverage)
- Export from `sdk/src/index.ts`
- Lists "CLI wrapper (`flows hn-monitor start`). That is sub-PR C" as explicit non-goal

**But PR #120 already delivered this.** Per ops/STATE.md line 46-47: "PR #120 (`201542a`, merged 2026-09-01 08:29 UTC) — **`flows hn-monitor start`**, the CLI runner that turns the poller into an unattended process."

The implementation exists at `packages/sdk/src/cli/hn-monitor.ts` (287 lines) as the `runHnMonitor` function. It addresses all 5 findings:

1. ✅ **Fail-closed on journal errors:** `cli/hn-monitor.ts:256-266` — `instanceof HnTransientFetchError` catches fetch failures; non-transient errors (journal or programmer bugs) terminate with exit 1. The journal call is NOT wrapped in a catch-all.

2. ✅ **AgentWorker.close() documents non-release:** `worker.ts:23-30` — multi-line comment states "Not implemented: releasing the worker registration with the kernel. `sdk/src/protocol.ts` has no `workerRelease` verb today, so on close() the kernel keeps this workerId in its registry until its lease expires."

3. ✅ **Field declaration order:** `worker.ts:33-36` — all fields before constructor.

4. ✅ **AbortSignal opt-in:** `cli/hn-monitor.ts:59` accepts `signal?: AbortSignal`; loop checks `args.signal?.aborted` (lines 238, 270) and passes to `sleepInterruptible`.

5. ✅ **Test coverage:** `packages/sdk/tests/cli-hn-monitor.test.ts` exists (13281 bytes).

The runner composes the primitives exactly as TARGET.md specifies:
- `cli/hn-monitor.ts:143-174` — defaultConnectClient + defaultAttachWorker
- `cli/hn-monitor.ts:182-281` — runHnMonitor: connect → hello → attach → poll loop → drain → close

**The discrepancy:** TARGET.md asks for `sdk/src/hn-monitor-runner.ts` (top-level in src/) but the work landed in `sdk/src/cli/hn-monitor.ts` (cli/ subdirectory). TARGET.md also lists the CLI wrapper as "sub-PR C, separate PR" but PR #120 delivered both runner logic AND CLI integration in one file.

## The options

**A. Declare complete.** PR #120 satisfied the functional requirements. The file path differs but the work is done. Gate 3's done-when (from TARGET.md) did not include "must be at this exact path" — it said "a real hn-monitor polling runner in the SDK" and one exists.

**B. Refactor to literal path.** Extract `runHnMonitor` from `cli/hn-monitor.ts` into `sdk/src/hn-monitor-runner.ts`, export from `index.ts`, have cli/ delegate. This separates runner (library) from CLI (entry point) more cleanly, but is structural reorganization, not new capability. Every test already passes.

**C. Re-scope TARGET.md.** TARGET.md was written for a cloud run that may have executed before PR #120 merged. If the brief is stale, update it to reflect current state.

## Evidence: runner already works

From STATE.md line 49-57:
> **New evidence:** `ops/reviews/20260901-1050-gate2-live-run.md` records a live, unattended run of `flows hn-monitor start` against a local `relayflowd serve`, driven by real Hacker News top-stories. Real story IDs matched, deduped, dispatched under lease, and closed out with typed `completionReason` — the full trigger → subscription → dispatch → typed-failure loop journalled end to end.

The runner demonstrably executes. The integration test proving end-to-end dispatch (TARGET.md "sub-PR B") may still be pending, but the runner itself runs.

## Recommendation

Choose option A. PR #120 delivered the functional gate-3 work. If the literal file path `sdk/src/hn-monitor-runner.ts` is required for some architectural reason (e.g., SDK exports convention, or a gate definition that specifies the path), then option B is valid — but it's a 30-minute code-movement task, not new development.

The blocker is: which interpretation of "done" applies?
