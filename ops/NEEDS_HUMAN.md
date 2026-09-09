# NEEDS_HUMAN — TARGET.md asks for work already completed and merged

**Run ID:** 78782172-4dc5-4328-b004-0e98717ad471
**Date:** 2026-09-09

## The conflict

**ops/TARGET.md** (lines 1-5):
- Pinned to gate 3
- Scope: "Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK"
- Asks to create `sdk/src/hn-monitor-runner.ts`

**Actual state** (per ops/STATE.md lines 46-47):
- PR #120 (`201542a`, merged 2026-09-01 08:29 UTC) already delivered `flows hn-monitor start`
- The runner exists as `packages/sdk/src/cli/hn-monitor.ts` (287 lines)
- Tests exist in `packages/sdk/tests/cli-hn-monitor.test.ts` (16 tests, all passing)
- All 5 findings from TARGET.md lines 9-22 are already addressed:
  1. Fail-closed journal errors: hn-monitor.ts lines 252-266
  2. Worker close() documented: worker.ts lines 23-30
  3. Field declaration order: N/A (function-based, not class)
  4. AbortSignal opt-in: hn-monitor.ts line 59
  5. Test coverage: cli-hn-monitor.test.ts lines 102-175

**Test evidence from this assess tick:**
```
✓ tests/cli-hn-monitor.test.ts (16 tests) 104ms
```

SDK test suite: 892 passed, 3 failed (unrelated to hn-monitor: daemon spawning + Claude analyzer in live-kernel.test.ts).

## Why this is a blocker

TARGET.md describes sub-PR A of gate 2, but:
1. That work is done (PR #120, merged 2026-09-01)
2. Gate 2 is still AMBER with two remaining clauses (ops/STATE.md lines 60-73):
   - Trigger plane liveness-checked (deterministic-id + stale_after sweep)
   - The analyze-agent step actually executing (current runs end in worker_error)
3. Gate 3 cannot begin until gate 2 is GREEN (sequencing rule: consumers 2→3→4)

A run cannot "redo" merged work. Substituting different work would violate the scoping rule ("stay inside the target or report blocked").

## What the human needs to decide

**Option A:** Address the two remaining gate-2 AMBER clauses
- Implement trigger plane liveness checking in relayflowd
- Make the analyze-agent step execute (supply a step handler)
- Requires kernel changes (out of scope per TARGET.md line 77)

**Option B:** Flip gate 2 to GREEN based on existing evidence
- ops/STATE.md lines 74-81: "AMBER → GREEN is Khaliq's read"
- Evidence is in ops/reviews/20260901-1050-gate2-live-run.md
- Then gate 3 work can begin

**Option C:** Retarget this run to actual gate 3 work
- ops/NEXT.md on this branch says gate 3 review-swarm is done
- Clarify what gate 3 actually needs built (RFC-0001 §3: "the product chief runs as a relayflow")

**Option D:** Acknowledge TARGET.md is stale and skip this run
- The launcher wrote TARGET.md before PR #120 merged
- Autodrive loop should detect "work already merged" and retarget

## Recommendation

**Option D.** The TARGET.md asks to build something that exists. A run pinned to completed work should report that truthfully, not silently substitute different work.

The ops/TARGET.md was likely written before PR #120 merged (2026-09-01), and this run started 2026-09-09. The launcher should have detected the merge and either skipped this run or retargeted to the actual next gate-2 or gate-3 work.
