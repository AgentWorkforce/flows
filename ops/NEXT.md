# NEXT — Assessment: TARGET.md references completed work (PR #120)

## Scope (quoted from ops/TARGET.md line 5-6)

> Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test).

## Assessment finding: TARGET.md work is already merged

**Evidence that TARGET.md's task is complete:**

```
ls -la packages/sdk/src/cli/hn-monitor.ts
# -rw-r--r-- 1 daytona daytona 6824 Sep 12 21:20 packages/sdk/src/cli/hn-monitor.ts

wc -l packages/sdk/src/cli/hn-monitor.ts
# 287 packages/sdk/src/cli/hn-monitor.ts
```

The file `packages/sdk/src/cli/hn-monitor.ts` exists and implements `runHnMonitor`, a function matching TARGET.md's exact specification:
- Connects JournalClient to relayflowd socket
- Constructs AgentWorker, calls workerAttach before first poll
- Loops: pollHackerNewsOnce → sleep POLL_INTERVAL_MS → repeat
- Exits cleanly on AbortSignal.abort
- Fail-closed on journal errors (lines 9-11 document: "anything else → non-transient (journal failure OR programmer error); log with the actual class name and terminate")
- Transient fetch errors (HnTransientFetchError) logged and loop continues

**ops/STATE.md line 45 confirms PR #120 merged this work:**

> - PR #120 (`201542a`, merged 2026-09-01 08:29 UTC) —
>   **`flows hn-monitor start`**, the CLI runner that turns the poller
>   into an unattended process.

TARGET.md line 7 says "Prior attempt (PR #83, closed)" and frames this as new work ("sub-PR A"). But PR #120 completed the runner on 2026-09-01, addressing all five findings from #83 that TARGET.md lists.

## RFC-0001 §3 gate definitions contradict TARGET.md's title

**TARGET.md line 1:** "TARGET — gate 3"

**TARGET.md scope:** hn-monitor runner (gate 2 work per RFC-0001)

**RFC-0001 §3 Gate 2:**
> Done when: `hn-monitor` (or `linear`) runs as a relayflow in production — triggered by its real events, with **zero bespoke persistence functions**

**RFC-0001 §3 Gate 3:**
> ### Gate 3 — a relayflow can power a factory → **Software Garden**
> **Done when:** a labeled issue flows to a reviewed PR end-to-end with every claim/lease/retry served by the kernel

Gate 3 is Software Garden (factory migration), NOT hn-monitor. TARGET.md's title claims "gate 3" but its scope is gate 2 work that PR #120 already completed.

## Why no gate 3 work is startable from this codebase

Per STATE.md line 26:

> - **Gates 2, 3, 4, 5, 7, 8, 9: RED / AMBER as noted.** Gate 2 is AMBER; the rest are RED / not started.

Gate 3 is RED / not started. RFC-0001 gate 3 requires:
- Factory code (exists in different repo)
- Migration to kernel leases (discover → implement → review → merge DAG)
- "Software Garden" customer config surface

None of these components exist in this codebase. The kernel primitives (leases, journal, retry) are present from gate 1, but the factory-to-kernel integration has not begun.

Gate 2 is AMBER with two open clauses (STATE.md lines 60-73):
1. **Trigger plane liveness-checked** — relayflowd does not detect stopped pollers (RelayCron pattern: deterministic-id claim + stale_after sweep)
2. **Analyze-agent step actually executing** — recorded run shows every step ended worker_error because hn-monitor's AgentWorker has no user-supplied step handler

These ARE implementable in this codebase, but they are gate 2 work, not gate 3.

## The stale-target pattern

TARGET.md references "Prior attempt (PR #83, closed)" throughout lines 9-21, listing five findings to address. But those findings were addressed in PR #120 (merged 2026-09-01). The launcher (ops/launch-gate.sh per the charter's note) wrote TARGET.md referencing an old, closed attempt rather than checking current state.

This is the same pattern ops/NEEDS_HUMAN.md (already on disk) diagnosed:

> **Option C: TARGET.md is stale**
> - The launcher wrote an outdated TARGET.md referencing closed PR #83
> - Real work is in ops/NEXT.md (review-swarm)
> - Proceed with review-swarm, update TARGET understanding

That diagnosis was correct. TARGET.md is stale.

## Recommendation

Per the charter:

> If work is blocked on a human decision, write ops/NEEDS_HUMAN.md stating the exact question and the options — and then STILL end with ASSESS_DONE.

This run is blocked. The charter also says:

> If gate 3 is genuinely unreachable from the current state, write ops/NEEDS_HUMAN.md saying exactly why and still end with ASSESS_DONE. Do not silently substitute different work: a run that reports progress on the wrong gate is worse than one that reports it is blocked.

**The assessor's job is to write the work package for the current gate.** TARGET.md says "gate 3" but describes completed gate 2 work. RFC-0001 gate 3 (Software Garden) is not startable from this codebase. ops/NEEDS_HUMAN.md captures the question.

## Files in scope

None. This is an assessment finding, not executable work.

## Definition of done

Assessment complete. Block state documented in ops/NEEDS_HUMAN.md.

```
git add -A && git commit -m "assess: work package for this tick"
# Should commit ops/NEXT.md + ops/NEEDS_HUMAN.md
```
