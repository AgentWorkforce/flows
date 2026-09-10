# NEXT — work package for this tick

**DATE:** 2026-09-10
**ASSESSOR:** Relayflow Lead (flows-lead-1)
**TARGET:** Gate 3

## Scope

TARGET.md pins this run to **gate 3** with this task:

> Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test). Do not conflate the two.

However, **this work is ALREADY COMPLETE**. The `hn-monitor` CLI runner exists in full:
- `packages/sdk/src/cli/hn-monitor.ts` (287 lines) — the complete runner
- `packages/sdk/tests/cli-hn-monitor.test.ts` (347 lines) — comprehensive test coverage

The runner implementation addresses ALL five findings from PR #83:
1. ✅ Fail-closed on journal errors — `try { pollHackerNewsOnce } catch { instanceof HnTransientFetchError }` (lines 252-267)
2. ✅ AgentWorker.close() releases the worker — documented in `worker.ts:25-30` that `workerRelease` is not implemented yet
3. ✅ Class field declaration order — N/A, uses functions not classes
4. ✅ Signal handlers opt-in via AbortSignal — `signal?: AbortSignal` in HnMonitorArgs (line 59)
5. ✅ Test coverage for pollError branches — both cases tested (lines 240-261, 194-238)

The TARGET.md definition of done is ALREADY MET:
- ✅ `sdk/src/hn-monitor-runner.ts` exists → **Actually at `sdk/src/cli/hn-monitor.ts`**
- ✅ Worker attach before first poll → line 226 attach, line 238 starts loop
- ✅ Tests cover: fetch throw → survives (line 240), journal throw → terminates (line 194), worker attach before poll (implied by attach-then-loop ordering), abort signal shutdown (line 328)
- ✅ Exit cleanly on AbortSignal (line 238-272, tested line 328-345)
- ✅ Exported from `sdk/src/index.ts` → needs verification

## Assessment finding

**The task in TARGET.md is ALREADY COMPLETE.** This is a mismatch between the launch brief and the repository state. The runner was built and merged earlier (likely PR #120, cited in ops/STATE.md as merged 2026-09-01).

## What this run should do

**BLOCKED_ALREADY_COMPLETE** — The gate-3 task TARGET.md specifies is done. The proper path forward is:

1. **Verify the implementation against TARGET.md's definition of done** (ensure all requirements hold)
2. **Document that gate 3's sub-PR A is complete** in ops/NEEDS_HUMAN.md
3. **Ask the operator**: Should this run:
   - Verify the existing implementation meets all TARGET.md requirements and document completion?
   - Move to sub-PR B (integration test with real relayflowd)?
   - Move to sub-PR C (CLI wrapper, if not already done)?
   - Something else?

## Files in scope for verification

- `packages/sdk/src/cli/hn-monitor.ts` — the runner implementation
- `packages/sdk/src/index.ts` — verify runHnMonitor is exported
- `packages/sdk/src/worker.ts` — verify close() documentation (finding #2)
- `packages/sdk/tests/cli-hn-monitor.test.ts` — verify test coverage
- `packages/sdk/src/protocol.ts` — check for workerRelease verb

## Definition of done for THIS tick

Since the work is already complete, this tick's job is to:
1. Verify all TARGET.md requirements are met in the existing code
2. Run the tests and confirm they pass: `cd packages/sdk && npm test`
3. Document findings in ops/NEEDS_HUMAN.md with the exact state
4. Commit this assessment: `git add -A && git commit -m "assess: gate 3 work already complete"`
5. End with ASSESS_DONE

## Explicitly OUT OF SCOPE

- Writing new code (the runner already exists)
- Sub-PR B (integration test with real relayflowd) — separate PR per TARGET.md
- Sub-PR C (CLI wrapper) — may already exist, separate work package
- Sub-PR D (ops/STATE.md gate-2 declaration) — separate PR per TARGET.md
- Any changes to kernel/, workflows/, .github/
- Opening a PR (the operator decides next steps after this assessment)
