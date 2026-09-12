# NEEDS_HUMAN — Conflicting Work Package Context

**Situation:** This run has conflicting scope context that requires human clarification.

## The Conflict

1. **ops/TARGET.md says:** Gate 3, build hn-monitor runner (sub-PR A), `sdk/src/` code task
2. **ops/NEXT.md says:** Gate 3, cloud review-swarm preflight validation, `.github/workflows/` task  
3. **These are completely different tasks** — one is SDK code (track A per TARGET), one is GitHub Actions (track D per NEXT)

## Evidence

**ops/TARGET.md line 1-5:**
```
# TARGET — gate 3

This run is pinned to **gate 3** and must not work on any other gate.

**Scope:** Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side.
```

**ops/NEXT.md line 1-3:**
```
# NEXT — gate 3: complete cloud review-swarm preflight validation and documentation

**Scope:** Track D: Cloud review-swarm redesign — build `.github/workflows/review-swarm.yml` correctly this time
```

## The Charter Says

Per charter/LEAD.md (the instruction I received):
- "Read ops/TARGET.md if it exists" — it does, says hn-monitor
- "Then read ops/STATE.md, ops/DIRECTIVES.md" — done
- "Then write ops/NEXT.md: the SINGLE highest-priority work package toward the current gate"

But ops/NEXT.md ALREADY EXISTS with different work.

## Additional Context Found

**ops/STATE.md gate 2 block (lines 39-81)** says:
- PR #120 merged 2026-09-01 — `flows hn-monitor start` CLI runner
- Gate 2 is AMBER, not GREEN
- Two clauses remain: trigger-plane liveness, analyze-agent execution

**Actual file check:**
- `packages/sdk/src/cli/hn-monitor.ts` exists (288 lines)
- Contains `runHnMonitor` function implementing all TARGET.md requirements
- Addresses all five findings from closed PR #83

## The Question

**Which work package should this run execute?**

**Option A: ops/TARGET.md wins (hn-monitor, sdk/ territory)**
- Overwrite ops/NEXT.md with hn-monitor work package
- But the code already exists (PR #120 merged per STATE.md)
- Task would be verification/testing, not building from scratch

**Option B: ops/NEXT.md wins (review-swarm, .github/ territory)**
- Ignore ops/TARGET.md
- Execute the review-swarm validation work
- But TARGET.md explicitly pins this run to gate 3 hn-monitor work

**Option C: TARGET.md is stale**
- The launcher wrote an outdated TARGET.md referencing closed PR #83
- Real work is in ops/NEXT.md (review-swarm)
- Proceed with review-swarm, update TARGET understanding

**Option D: Both are stale**
- Neither accurately reflects current gate 3 needs
- Assessor should read RFC-0001 §3 gate 3 definition
- Write fresh work package from RFC requirements

## Recommendation

**Option C** — ops/TARGET.md appears stale (references closed PR #83 from earlier attempts, describes code that PR #120 already merged). The active work package is ops/NEXT.md (review-swarm). But I need human confirmation before overwriting NEXT.md or executing potentially wrong work.

## What I Need

**Clear answer:** Which work package is correct for this run?
- If hn-monitor: shall I overwrite the review-swarm NEXT.md, or is there a different file I should write?
- If review-swarm: shall I proceed with ops/NEXT.md as-is and ignore TARGET.md?
- If neither: what is the actual gate 3 work I should assess?
