# NEXT — BLOCKED: target requests already-completed work

**Run ID:** 78782172-4dc5-4328-b004-0e98717ad471
**Date:** 2026-09-09
**Assessment:** Work requested in ops/TARGET.md was completed and merged on 2026-09-01 in PR #120.

## What the target requested

From ops/TARGET.md (scope, lines 5-6):
> Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side.

The target specified creating `sdk/src/hn-monitor-runner.ts` with:
- A continuous runner composing JournalClient + AgentWorker + pollHackerNewsOnce
- Worker attach BEFORE first poll
- Clean shutdown on AbortSignal
- Five specific fixes from closed PR #83

## What already exists (merged 2026-09-01)

**PR #120** (`201542a`, merged 2026-09-01 08:29 UTC) delivered `flows hn-monitor start`:
- Implementation: `packages/sdk/src/cli/hn-monitor.ts` (287 lines)
- Tests: `packages/sdk/tests/cli-hn-monitor.test.ts` (16 tests, all passing)
- All five TARGET.md findings already addressed:
  1. Fail-closed journal errors: hn-monitor.ts:252-266
  2. Worker close() documented: worker.ts:23-30
  3. Field declaration order: N/A (function-based, not class)
  4. AbortSignal opt-in: hn-monitor.ts:59
  5. Test coverage: cli-hn-monitor.test.ts:102-175

## Current gate status

**Gate 2: AMBER** (ops/STATE.md:39-81). Two clauses prevent GREEN:
1. **Trigger plane liveness-checked** — relayflowd does not yet detect when a poller stops (deterministic-id single-winner claim + `stale_after` sweep pattern required per RFC-0001 §3 gate 2)
2. **The analyze-agent step actually executing** — in recorded runs every step ended `worker_error` because the AgentWorker has no user-supplied step handler

**Gate 3 sequencing:** RFC-0001 §3 sequence is "consumers 2 → 3 → 4". Gate 3 cannot begin until gate 2 is GREEN.

**Gate 3 definition** (RFC-0001 §3, lines 114-120):
> Gate 3 — a relayflow can power a factory → **Software Garden**
>
> **Proves:** the flagship DAG. Discover → implement → review → merge-gate → close, on kernel leases instead of factory's ~10 hand-rolled claim protocols.
>
> **Done when:** a labeled issue flows to a reviewed PR end-to-end with every claim/lease/retry served by the kernel, the merge gate holding, and the run legible in the journal.

## Why this blocks the run

The charter's hard rail (charter/LEAD.md:38-41):
> It is the operator's scoping decision and it overrides your own judgement about priority — several runs execute in parallel, each pinned to a different gate, and a run that wanders outside its target will collide with a sibling. Stay inside it or, if the target is genuinely unreachable, say so in ops/NEEDS_HUMAN.md rather than silently choosing different work.

**The target is unreachable:** the work it requests was merged 8 days ago. A run cannot "redo" merged work without regressing the codebase.

**Substituting different work violates the scoping rule.** The correct action is to report blocked and file the exact question for a human decision.

## What needs human decision

Recorded in ops/NEEDS_HUMAN.md with four options:
- **Option A:** Address gate-2 AMBER clauses (requires kernel changes, out of scope per TARGET.md)
- **Option B:** Flip gate 2 to GREEN based on existing evidence (Khaliq's call per ops/STATE.md:74-81)
- **Option C:** Retarget this run to actual gate 3 work (RFC-0001 §3 defines it)
- **Option D:** Acknowledge TARGET.md is stale and skip this run

**Recommendation:** Option D. The launcher wrote TARGET.md before PR #120 merged. A run pinned to completed work should report that truthfully, not silently substitute different work.

## No work package for this tick

This tick produces NO code changes. The assessment is:
1. Target requests `sdk/src/hn-monitor-runner.ts`
2. That functionality exists as `packages/sdk/src/cli/hn-monitor.ts` (merged PR #120)
3. All specified fixes are already implemented
4. Gate sequencing (2 → 3) prevents gate 3 work until gate 2 is GREEN
5. Blocked on human decision per ops/NEEDS_HUMAN.md

## Evidence

Test run from this assessment:
```
cd packages/sdk && npm test 2>&1 | grep hn-monitor
✓ tests/cli-hn-monitor.test.ts (16 tests) 104ms
```

SDK test suite status: Building (in progress at assessment time)

File existence:
```
ls -la packages/sdk/src/cli/hn-monitor.ts
-rw-r--r-- 1 daytona daytona 11484 Sep  9 21:11 hn-monitor.ts
```

Gate 2 status quote (ops/STATE.md:39):
> Gate 2 — proactive agent: AMBER, unattended trigger-plane proven, two clauses remain.

## Status

**BLOCKED_NEEDS_HUMAN** — see ops/NEEDS_HUMAN.md for the exact question and options.
