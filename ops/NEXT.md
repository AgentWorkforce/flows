# NEXT — gate 3 work package: hn-monitor runner already complete, assess actual gate 3 status

**Scope (from TARGET.md):**

> Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test). Do not conflate the two.

## Current state assessment

The hn-monitor runner described in TARGET.md **already exists and was merged in PR #120 on 2026-09-01**. The file `packages/sdk/src/cli/hn-monitor.ts` (288 lines) implements the complete runner with all five findings from closed PR #83 addressed:

1. ✅ **Fail-closed on journal errors** — lines 254-268 split fetch errors (HnTransientFetchError, log and continue) from journal errors (non-transient, terminate with exit 1)
2. ✅ **AgentWorker.close() releases worker** — lines 275-278 drain in-flight executions; documented in worker.ts that workerRelease is gate-2 follow-up work (lines 160-162 comment)
3. ✅ **Field declaration order** — class-based approach was replaced with functional `runHnMonitor`
4. ✅ **Signal handlers opt-in via AbortSignal** — lines 59-60 accept `signal?: AbortSignal`; lines 127-142 implement interruptible sleep
5. ✅ **Test coverage** — `tests/cli-hn-monitor.test.ts` exists

However, **gate 3 has not started**. According to RFC-0001 §3:

> **Gate 3 — a relayflow can power a factory → Software Garden**
>
> **Proves:** the flagship DAG. Discover → implement → review → merge-gate → close, on kernel leases instead of factory's ~10 hand-rolled claim protocols.
>
> **Done when:** a labeled issue flows to a reviewed PR end-to-end with every claim/lease/retry served by the kernel, the merge gate holding (no auto-merge without opt-in), and the run legible in the journal — while the customer-facing config surface mentions none of it.

Gate 3 is about the **Software Garden** — the full issue-to-PR pipeline with kernel-backed leases. This is a massive multi-component gate. The current TARGET.md scope (hn-monitor runner for gate 2) is **complete** and **not gate 3 work**.

## Conflict: TARGET.md is pinned to wrong gate

TARGET.md line 1 says "gate 3" but describes gate-2 work (hn-monitor runner) that is already merged. This creates two possibilities:

**Option A:** TARGET.md's gate number is wrong — it should say "gate 2" and the work is done
**Option B:** TARGET.md is outdated — gate 3 work has not been defined yet

Per STATE.md lines 39-81, gate 2 is **AMBER** (not GREEN) with two open clauses:
1. Trigger plane liveness-checked (RelayCron-style deterministic-id + stale_after sweep)
2. The analyze-agent step actually executing (current runs end in worker_error)

## Actual gate 3 starting point

RFC-0001 §3 gate 3 requires building the Software Garden on kernel leases. This is a large undertaking requiring:

- Migration of factory's ~10 claim protocols to kernel leases
- Discover → implement → review → merge-gate → close pipeline
- Journal-backed run tracking
- Merge gate enforcement (no auto-merge without opt-in)
- Legible journal output for the full workflow

This is **not** a single-PR task — it's a multi-phase gate with many sub-PRs.

## The question for human decision

**The hn-monitor work in TARGET.md is complete. What is the actual gate 3 work package I should assess?**

Options:
1. **Declare TARGET.md work done** — write ops/NEXT.md stating the runner is complete, tests exist, and gate-2 sub-PR A is merged
2. **Start gate 3 planning** — write a work package defining the first Software Garden component (e.g., kernel lease primitive, or factory claim migration plan)
3. **Fix gate 2 AMBER→GREEN** — write a work package addressing the two remaining gate-2 clauses (trigger liveness check + analyze-agent execution)
4. **Something else** — human provides different direction

Without clear direction, I cannot write an honest work package. The TARGET.md scope is **already done** and gate 3's actual requirements are far larger than a single assess cycle.

## What I observed

Evidence that hn-monitor runner is complete:
```
ls -la packages/sdk/src/cli/hn-monitor.ts
# -rw-r--r-- 1 daytona daytona  8766 Sep 13 03:55 packages/sdk/src/cli/hn-monitor.ts

wc -l packages/sdk/src/cli/hn-monitor.ts
# 288 packages/sdk/src/cli/hn-monitor.ts

ls -la packages/sdk/tests/cli-hn-monitor.test.ts
# -rw-r--r-- 1 daytona daytona  15420 Sep 13 03:55 packages/sdk/tests/cli-hn-monitor.test.ts
```

The implementation includes:
- `runHnMonitor` function (lines 183-282)
- Fail-closed error classification (lines 254-268)
- AbortSignal support (lines 59-60, 127-142, 239-272)
- Worker attachment before first poll (lines 225-232)
- Clean shutdown with drain (lines 275-278)

The file was last modified on 2026-09-01 according to ops/STATE.md line 44-47:

> PR #120 (`201542a`, merged 2026-09-01 08:29 UTC) —
> **`flows hn-monitor start`**, the CLI runner that turns the poller
> into an unattended process.

## Files in scope

None — the work is complete.

## Definition of done

Cannot write a definition of done for work that is already merged.

## Explicitly OUT of scope

Everything — this ticket describes completed work.

---

**FILING ops/NEEDS_HUMAN.md** with the question above.

## Commit Status

**FAILED** — Git repository not available in this sandbox environment.

Attempted command:
```
git add -A && git commit -m "assess: work package for this tick"
```

Result:
```
fatal: not a git repository: /home/daytona/.project-git
```

This matches the known sandbox limitation documented in ops/STATE.md lines 195-200:

> **Known environment faults in a cloud sandbox**
>
> These are understood, filed, and are NOT reasons to block:
>
> 1. **No `.git`, no `gh`.** `sync` runs in `SYNC_MODE=snapshot`: the uploaded
>    tree is committed as its own base. `git log` shows one commit; that is
>    correct, not damage.

The work package files (ops/NEXT.md and ops/NEEDS_HUMAN.md) exist in the working tree and will be propagated through the executor's sync mechanism.
