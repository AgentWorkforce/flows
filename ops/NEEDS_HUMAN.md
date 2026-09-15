# NEEDS_HUMAN — TARGET.md Describes Completed Work

**Date:** 2026-09-15
**Assessor:** Relayflow Lead (this assessment run)
**Status:** BLOCKED_STALE_TARGET

## The Issue

ops/TARGET.md specifies work that was already completed and merged 15 days ago:

**TARGET.md says:**
> Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side.

**Reality:**
- PR #120 merged 2026-09-01 08:29 UTC (per ops/STATE.md line 47)
- `packages/sdk/src/cli/hn-monitor.ts` exists (288 lines)
- `packages/sdk/tests/cli-hn-monitor.test.ts` exists (346 lines)
- All 5 findings from TARGET.md are addressed in the merged code

## Evidence

**Finding #1 (fail-closed on journal errors)** — ADDRESSED:
```
packages/sdk/src/cli/hn-monitor.ts:257-268
Splits HnTransientFetchError (continue) vs others (terminate)
```

**Finding #2 (close() must release or document)** — ADDRESSED:
```
packages/sdk/src/worker.ts:32-37
Documents: "Not implemented: releasing the worker registration with the kernel"
```

**Finding #3 (field declaration order)** — MOOT:
Implementation uses function composition, not classes

**Finding #4 (AbortSignal opt-in)** — ADDRESSED:
```
packages/sdk/src/cli/hn-monitor.ts:59-60
Accepts signal?: AbortSignal in args
```

**Finding #5 (test coverage)** — ADDRESSED:
```
packages/sdk/tests/cli-hn-monitor.test.ts:238 — SURVIVES HnTransientFetchError
packages/sdk/tests/cli-hn-monitor.test.ts:206 — terminates on JournalProtocolError
```

## The Question

**What should this run do when TARGET.md describes completed work?**

**Option A: Verify the merged code**
- Run `cd packages/sdk && npm test`
- Confirm all tests pass
- Report: "TARGET.md scope satisfied by PR #120"
- But this isn't a "work package," it's verification

**Option B: Move to gate 3 actual work**
- Ignore TARGET.md
- Start Software Garden DAG implementation (RFC-0001 §3 gate 3)
- But TARGET.md explicitly pins this run to different scope

**Option C: Report blocked and await direction**
- Write ops/NEEDS_HUMAN.md (this file)
- Update ops/NEXT.md to document the situation
- End with ASSESS_DONE per charter

**I chose Option C** because:
1. Charter says: "If work is blocked on a human decision, write ops/NEEDS_HUMAN.md stating the exact question and the options — and then STILL end with ASSESS_DONE"
2. Cannot determine human intent when TARGET.md is 15 days stale
3. No open PRs need fixes (STATE.md line 129: "Open PRs: NONE")
4. No standing directives (ops/DIRECTIVES.md is empty)

## What a Human Should Decide

1. **Is the launcher generating stale TARGET.md files?**
   - This is the second time (previous run also hit hn-monitor/review-swarm conflict per old NEEDS_HUMAN.md)

2. **What is the actual highest-priority work?**
   - Gate 2 completion (trigger-plane liveness + analyze-agent execution)?
   - Gate 3 start (Software Garden DAG)?
   - Infrastructure (review-swarm, which the old NEXT.md mentioned)?

3. **Should stale-TARGET runs abort early?**
   - Or verify the merged code and report green?
   - Or attempt to derive next work from RFC §3 gate sequence?

## Files Updated

- `ops/NEXT.md` — assessment outcome (TARGET.md scope completed)
- `ops/NEEDS_HUMAN.md` — this file

## Commit Status

**Commit failed** (expected in cloud sandbox):
```
fatal: not a git repository: /home/daytona/.project-git
```

Per ops/STATE.md lines 195-208, sandboxes have no .git and cannot deliver. Charter instruction was to report commit failure rather than finish silently — reported here.
