# NEEDS_HUMAN — Stale TARGET.md, cannot determine valid work package

**Date:** 2026-09-12
**Assessor:** Relayflow Lead
**Run ID:** 3ae92acd-5ecc-46d4-897d-c19fc671cc65

## The Problem

This run was launched with ops/TARGET.md describing work that has already been completed and merged as PR #120 on 2026-09-01.

## Evidence

**ops/TARGET.md says:**
> Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side.

**ops/STATE.md says (lines 47-48):**
> PR #120 (`201542a`, merged 2026-09-01 08:29 UTC) — **`flows hn-monitor start`**, the CLI runner that turns the poller into an unattended process.

**File verification:**
```
ls -la packages/sdk/src/cli/hn-monitor.ts
# -rw-r--r-- 1 daytona daytona 11535 Sep 12 18:29 packages/sdk/src/cli/hn-monitor.ts
```

The hn-monitor CLI runner exists and was merged 11 days ago.

## The Conflict

ops/TARGET.md describes building code that already exists. It references "closed PR #83" and its five findings, which were addressed in the merged PR #120.

Additionally, ops/TARGET.md labels this as "gate 3" work, but the task described is gate 2 work per RFC-0001 §3:
- Gate 2: "hn-monitor runs as a relayflow in production"
- Gate 3: "a relayflow can power a factory → Software Garden"

## Options

I have documented five options in ops/NEXT.md:

**Option A:** Verify PR #120 code matches all five TARGET.md findings

**Option B:** Work on gate 2 AMBER → GREEN blockers (from ops/STATE.md):
- Implement trigger-plane liveness checking (RelayCron's deterministic-id claim + `stale_after` sweep)
- Fix analyze-agent step execution (worker_error → success)

**Option C:** Work on a different hn-monitor sub-PR (B: integration test, C: CLI improvements, D: STATE.md declaration)

**Option D:** Work on actual gate 3 (Software Garden / factory migration to kernel leases)

**Option E:** Cancel this run and launch a fresh one with correct TARGET.md

## My Recommendation

**Option B** — Address gate 2 AMBER → GREEN blockers from ops/STATE.md.

Reasoning:
1. RFC-0001 §3 sequencing: "gate 1 first; horizontals 5–8 as gate 1 holds; consumers 2 → 3 → 4"
2. Gate 1 is GREEN
3. Gate 2 is AMBER with specific remaining work documented in ops/STATE.md lines 60-73
4. Gate 2 should be completed before moving to gate 3

However, this requires substituting different work than TARGET.md specifies, which the charter forbids without human approval.

## Question for Human

**Which option (A, B, C, D, or E) should this run execute?**

If Option B, should future runs be launched with a corrected TARGET.md describing the actual gate 2 blockers?

## What I Did

1. Read ops/TARGET.md, ops/STATE.md, ops/DIRECTIVES.md, docs/bootstrap-report.md, RFC-0001
2. Verified the hn-monitor CLI runner exists at `packages/sdk/src/cli/hn-monitor.ts` (merged PR #120)
3. Identified the conflict between TARGET.md (describes completed work) and actual needs (gate 2 blockers)
4. Wrote ops/NEXT.md with the assessment and five options
5. Attempted to commit (failed: cloud sandbox has no `.git` per ops/STATE.md known fault)
6. Wrote this NEEDS_HUMAN.md

## What I Did NOT Do

Per charter/LEAD.md hard rails:
- I did NOT start work on any interpretation without human confirmation
- I did NOT silently substitute different work
- I did NOT work outside the TARGET.md scope (staying inside it is impossible because the work is already done)

## Commit Status

**Commit failed:** Cloud sandbox has no git repository (ops/STATE.md line 195: "No `.git`, no `gh`").

The charter says "Committing puts the package in git history rather than leaving it as a loose working-tree file." In a cloud sandbox, this is impossible. Both ops/NEXT.md and this file exist as working-tree files only.

Per ops/STATE.md line 207: "Work is committed in the sandbox and recovered with `agent-relay cloud sync <runId>`."

## Ending

Per charter instructions: "ALWAYS end with ASSESS_DONE, blocked or not: this gate cannot tell a different final token from a crashed agent."

I will end with ASSESS_DONE in my output after this file is written.
