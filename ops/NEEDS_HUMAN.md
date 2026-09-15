# NEEDS_HUMAN — TARGET.md Scope Mismatch with RFC and STATE

**Situation:** ops/TARGET.md exists but describes work already completed and mislabels it as gate 3 when RFC defines it as gate 2.

## The Evidence

**ops/TARGET.md line 1-6:**
```
# TARGET — gate 3

This run is pinned to **gate 3** and must not work on any other gate.

**Scope:** Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK.
```

Notice: TARGET.md says "gate 3" in the header but "Gate 2 push" in the scope description.

**ops/STATE.md lines 45-47:**
```
  - PR #120 (`201542a`, merged 2026-09-01 08:29 UTC) —
    **`flows hn-monitor start`**, the CLI runner that turns the poller
    into an unattended process.
```

**RFC-0001 §3 Gate 2 done-when:**
> `hn-monitor` (or `linear`) runs as a relayflow in production — triggered by its real events, with **zero bespoke persistence functions**

**RFC-0001 §3 Gate 3 done-when:**
> a labeled issue flows to a reviewed PR end-to-end with every claim/lease/retry served by the kernel... **Software Garden**

## What Actually Exists

The hn-monitor runner TARGET.md describes:
- **Merged in PR #120** per ops/STATE.md (2026-09-01)
- Lives at `packages/sdk/src/cli/hn-monitor.ts`
- Implements a `runHnMonitor()` function (not `HnMonitorRunner` class)
- Addresses all five findings from closed PR #83
- Is gate 2 territory per RFC-0001 §3

Verification:
```
ls packages/sdk/src/cli/hn-monitor.ts
# exists, 288 lines

grep -c "export async function runHnMonitor" packages/sdk/src/cli/hn-monitor.ts
# Output: 1

grep -r "class HnMonitorRunner" packages/sdk/src/
# Output: (none)
```

## The Contradiction

1. **TARGET.md line 1** says this run is pinned to gate 3
2. **TARGET.md line 5** describes work from "the Gate 2 push"
3. **RFC-0001 §3** defines gate 3 as Software Garden (factory migration), not hn-monitor
4. **RFC-0001 §3** defines gate 2 as hn-monitor running as a proactive agent
5. **ops/STATE.md** says the work described in TARGET.md was already merged (PR #120)
6. **TARGET.md lines 7-22** reference closed PR #83 and its five findings, but the actual merged code addressed those findings differently

## Why This Is Blocking

The charter says:
> "It is the operator's scoping decision and it overrides your own judgement about priority — several runs execute in parallel, each pinned to a different gate, and a run that wanders outside its target will collide with a sibling."

But I cannot determine the operator's intent when:
- The header says "gate 3"
- The scope paragraph says "Gate 2 push"
- RFC defines those gates as completely different things
- STATE.md says the described work is done

## The Question

**What should this run assess as the next work package?**

**Option A: Ignore TARGET.md header, follow the content**
- TARGET.md content describes gate 2 hn-monitor work
- But that work is merged (PR #120 per STATE.md)
- Write work package: verify/test the merged implementation?
- Risk: collides with a gate-2-pinned sibling run

**Option B: Follow TARGET.md header (gate 3)**
- Read RFC-0001 §3 gate 3 definition (Software Garden)
- Write work package toward factory migration
- Ignore the hn-monitor content in TARGET.md as stale
- Risk: if another run is gate-3-pinned, collision

**Option C: Treat TARGET.md as stale/corrupt**
- Read ops/STATE.md to determine actual gate state
- Gate 1: GREEN (per STATE.md line 15-25)
- Gate 2: AMBER (per STATE.md line 39-81)
- Write work package to close gate 2 AMBER → GREEN
- Risk: if launcher intended gate 3, violates charter

**Option D: Read ops/NEXT.md as ground truth**
- ops/NEXT.md says gate 3 review-swarm documentation
- Execute that work package
- Risk: NEXT.md may itself be stale from prior run

## Recommendation

**Option C with documented reasoning:** ops/STATE.md is explicitly "ground truth for an assessor with no git history" (line 1-9). Gate 2 is AMBER with two open clauses:
1. Trigger plane liveness-checked (not implemented)
2. Analyze-agent step actually executing (worker_error in recorded run)

These are the highest-priority gate-2 blockers per RFC covenant 2 and the done-when clause.

But I need human confirmation because:
- TARGET.md EXISTS (not absent, which would be normal per charter)
- TARGET.md contradicts itself (header vs content)
- Charter says TARGET scope "overrides your own judgement"

## What I Need

**Clear directive:**
- Should I follow TARGET.md header (gate 3) or content (gate 2)?
- Or should I follow ops/STATE.md gate priorities (close gate 2 AMBER)?
- Or should I execute ops/NEXT.md as-is (review-swarm docs)?

Without clarity, any choice risks violating the charter's parallel-run safety rule.
