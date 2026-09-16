# NEEDS_HUMAN — TARGET.md describes already-completed work

## The conflict

**ops/TARGET.md** (the launcher's scoping) asks me to build `sdk/src/hn-monitor-runner.ts` as "sub-PR A" fixing five findings from closed PR #83.

**But:** PR #120 already merged on 2026-09-01 08:29 UTC (per ops/STATE.md line 45) delivering `sdk/src/cli/hn-monitor.ts` which addresses all five findings TARGET.md lists.

## Evidence that the work is already done

TARGET.md lists five findings from closed PR #83 that must be addressed:

1. **Fail-closed on journal errors** ✅ DONE
   - `cli/hn-monitor.ts` lines 263-267: journal errors classified as non-transient, terminate the runner
   - Tests at `tests/cli-hn-monitor.test.ts` lines 194-238 verify this

2. **AgentWorker.close() must release or document** ✅ DONE
   - `worker.ts` lines 32-37 document: "Not implemented: releasing the worker registration with the kernel"
   - Matches TARGET.md's OR clause: "explicitly document it does not"

3. **Class field declaration order** ✅ NOT APPLICABLE
   - `cli/hn-monitor.ts` uses functions, not classes
   - `worker.ts` (the AgentWorker class) has correct field order

4. **Signal handlers via AbortSignal** ✅ DONE
   - `cli/hn-monitor.ts` line 59: `signal?: AbortSignal` parameter
   - Tests lines 328-345 verify abort signal handling

5. **Test coverage for pollError AND journal throw** ✅ DONE
   - Poll error survival: tests lines 240-261 (HnTransientFetchError)
   - Journal throw termination: tests lines 194-214 (JournalProtocolError)

## What TARGET.md asked for vs what exists

TARGET.md definition of done says:
- `sdk/src/hn-monitor-runner.ts` exists → **NO**, only `sdk/src/cli/hn-monitor.ts` exists
- Exported from `sdk/src/index.ts` as `HnMonitorRunner` → **NO**, not exported
- Test file `sdk/tests/hn-monitor-runner.test.ts` → **NO**, only `tests/cli-hn-monitor.test.ts` exists

But the FUNCTIONALITY is complete - just in different files than TARGET.md specified.

## Gate confusion

**TARGET.md line 1** says: "This run is pinned to **gate 3**"

**TARGET.md scope** describes: hn-monitor polling runner, which is gate 2 work per RFC-0001 §3.

**ops/STATE.md** says:
- Gate 2 is AMBER (not GREEN)
- PR #120 merged the hn-monitor CLI runner
- Two clauses remain for gate 2 GREEN:
  1. Trigger plane liveness-checked
  2. Analyze-agent step actually executing (currently ends in worker_error)

**RFC-0001 §3** defines:
- Gate 2: "hn-monitor runs as a relayflow in production"
- Gate 3: "a labeled issue flows to a reviewed PR" (Garden/factory)

So TARGET.md calls this "gate 3" but describes gate 2 work.

## The question

**Which of these should I do?**

**Option A: Follow TARGET.md literally**
- Create `sdk/src/hn-monitor-runner.ts` duplicating `cli/hn-monitor.ts`
- Export `HnMonitorRunner` from `index.ts`
- Create duplicate tests in `hn-monitor-runner.test.ts`
- Result: Wasteful duplication, the file structure TARGET wanted but functionality already exists

**Option B: Assess gate 2's actual blocker**
- Per STATE.md lines 68-73: agent steps end in `worker_error` because AgentWorker has no step handler
- Work package: Add step handler to AgentWorker so analyze steps execute
- Ignore TARGET.md's specific file structure request since PR #120 solved it differently

**Option C: Assess gate 3's actual needs**
- TARGET.md SAYS gate 3 (though describes gate 2 work)
- Per RFC-0001, gate 3 is Garden/factory end-to-end
- Completely different work than TARGET.md describes

**Option D: Assess the existing ops/NEXT.md work**
- ops/NEXT.md says: document review-swarm secrets in README
- This is also claimed to be gate 3 work
- Different from both TARGET.md and gate 2's blocker

## Recommendation

**Option B** — Assess what gate 2 actually needs (the analyze-agent step handler), because:

1. TARGET.md's literal request (create hn-monitor-runner.ts) produces wasteful duplication
2. STATE.md explicitly identifies the analyze-agent step handler as gate 2's blocker
3. The gate number confusion (TARGET says 3, describes 2) suggests TARGET is stale
4. PR #120 already delivered the substance of what TARGET requested

But I need Khaliq's confirmation: should I follow TARGET.md literally (Option A) or assess the actual blocker (Option B)?

## What I need

**Clear answer:** Which option should I execute?
- If Option A: I'll create the duplicate files TARGET.md specifies
- If Option B: I'll write a work package for the agent step handler blocker
- If Option C or D: I'll assess that gate's actual needs instead
