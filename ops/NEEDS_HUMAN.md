# NEEDS_HUMAN — target work already complete

**Date:** 2026-09-07
**Run ID:** 8bab7bdf-5b0c-4396-8c33-b59e0e709a49
**Assessor:** Relayflow Lead

## The Issue

ops/TARGET.md requests building "sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK" addressing five specific findings from closed PR #83.

**All requested work already exists in the codebase** and was merged in PR #120 on 2026-09-01 08:29 UTC.

## Evidence

All five findings from PR #83 are demonstrably addressed:

1. ✅ **Fail-closed on journal errors:** `packages/sdk/src/cli/hn-monitor.ts:252-266` classifies errors — `HnTransientFetchError` continues, all others (including journal failures) terminate with exit 1
2. ✅ **AgentWorker.close() documented:** `packages/sdk/src/worker.ts:24-29` explicitly documents that close() does NOT release worker registration
3. ✅ **Class field order:** `packages/sdk/src/worker.ts:32-34` declares all fields before constructor
4. ✅ **AbortSignal opt-in:** `packages/sdk/src/cli/hn-monitor.ts:59` accepts `signal?: AbortSignal`, no process-level handlers
5. ✅ **Test coverage:** `packages/sdk/tests/cli-hn-monitor.test.ts:240-260,194-214` tests both branches (fetch error survives, journal error terminates)

Gate 2 status per ops/STATE.md line 39-81: **AMBER** (trigger plane proven, two clauses remain for GREEN).

## The Question

What should this run produce?

## Options

**A. Accept TARGET.md is stale and assess the current highest-priority work**
- Ignore the TARGET.md pinning to gate 3
- Read the current state (ops/STATE.md, git log, open PRs) and write a fresh ops/NEXT.md for the actual highest-priority package
- This is what the charter (charter/LEAD.md:14-15) says to do: "Dispatch work... keep the rulebook alive... track acceptance evidence"

**B. Report completion and wait for new target**
- Accept that the target is complete
- File this NEEDS_HUMAN.md
- Wait for operator to update TARGET.md or provide new instructions
- Safe but burns a run cycle

**C. Work on the crash-resume hang (#174)**
- The EXISTING ops/NEXT.md (before this assessment overwrote it) pointed at fixing the `llm::sigkill_sweep` intermittent hang
- That work is NOT pinned to gate 3, it's a kernel-side bug blocking gate 1 hardening
- ops/TARGET.md says "Stay inside [the target] or, if the target is genuinely unreachable, say so in ops/NEEDS_HUMAN.md" — this is the "unreachable" case

## Recommendation

**Option A** aligns with the charter's job description. The Lead's role is to "sequence the gates" and "dispatch work" — not to wait for external TARGET.md updates when the state has moved forward.

The TARGET.md file lives "only in the throwaway launch worktree and is NOT in the delivered diff" (per the scope section provided by the user). If TARGET.md names completed work, the assessor should read current state and write the next package.

## What I Would Assess Next (if Option A)

Based on ops/STATE.md and the repo state:

1. **Gate 2 AMBER → GREEN blockers:**
   - Trigger plane liveness-checking (deterministic-id claim + stale_after sweep)
   - Analyze-agent step actually executing (currently all steps end in worker_error)

2. **Gate 1 hardening:**
   - Fix the crash-resume hang (#174) per the overwritten ops/NEXT.md

3. **Open PRs awaiting fixes:**
   - None per ops/STATE.md line 128

The crash-resume hang is the most concrete blocker with a reproduction path.

## Decision Required

Choose A, B, or C, or provide alternative instructions.
