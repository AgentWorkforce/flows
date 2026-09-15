# NEXT — work package for this tick

**BLOCKED_NEEDS_HUMAN: Target work appears complete; clarification needed.**

## The situation

This run is pinned to **Gate 3** with the following scope from ops/TARGET.md:

> Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test). Do not conflate the two.

The TARGET specifies building `sdk/src/hn-monitor-runner.ts` with these requirements:
- constructs a `JournalClient` connected to the running `relayflowd` socket
- constructs an `AgentWorker` and calls `workerAttach()` for `agent` steps
- loops: `pollHackerNewsOnce(spec, sink)` → sleep → repeat
- exit cleanly on `AbortSignal.abort`
- exported from `sdk/src/index.ts`

## What actually exists

The following files ALREADY implement this exact functionality:

1. **`packages/sdk/src/cli/hn-monitor.ts`** (288 lines) — implements `runHnMonitor()` which:
   - Constructs a `JournalClient` via `defaultConnectClient()` (lines 144-149)
   - Constructs an `AgentWorker` via `defaultAttachWorker()` (lines 151-175)
   - Attaches the worker BEFORE first poll (line 227)
   - Loops with `pollHackerNewsOnce()` → `sleepInterruptible()` → repeat (lines 239-273)
   - Handles `AbortSignal` for cancellation (lines 59, 128-142, 239, 271-272)
   - Drains worker with `await worker.close()` on shutdown (line 277)
   - Classifies errors: `HnTransientFetchError` → log and continue; else → fail-closed (lines 258-267)

2. **`packages/sdk/src/worker.ts`** — AgentWorker with documented limitation:
   - Lines 33-38: "Not implemented: releasing the worker registration with the kernel. `sdk/src/protocol.ts` has no `workerRelease` verb today, so on close() the kernel keeps this workerId in its registry until its lease expires."

3. **`packages/sdk/src/index.ts`** line 160:
   - Exports `AgentWorker` (but NOT the `runHnMonitor` function)

4. **`packages/sdk/tests/cli-hn-monitor.test.ts`** (337 lines) — comprehensive test coverage including:
   - argv parsing (lines 72-106)
   - fetch error survival (lines 215-234: "survives transient HN fetch throw")
   - journal error termination (lines 236-257: "terminates on journal throw")
   - clean shutdown (lines 259-277)
   - worker attach before first poll (lines 179-213: "attaches worker before poll zero")
   - AbortSignal handling (lines 279-295)

All five findings from PR #83's rejection are addressed:
1. ✓ Fail-closed on journal errors (lines 258-267: only HnTransientFetchError is swallowed; else terminates)
2. ✓ AgentWorker.close() documented (worker.ts lines 33-38)
3. ✓ Field declaration order (worker.ts has all fields before constructor)
4. ✓ Signal via AbortSignal (hn-monitor.ts line 59: `signal?: AbortSignal`)
5. ✓ Test coverage for both error branches (cli-hn-monitor.test.ts lines 215-257)

## The contradiction

The TARGET says to build this as "sub-PR A" for Gate 2, but:
- The code exists and is tested
- Gate 2 is AMBER per ops/STATE.md (not RED)
- The TARGET header says "gate 3" but the done-when criteria describe Gate 2 work
- No open PRs exist (ops/STATE.md line 129: "NONE. Every PR is merged or triaged closed")

## The question for human decision

**Is this work already complete and merged?** If so:
- Should this run assess the NEXT gate-3 work package instead?
- Or is there a missing piece I'm not seeing in the file structure?

**OR is the target asking for a DIFFERENT structure?** The TARGET says create `sdk/src/hn-monitor-runner.ts` (root of `src/`) but what exists is `sdk/src/cli/hn-monitor.ts` (in a `cli/` subdirectory). However:
- The functionality is identical
- The tests cover all requirements
- The only difference is file path and whether it's exported from index.ts

## What I cannot determine without human input

1. Whether `cli/hn-monitor.ts` (CLI-scoped) vs `hn-monitor-runner.ts` (library-scoped export) is a meaningful distinction for the architecture
2. Whether the work being in `cli/` vs root `src/` matters for the gate criteria
3. Whether this run should treat existing `cli/hn-monitor.ts` as satisfying the target, or rebuild it as `hn-monitor-runner.ts` at a different path
4. Whether the TARGET.md content is stale (work already merged) and this run should assess fresh gate-3 work instead

Without this clarification, I cannot produce an unambiguous work package.
