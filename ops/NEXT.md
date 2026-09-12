# NEXT — Gate 2 sub-PR A: SDK hn-monitor runner

## Scope (quoted from ops/TARGET.md)

> Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test). Do not conflate the two.

Note: ops/TARGET.md labels this as "gate 3" but describes gate 2 work per RFC-0001 §3. Gate 3 is "a relayflow can power a factory → Software Garden". Gate 2 is "hn-monitor runs as a relayflow in production". This work package addresses gate 2.

## Current state assessment

**The work is ALREADY DONE.** Per ops/STATE.md line 47:
- PR #120 (`201542a`, merged 2026-09-01 08:29 UTC) — **`flows hn-monitor start`**, the CLI runner

Verification:
```
ls -la packages/sdk/src/cli/hn-monitor.ts
# -rw-r--r-- 1 daytona daytona 11535 Sep 12 18:29 packages/sdk/src/cli/hn-monitor.ts
```

The file exists (288 lines per ops/NEEDS_HUMAN.md line 46) and contains `runHnMonitor` function implementing all TARGET.md requirements.

## Situation

This run was launched with a TARGET.md describing work that has already merged as PR #120. The TARGET.md references "closed PR #83" and its five findings, which were addressed in the merged PR #120.

**Three possible interpretations:**

1. **Stale TARGET.md** — The launcher used an outdated brief referencing the pre-#120 state. The actual highest-priority work is elsewhere (gate 2 AMBER → GREEN per ops/STATE.md lines 39-81, or gate 3 RED → work).

2. **Verification task** — The scope is to VERIFY PR #120 satisfied all five TARGET.md findings, not to rebuild it. Run tests, check the code, confirm it matches the requirements.

3. **Additional sub-PR** — There are multiple hn-monitor sub-PRs (A, B, C, D per TARGET.md lines 49-53) and this run should work on one of the unmerged ones (B: integration test, C: CLI wrapper improvements, D: ops/STATE.md declaration).

## Assessment

**This appears to be interpretation #1 (stale TARGET.md).** Evidence:

- ops/NEEDS_HUMAN.md (written by a previous assessor) flags the exact conflict: "TARGET.md appears stale (references closed PR #83 from earlier attempts, describes code that PR #120 already merged)"
- The TARGET.md describes building `sdk/src/hn-monitor-runner.ts`, but the merged code lives at `sdk/src/cli/hn-monitor.ts`
- ops/STATE.md gate 2 block lists what remains: trigger-plane liveness and analyze-agent execution — neither is "build the runner"

## Work package: BLOCKED — needs human clarification

**Objective:** Cannot determine valid work package from conflicting context

**The conflict:**
- ops/TARGET.md says: Build hn-monitor runner (sub-PR A), `sdk/src/`-side code task
- ops/STATE.md says: PR #120 merged the hn-monitor CLI runner on 2026-09-01
- ops/NEEDS_HUMAN.md says: TARGET.md is stale, references closed PR #83

**What remains for gate 2 per ops/STATE.md:**
1. Trigger plane liveness-checked (RelayCron's deterministic-id claim + `stale_after` sweep)
2. The analyze-agent step actually executing (current runs end in `worker_error` because no user-supplied step handler)

Neither of these matches the TARGET.md task (building the runner).

**Files in scope:** Cannot determine — depends on which interpretation is correct

**Definition of done:** Cannot determine — depends on clarification

**Explicitly OUT of scope:**
- Everything listed in ops/TARGET.md lines 74-82 (GHA, kernel, workflows, CLI wrapper for sub-PR C, integration test for sub-PR B, ops/STATE.md declaration for sub-PR D)

## Question for human

**Which work package should this run execute?**

**Option A:** Verify PR #120 code matches all five TARGET.md findings
- Read `packages/sdk/src/cli/hn-monitor.ts`
- Confirm each finding from closed PR #83 is addressed
- Run tests, verify they pass
- Report success/failure

**Option B:** Work on gate 2 AMBER → GREEN blockers (from ops/STATE.md)
- Implement trigger-plane liveness checking, OR
- Fix analyze-agent step execution (worker_error → success)

**Option C:** Work on a different hn-monitor sub-PR
- Sub-PR B: integration test with real relayflowd
- Sub-PR C: CLI wrapper improvements
- Sub-PR D: ops/STATE.md gate-2 declaration

**Option D:** Work on actual gate 3 (Software Garden / factory)
- RFC-0001 §3 gate 3: "a relayflow can power a factory"
- Implement kernel leases for factory claim protocols
- Migrate FactoryLoop to relayflows

**Option E:** This run should be canceled
- The TARGET.md is genuinely stale and irrecoverable
- No valid work can be determined from the context
- A fresh run with a correct TARGET.md should be launched

## Recommendation

**Option B** — Address gate 2 AMBER → GREEN blockers from ops/STATE.md. The RFC-0001 §3 sequencing rule is "gate 1 first; horizontals 5–8 as gate 1 holds; consumers 2 → 3 → 4". Gate 1 is GREEN. Gate 2 is AMBER with specific remaining work. That work should be completed before moving to gate 3.

However, this is a judgment call requiring human confirmation, not a deterministic read of the TARGET.md.

## What I did NOT do

Per charter instructions:
- I did NOT start work on any interpretation without human confirmation
- I did NOT silently substitute different work
- I did NOT commit changes (only this NEXT.md file should be committed)
- I WILL end with ASSESS_DONE after committing this file

## Next action

Human must clarify which option (A, B, C, D, or E) is correct, or provide a different scope. Once clarified, a subsequent run can execute the confirmed work package.
