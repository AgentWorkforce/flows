# NEEDS_HUMAN — TARGET.md references completed work; gate 3 not startable

## The block

This run is pinned to gate 3 by ops/TARGET.md, but:

1. **TARGET.md's scope describes work already merged in PR #120**
2. **RFC-0001 gate 3 (Software Garden) is not startable from this codebase**

## Evidence: TARGET.md work is complete

**TARGET.md line 1:** "TARGET — gate 3"

**TARGET.md line 5-6:**
> Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side.

**But packages/sdk/src/cli/hn-monitor.ts already exists:**

```
ls -la packages/sdk/src/cli/hn-monitor.ts
# -rw-r--r-- 1 daytona daytona 6824 Sep 12 21:20 packages/sdk/src/cli/hn-monitor.ts

wc -l packages/sdk/src/cli/hn-monitor.ts
# 287 packages/sdk/src/cli/hn-monitor.ts
```

**ops/STATE.md line 45 confirms this is merged work:**

> - PR #120 (`201542a`, merged 2026-09-01 08:29 UTC) —
>   **`flows hn-monitor start`**, the CLI runner that turns the poller
>   into an unattended process.

TARGET.md line 9 says "Prior attempt (PR #83, closed)" and lists five findings to address, framing this as new work. But PR #120 (merged 2026-09-01) already addressed those findings and completed the runner.

## Evidence: gate confusion

**RFC-0001 §3 Gate 2 (hn-monitor):**
> Done when: `hn-monitor` (or `linear`) runs as a relayflow in production

**RFC-0001 §3 Gate 3 (Software Garden):**
> ### Gate 3 — a relayflow can power a factory → **Software Garden**
> **Done when:** a labeled issue flows to a reviewed PR end-to-end with every claim/lease/retry served by the kernel

TARGET.md title says "gate 3" but its scope is hn-monitor (gate 2 work). RFC-0001 gate 3 is Software Garden — factory migration to kernel leases, not hn-monitor.

**Per STATE.md line 26:**

> - **Gates 2, 3, 4, 5, 7, 8, 9: RED / AMBER as noted.** Gate 2 is AMBER; the rest are RED / not started.

Gate 3 is RED / not started. The components for Software Garden (factory code, migration to kernel leases, customer config surface) do not exist in this codebase.

## The question

**What work should this run execute?**

**Option A: Retarget to gate 2 remaining work**

Gate 2 is AMBER with two open clauses (STATE.md lines 60-73):
1. Trigger plane liveness-check (relayflowd does not detect stopped pollers)
2. Analyze-agent step execution (recorded run shows worker_error because no user-supplied handler)

Both are implementable in this codebase. Assessor could write a work package for one of these.

**Option B: Park as BLOCKED_STALE_TARGET**

TARGET.md references completed work (PR #120). Gate 3 (Software Garden per RFC-0001) is not startable. No executable work exists for the stated target. Block and wait for human retargeting.

**Option C: Substitute different work (NOT RECOMMENDED)**

Find some other task (docs, tests, refactoring) and write a work package. The charter warns:

> Do not silently substitute different work: a run that reports progress on the wrong gate is worse than one that reports it is blocked.

## Recommendation

**Option B.** The charter says:

> If gate 3 is genuinely unreachable from the current state, write ops/NEEDS_HUMAN.md saying exactly why and still end with ASSESS_DONE.

Gate 3 (Software Garden) is genuinely unreachable. TARGET.md's hn-monitor work is complete. The assessor's job is to assess, not to retarget or substitute work.

## What I need

**Clear answer:** Should this run:
1. Be retargeted to gate 2 (liveness-check or step handler)?
2. Park as BLOCKED_STALE_TARGET and wait for launcher fix?
3. Something else?

The TARGET/NEXT/gate-number conflict has appeared multiple times. Root cause may be ops/launch-gate.sh writing TARGET.md from stale context rather than current repo state.
