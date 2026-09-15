# NEEDS_HUMAN — TARGET.md scopes already-completed work

## The Problem

ops/TARGET.md assigns work that was **already completed and merged** in PR #120 on 2026-09-01. The work package cannot proceed because the scope is internally contradictory.

## Evidence

**TARGET.md says (lines 1-7):**

```
# TARGET — gate 3

This run is pinned to **gate 3** and must not work on any other gate.

**Scope:** Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling
runner in the SDK. CODE task, `sdk/src/`-side.
```

**ops/STATE.md says (lines 45-47):**

```
- PR #120 (`201542a`, merged 2026-09-01 08:29 UTC) —
  **`flows hn-monitor start`**, the CLI runner that turns the poller
  into an unattended process.
```

**Verified in codebase:**

```bash
ls -l packages/sdk/src/cli/hn-monitor.ts packages/sdk/tests/cli-hn-monitor.test.ts
# -rw-r--r-- 1 daytona daytona 9468 Sep 15 12:59 packages/sdk/src/cli/hn-monitor.ts
# -rw-r--r-- 1 daytona daytona 18839 Sep 15 12:59 packages/sdk/tests/cli-hn-monitor.test.ts
```

The implementation at `packages/sdk/src/cli/hn-monitor.ts` contains all features TARGET.md requires:
- JournalClient construction + connection to relayflowd socket
- AgentWorker construction with workerAttach() before first poll
- Poll loop: pollHackerNewsOnce → sleep POLL_INTERVAL_MS → repeat
- Clean shutdown on AbortSignal (drain in-flight, close client, close worker)
- Fail-closed on journal errors (covenant 2), transient-tolerant on fetch errors
- All five findings from closed PR #83 addressed (per TARGET.md:9-22)

## Additional Contradictions

**1. Gate numbering confusion**

- TARGET.md:1 says "gate 3"
- TARGET.md:5 says "Gate 2 push"
- TARGET.md:71 acknowledges "the assessor on #83 confused itself" about gates

Per RFC-0001 §3:
- **Gate 2** = proactive agent (hn-monitor runs as relayflow) — AMBER per STATE.md
- **Gate 3** = Software Garden (factory DAG: discover → implement → review → merge) — RED/not started

The hn-monitor runner is gate-2 work that's already complete.

**2. Parallel execution risk**

Per charter/LEAD.md:86-90, multiple drive runs execute in parallel, each pinned to a different gate. If I work on gate-2 follow-up while assigned to gate-3, I collide with any sibling run pinned to gate-2.

## What Remains for Gate 2

ops/STATE.md:59-73 lists two unfinished gate-2 clauses (why gate 2 is AMBER, not GREEN):

1. **Trigger plane liveness-checked** — kernel does not detect when a poller stops. Needs RelayCron's deterministic-id claim + stale_after sweep pattern (RFC-0001 §3 gate 2: "a requirement, not an option").

2. **The analyze-agent step actually executing** — steps end in `worker_error` because AgentWorker has no user-supplied step handler. Dispatch works; analyzer doesn't. Whether this is gate-2 scope ("runs succeed") or gate-4 scope ("chief-as-relayflow supplies the runtime") is Khaliq's call.

These are valid gate-2 work, but they're NOT the work TARGET.md describes (which is the runner itself, now complete).

## The Question

**What should this run work on?**

**Option A: Actual gate-3 work (Software Garden factory DAG migration)**
- Honor TARGET.md's gate label, ignore its description.
- Requires fresh assessment from RFC-0001 §3 gate-3 definition.
- No broken-down work package exists yet for gate 3.

**Option B: Gate-2 AMBER clause 1 (trigger plane liveness-checking)**
- Implement stale_after sweep + deterministic-id claim in kernel.
- This is gate-2 work, not gate-3 → collision risk with sibling gate-2 runs.

**Option C: Gate-2 AMBER clause 2 (analyze-agent step handler)**
- Add user-supplied step handler to AgentWorker for successful step completion.
- Also gate-2 work → same collision risk.

**Option D: Treat TARGET.md work as complete**
- The hn-monitor runner exists, PR merged, evidence filed.
- Report success, await new TARGET.md with fresh scope.
- If gate-3 is needed: scope Software Garden factory DAG.
- If gate-2 follow-up is needed: scope one of the two AMBER clauses explicitly.

## My Recommendation

**Option D** — The work TARGET.md describes is demonstrably complete. The confusion (gate label says 3, description says gate-2 work, references closed PR #83) suggests stale context.

If continued gate-2 work is needed (AMBER → GREEN), the next TARGET.md should:
1. Say "gate 2" explicitly, not "gate 3"
2. Scope one of the two AMBER clauses by name
3. Clarify it's follow-up hardening, not new scaffolding

If gate-3 work is needed, the next TARGET.md should scope actual gate-3 work: Software Garden factory DAG migration per RFC-0001 §3.

## Why I Cannot Proceed

Per charter/LEAD.md:86-90:

> If gate 3 is genuinely unreachable from the current state, write
> ops/NEEDS_HUMAN.md saying exactly why and still end with ASSESS_DONE. Do not
> silently substitute different work: a run that reports progress on the wrong
> gate is worse than one that reports it is blocked.

The assigned gate-3 work is unreachable because it's already done. I cannot substitute gate-2 work without explicit authorization, or I collide with parallel runs. I cannot work on actual gate-3 (Software Garden) without a fresh scope breaking down that large, unstarted gate.

**I need explicit clarification: which option above should this run execute?**
