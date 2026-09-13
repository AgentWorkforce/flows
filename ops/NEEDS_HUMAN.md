# NEEDS_HUMAN — TARGET.md scope already complete, gate 3 needs definition

**Situation:** TARGET.md describes work that is already merged. Gate 3 work package needs human definition.

## The Core Issue

**ops/TARGET.md** (line 1) says "gate 3" but describes gate-2 work (hn-monitor runner, sub-PR A) that was **merged in PR #120 on 2026-09-01**.

The hn-monitor runner exists at `packages/sdk/src/cli/hn-monitor.ts` (288 lines) with all five findings from closed PR #83 addressed:

1. ✅ Fail-closed on journal errors (lines 254-268)
2. ✅ AgentWorker.close() drains workers (lines 275-278)
3. ✅ Field declaration order (functional approach, not class-based)
4. ✅ AbortSignal opt-in (lines 59-60, 127-142)
5. ✅ Test coverage (`tests/cli-hn-monitor.test.ts`, 15420 bytes)

**ops/STATE.md** (lines 44-47) confirms:
> PR #120 (`201542a`, merged 2026-09-01 08:29 UTC) —
> **`flows hn-monitor start`**, the CLI runner that turns the poller
> into an unattended process.

## What RFC-0001 §3 says gate 3 actually is

Gate 3 is **Software Garden** — the full issue-to-PR pipeline:

> **Gate 3 — a relayflow can power a factory → Software Garden**
>
> **Proves:** the flagship DAG. Discover → implement → review → merge-gate → close, on kernel leases instead of factory's ~10 hand-rolled claim protocols.
>
> **Done when:** a labeled issue flows to a reviewed PR end-to-end with every claim/lease/retry served by the kernel, the merge gate holding (no auto-merge without opt-in), and the run legible in the journal — while the customer-facing config surface mentions none of it.

This is a **multi-component, multi-PR gate** involving:
- Factory claim protocol migration to kernel leases
- Discover → implement → review → merge-gate → close pipeline
- Journal-backed run tracking
- Merge gate enforcement
- Customer-facing surface design

This is **not** a single work package. It requires phased planning.

## Why I cannot proceed

Charter instructions say:

> "Then write ops/NEXT.md: the SINGLE highest-priority work package toward the current gate (gate 1 until its done-when in RFC-0001 §3 holds)."

I cannot write a work package for TARGET.md's scope because **it is already complete**. I cannot start gate 3 without human direction on which component to build first.

## Gate 2 is AMBER, not GREEN

Per ops/STATE.md lines 59-81, gate 2 has two open clauses:

1. **Trigger plane liveness-checked** — RelayCron-style deterministic-id single-winner claim + stale_after sweep. The poller runs; the kernel doesn't notice if it stops.

2. **The analyze-agent step actually executing** — In the recorded live run (ops/reviews/20260901-1050-gate2-live-run.md), every step ended in `worker_error` because the AgentWorker has no user-supplied step handler. The dispatch loop works; the analyzer doesn't.

ops/STATE.md line 74-76 says:
> **AMBER → GREEN is Khaliq's read** on the enclosed evidence, per this
> block's prior wording ("that is a judgement, not a missing part") and
> per the charter's standing rule that the Lead never merges / never
> flips gates.

## The Question

**What is the actual work package for this assess run?**

**Option 1: Declare hn-monitor work done**
- Write ops/NEXT.md confirming PR #120 completed TARGET.md's scope
- Mark this as "assessment complete, target already merged"
- Let the launcher decide next target

**Option 2: Start gate 3 — first component**
- Human specifies which gate-3 component to build first:
  - Kernel lease primitive implementation?
  - Factory claim protocol migration plan?
  - Discover → implement flow scaffolding?
  - Merge gate enforcement?
- I write work package for that specific component

**Option 3: Fix gate 2 AMBER clauses**
- Write work package for trigger-plane liveness check (deterministic-id + stale_after sweep)
- OR write work package for analyze-agent step execution (user-supplied step handler)
- Gate 2 → GREEN before starting gate 3

**Option 4: Different direction**
- Human provides alternative scope

## Evidence Files

The assessment found these files:

```
packages/sdk/src/cli/hn-monitor.ts          # 288 lines, merged PR #120
packages/sdk/tests/cli-hn-monitor.test.ts   # 15420 bytes, test coverage
packages/sdk/src/worker.ts                  # AgentWorker implementation
packages/sdk/src/hn-poller.ts               # pollHackerNewsOnce primitive
```

All are committed on main. No unmerged work exists for TARGET.md's scope.

## What I Need

**Clear answer from human:** Which work package should I write in ops/NEXT.md?

- If option 1: I'll document that TARGET.md is complete and commit the assessment
- If option 2: Specify the gate-3 component to start with
- If option 3: Specify which gate-2 AMBER clause to address
- If option 4: Provide the actual scope

Without this, I cannot write an honest work package per charter requirements.
