# NEXT — BLOCKED: TARGET.md scopes already-completed work

## Assessment

This run is **BLOCKED** on contradictory scope. Cannot proceed without human clarification.

**Scope assigned in ops/TARGET.md (lines 1-5):**

> # TARGET — gate 3
>
> This run is pinned to **gate 3** and must not work on any other gate.
>
> **Scope:** Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side.

**Problem 1: The work is already done.**

Per ops/STATE.md:45-47, the hn-monitor CLI runner was merged in **PR #120** on 2026-09-01 08:29 UTC:

```
- PR #120 (`201542a`, merged 2026-09-01 08:29 UTC) —
  **`flows hn-monitor start`**, the CLI runner that turns the poller
  into an unattended process.
```

The implementation exists at `packages/sdk/src/cli/hn-monitor.ts` (288 lines) with all features TARGET.md describes:
- Constructs JournalClient connected to relayflowd socket
- Constructs AgentWorker and calls workerAttach() before first poll
- Loops: pollHackerNewsOnce → sleep POLL_INTERVAL_MS → repeat
- Exits cleanly on AbortSignal (drain in-flight steps, close client, close worker)
- Fail-closed on journal errors (covenant 2), transient-tolerant on fetch errors
- All five findings from closed PR #83 addressed

Test suite exists: `packages/sdk/tests/cli-hn-monitor.test.ts`

**Problem 2: Gate numbering is confused.**

TARGET.md:1 says "gate 3" but TARGET.md:5 says "Gate 2 push" and TARGET.md:71 acknowledges "the assessor on #83 confused itself" about gate numbers.

RFC-0001 §3 defines:
- **Gate 2** = proactive agent (hn-monitor runs as relayflow) — AMBER per STATE.md
- **Gate 3** = Software Garden (factory DAG: discover → implement → review → merge) — RED/not started

The hn-monitor runner is gate-2 work, not gate-3 work.

**Problem 3: Parallel execution collision.**

Per charter/LEAD.md:86-90:

> Several drive runs execute in parallel, each pinned to a different gate. Work outside this target collides with a sibling run, so staying inside it is not a preference — it is what makes parallel execution safe.

If I work on gate-2 follow-up (the two AMBER clauses in STATE.md:59-73), I'm outside my assigned gate-3 scope and collide with any sibling run pinned to gate 2.

If I work on actual gate-3 (Software Garden factory DAG), the TARGET.md description is nonsensical.

## What the previous run said

ops/NEEDS_HUMAN.md (from a previous assess run, same timestamp as TARGET.md) already identified this exact conflict and offered four options:
- A: TARGET.md wins (hn-monitor) — but code exists, task would be verification only
- B: Prior NEXT.md wins (review-swarm) — but TARGET pins to hn-monitor
- C: TARGET.md is stale (references closed PR #83) — NEXT.md is active work
- D: Both stale — write fresh from RFC-0001 gate-3 definition

That run ended blocked awaiting human decision. No decision was recorded.

## Current state verification

Verified the hn-monitor runner implementation is present and complete:

```bash
ls -l packages/sdk/src/cli/hn-monitor.ts packages/sdk/tests/cli-hn-monitor.test.ts
# -rw-r--r-- 1 daytona daytona 9468 Sep 15 12:59 packages/sdk/src/cli/hn-monitor.ts
# -rw-r--r-- 1 daytona daytona 18839 Sep 15 12:59 packages/sdk/tests/cli-hn-monitor.test.ts

grep -c "export async function runHnMonitor" packages/sdk/src/cli/hn-monitor.ts
# 1

grep -c "PR #120" ops/STATE.md
# 1
```

## The two remaining gate-2 AMBER clauses

ops/STATE.md:59-73 names two unfinished gate-2 requirements that COULD be valid work, but they're gate-2, not gate-3:

1. **Trigger plane liveness-checked** — kernel does not yet detect when a poller stops (needs RelayCron's deterministic-id claim + stale_after sweep pattern per RFC-0001 §3 gate 2).

2. **The analyze-agent step actually executing** — in the recorded run every step ended in `worker_error` because `hn-monitor start`'s AgentWorker has no user-supplied step handler. The dispatch loop works; the analyzer does not.

## Question for operator

**Which of these should this run work on?**

**Option A:** Actual gate-3 work (Software Garden factory DAG migration).
- Requires fresh assessment from RFC-0001 §3 gate-3 definition.
- No broken-down work package exists yet.

**Option B:** Gate-2 AMBER clause 1 (trigger plane liveness-checking).
- Add stale_after sweep + deterministic-id claim to kernel.
- This is gate-2 work → collision risk with sibling gate-2 runs.

**Option C:** Gate-2 AMBER clause 2 (analyze-agent step handler).
- Add user-supplied step handler to AgentWorker so hn-monitor steps complete successfully.
- Also gate-2 work → same collision risk.

**Option D:** Treat work as complete.
- The hn-monitor runner exists, PR merged, evidence filed.
- Report success, await new TARGET.md with different scope.

## Recommendation

**Option D** — The described work (hn-monitor CLI runner) is complete and merged. The confusion between gate 2 and gate 3 suggests the TARGET.md was generated from stale context (references closed PR #83).

If gate-3 work is genuinely needed, a fresh TARGET.md should scope actual gate-3 work (Software Garden factory DAG per RFC-0001 §3).

If gate-2 follow-up is needed (AMBER → GREEN), a new TARGET.md should:
1. Explicitly say "gate 2" not "gate 3"
2. Scope one of the two AMBER clauses specifically
3. Note it's follow-up work, not new scaffolding

## Files in scope (if Option D rejected)

Cannot be determined without operator decision on which option.

## Definition of done (if Option D rejected)

Cannot be determined without operator decision on which option.

## Out of scope

Everything, until scope is clarified.
