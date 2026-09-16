# NEEDS_HUMAN — TARGET.md Describes Already-Merged Work

**Date:** 2026-09-16
**Assessor:** Relayflow Lead
**Run ID:** f3f9bea4-a847-4697-a13f-ea8bf7fa51e1

## The Block

**ops/TARGET.md pins this run to gate 3 with SDK hn-monitor runner work.** However, that work was completed and merged in PR #120 on 2026-09-01 (15 days ago).

## Evidence

**TARGET.md says (lines 1-6):**
```
# TARGET — gate 3

This run is pinned to **gate 3** and must not work on any other gate.

**Scope:** Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK.
```

**ops/STATE.md says (lines 45-47):**
```
PR #120 (`201542a`, merged 2026-09-01 08:29 UTC) —
  **`flows hn-monitor start`**, the CLI runner that turns the poller
  into an unattended process.
```

**File verification:**
```
ls -la packages/sdk/src/cli/hn-monitor.ts
# -rw-r--r-- 1 daytona daytona 11535 Sep 16 12:24 packages/sdk/src/cli/hn-monitor.ts
```

The runner exists at packages/sdk/src/cli/hn-monitor.ts with 288 lines implementing:
- `runHnMonitor` function (lines 183-282)
- All five findings from PR #83 addressed
- Worker attach before first poll (line 227 attach, line 239 loop start)
- Fail-closed on journal errors (lines 254-268)
- AbortSignal support (lines 60, 239, 271-272)

Tests exist at packages/sdk/tests/cli-hn-monitor.test.ts.

## Why This Cannot Proceed

TARGET.md describes work that is complete. The run cannot:
1. Re-implement already-merged code
2. Write tests that already exist
3. Open a PR for changes that landed 15 days ago

## The Question

**What should this run work on instead?**

### Option A: Gate 2 Remaining Clauses

Gate 2 is AMBER per ops/STATE.md. Two clauses remain before GREEN:
1. **Trigger-plane liveness checking** — RelayCron's deterministic-id claim + `stale_after` sweep pattern, not yet implemented in relayflowd
2. **Analyze-agent step execution** — hn-monitor dispatches steps but worker has no user-supplied handler; every step ends in `worker_error`

Either would move gate 2 toward GREEN.

### Option B: Actual Gate 3 Work

RFC-0001 §3 defines gate 3 as "a relayflow can power a factory → Software Garden."

**Done when:** "a labeled issue flows to a reviewed PR end-to-end with every claim/lease/retry served by the kernel, the merge gate holding, and the run legible in the journal."

TARGET.md labels this "gate 3" but describes gate 2 primitives (proactive agent, events). Real gate 3 is factory DAG migration to kernel leases.

### Option C: Close As No-Work

The TARGET described complete work. Scoring this run as "blocked" is accurate - the target is unreachable because it's already done.

## Recommendation

**Option A** — retarget to gate 2's trigger-plane liveness. This is:
- Unambiguously gate 2 (per RFC-0001 §3 gate 2 paragraph)
- A stated done-when requirement, not optional hardening
- Unblocked (no dependencies on incomplete work)
- High-value (addresses Native's silent-death problem per RFC §5)

But I cannot retarget without human approval - my charter forbids wandering outside the assigned target.

## What I Need

**Clear directive:** Which gate and which specific work package should this run execute?

Provide either:
1. A retargeting decision (gate N, specific scope)
2. Confirmation to close this run as TARGET-already-complete
3. Corrected TARGET.md for a fresh run
