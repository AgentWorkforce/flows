# NEEDS_HUMAN — blocked on human decision

**Run:** d6d4cf38-6005-49ef-bb51-8a603db87312  
**Assessed by:** Relayflow Lead  
**Date:** 2026-09-15

## The block

This run is pinned to Gate 3 with a TARGET scope that describes building `sdk/src/hn-monitor-runner.ts` — a polling runner for the hn-monitor workload. However, this functionality **already exists** in `packages/sdk/src/cli/hn-monitor.ts` with full test coverage addressing all five findings from the rejected PR #83.

## The evidence

**What the TARGET asks for:**
- File: `sdk/src/hn-monitor-runner.ts`
- Exports: `HnMonitorRunner` from `sdk/src/index.ts`
- Behavior: JournalClient + AgentWorker + poll loop + AbortSignal shutdown

**What actually exists:**
- File: `packages/sdk/src/cli/hn-monitor.ts` (288 lines)
- Exports: `runHnMonitor()` function (NOT exported from index.ts, only from cli.ts)
- Behavior: Identical — JournalClient + AgentWorker + poll loop + AbortSignal shutdown
- Tests: `packages/sdk/tests/cli-hn-monitor.test.ts` (337 lines)

**All TARGET requirements are met:**
- ✓ Constructs JournalClient (hn-monitor.ts:144-149)
- ✓ Constructs AgentWorker (hn-monitor.ts:151-175)
- ✓ Worker attaches BEFORE first poll (hn-monitor.ts:227)
- ✓ Poll loop with sleep (hn-monitor.ts:239-273)
- ✓ AbortSignal for shutdown (hn-monitor.ts:59, 128-142, 271-272)
- ✓ Worker.close() drains in-flight work (hn-monitor.ts:277)
- ✓ Fail-closed: journal errors terminate, fetch errors continue (hn-monitor.ts:258-267)
- ✓ Test coverage for fetch-error survival (cli-hn-monitor.test.ts:215-234)
- ✓ Test coverage for journal-error termination (cli-hn-monitor.test.ts:236-257)
- ✓ Test coverage for worker-attach-before-poll (cli-hn-monitor.test.ts:179-213)

**The only difference:** file path (`cli/hn-monitor.ts` vs `hn-monitor-runner.ts`) and export surface (not exported from index.ts).

## The options

**Option A: Treat existing code as satisfying the target**
- The work is done; mark this gate complete
- Next assessment targets fresh Gate 3 work (whatever that is)
- Pro: avoids duplicate implementation
- Con: if file path/export matters architecturally, this is wrong

**Option B: Re-implement at the specified path**
- Create `sdk/src/hn-monitor-runner.ts` (not in `cli/` subdirectory)
- Export from `sdk/src/index.ts`
- Move or duplicate logic from `cli/hn-monitor.ts`
- Pro: literal compliance with TARGET
- Con: creates duplication; unclear why path matters

**Option C: TARGET.md is stale; assess fresh work**
- This run's TARGET was written before the work merged
- The Lead should assess what Gate 3 ACTUALLY needs now
- Write a fresh NEXT.md for current-state Gate 3 work
- Pro: stays productive on real gaps
- Con: if TARGET was deliberate, this is insubordination

## The question

**Which option should this run take?**

Alternatively: **Is there a Gate 3 requirement I'm missing** that makes `hn-monitor-runner.ts` distinct from `cli/hn-monitor.ts` in a way the TARGET didn't spell out?

I cannot proceed without this decision.
