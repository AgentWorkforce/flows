# NEEDS_HUMAN — Gate 3 scope conflict

**Date:** 2026-09-10
**Assessor:** Relayflow Lead
**Run ID:** e8306001-36cc-4b45-b7ee-3eeae5db6a04

## The conflict

ops/TARGET.md (lines 1-96) pins this run to **gate 3** and scopes it to:

> Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test).

But ops/NEXT.md (lines 1-87, last modified before this run started) scopes this tick to:

> Track D: Cloud review-swarm redesign — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

These are **two different work packages** for the same gate:
- TARGET.md: SDK code (`packages/sdk/src/hn-monitor-runner.ts`)
- NEXT.md: GHA workflow (`.github/workflows/review-swarm.yml`)

## Per the charter (charter/LEAD.md line 7)

> Either way: QUOTE the scope into ops/NEXT.md, never cite the path. TARGET.md lives only in the throwaway launch worktree and is NOT in the delivered diff

The charter requires that I **quote the scope from TARGET.md into ops/NEXT.md**. But ops/NEXT.md already contains a complete, different work package. Overwriting it would lose the review-swarm work package.

## Additional finding: the hn-monitor runner already exists

The task described in TARGET.md — "Add `sdk/src/hn-monitor-runner.ts`" — has already been implemented and merged as PR #120 (merged 2026-09-01 08:29 UTC per ops/STATE.md lines 45-47):

1. **The runner exists:** `packages/sdk/src/cli/hn-monitor.ts` contains `runHnMonitor()`, a complete polling runner that addresses all five findings from PR #83 (TARGET.md lines 11-22).

2. **It has run in production:** `ops/reviews/20260901-1050-gate2-live-run.md` records a 1h39m unattended run against live Hacker News, with 9 runs created, deduped, and dispatched.

3. **The shape differs:** TARGET.md specifies a **class** `HnMonitorRunner` exported from `sdk/src/index.ts`. The current implementation is a **function** `runHnMonitor` not exported from index.ts (it's in `cli/hn-monitor.ts`).

## The exact question

**Which work package should this run execute?**

### Option A: Execute TARGET.md scope (hn-monitor runner)
- **Pros:** Follows the charter rule ("QUOTE the scope into ops/NEXT.md").
- **Cons:** The functional runner already exists and works in production. Creating a class wrapper risks duplicate functionality or regression. Also, TARGET.md says this is gate 3 work, but the runner is a gate-2 primitive (ops/STATE.md line 45), and gate 2 is AMBER, not complete.

### Option B: Execute NEXT.md scope (review-swarm GHA)
- **Pros:** NEXT.md says all work is complete ("Nothing. Every item this brief once listed is already done in this branch."). If true, this is a verification-only package.
- **Cons:** Violates the charter rule to quote TARGET.md scope into NEXT.md. Also, NEXT.md line 3 says this is "Parallel to Track A (hn-monitor)", implying multiple parallel runs, but this run is pinned to gate 3 only.

### Option C: Both are wrong
- The existing NEXT.md is stale (references #75/#77 PRs).
- The TARGET.md task is already complete in a different form (function vs class).
- A human should assign fresh gate-3 work.

## Files I examined

- ops/TARGET.md (gate 3 scope: hn-monitor runner)
- ops/NEXT.md (gate 3 scope: review-swarm GHA, claims complete)
- ops/STATE.md (gate 2 AMBER, no open PRs, gate 3 RED)
- ops/DIRECTIVES.md (empty, no standing directives)
- charter/LEAD.md (the scope-quoting rule)
- packages/sdk/src/cli/hn-monitor.ts (the existing runner function)
- ops/reviews/20260901-1050-gate2-live-run.md (production evidence)
- packages/sdk/src/index.ts (runner not exported)

## Recommendation

**Option C.** Both work packages appear to be complete or stale. A human should:

1. Confirm whether `runHnMonitor` (function in cli/hn-monitor.ts) satisfies the TARGET.md requirement, or if a refactor to a class `HnMonitorRunner` exported from index.ts is still required.

2. If the review-swarm work (NEXT.md) is incomplete, clarify what remains. If it is complete, close the work package.

3. Assign fresh gate-3 work or clarify gate-3's actual scope (TARGET.md line 5 says "gate 2 push" but line 1 says "gate 3").

---

**This run is BLOCKED_NEEDS_HUMAN and will not proceed with either work package until the scope conflict is resolved.**
