# NEXT — Blocked: TARGET.md scope already complete

**Scope quoted from TARGET.md:**

> Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test). Do not conflate the two.

## Assessment

This work package **is already complete**. The runner described in TARGET.md exists and was merged in PR #120 (per ops/STATE.md lines 45-47).

### Evidence

**File exists:**
```
ls -la packages/sdk/src/cli/hn-monitor.ts
# -rw-r--r-- 1 daytona daytona 11535 Sep 16 12:24 packages/sdk/src/cli/hn-monitor.ts
```

**Implementation complete:**
- `runHnMonitor` function at packages/sdk/src/cli/hn-monitor.ts:183-282
- All five findings from closed PR #83 are addressed (per TARGET.md lines 9-22):
  1. ✅ Fail-closed on journal errors: lines 254-268 distinguish `HnTransientFetchError` from journal failures
  2. ✅ Worker close contract documented: packages/sdk/src/worker.ts:32-38 explicitly states "Not implemented: releasing the worker registration"
  3. ✅ Field declaration order: worker.ts:42-43 declares fields before constructor
  4. ✅ AbortSignal for signal handlers: hn-monitor.ts:60 accepts `signal?: AbortSignal`
  5. ✅ Test coverage: packages/sdk/tests/cli-hn-monitor.test.ts exists (verified by find command)

**From ops/STATE.md:**
```
PR #120 (`201542a`, merged 2026-09-01 08:29 UTC) —
  **`flows hn-monitor start`**, the CLI runner that turns the poller
  into an unattended process.
```

### Why This Is Blocking

TARGET.md describes work that was completed and merged three weeks ago (2026-09-01 vs today 2026-09-16). This run cannot execute work that has already landed.

### What TARGET.md Asked For vs What Exists

**TARGET.md specification:**
- Add `sdk/src/hn-monitor-runner.ts`
- Exports `HnMonitorRunner` from `sdk/src/index.ts`
- Composes JournalClient + AgentWorker + pollHackerNewsOnce
- Worker attaches BEFORE first poll
- AbortSignal-driven clean shutdown
- Fail-closed on journal errors, transient on fetch errors

**What exists:**
- `sdk/src/cli/hn-monitor.ts` (288 lines)
- Exports `runHnMonitor` function (not a class, per design - line 5 comment)
- Composes JournalClient + AgentWorker + pollHackerNewsOnce - exact matches
- Worker attaches line 227, loop starts line 239 - ordering correct
- AbortSignal support lines 239, 271-272
- Fail-closed classification lines 258-266

**The implementation differs from TARGET.md's specification in naming only:**
- File: `cli/hn-monitor.ts` not `hn-monitor-runner.ts`
- Export: `runHnMonitor` function not `HnMonitorRunner` class
- Design rationale stated in comment (line 5): "public function (not a class)"

### Gate Status Per ops/STATE.md

Gate 2: AMBER (not GREEN). Two clauses remain:
1. Trigger-plane liveness checking
2. Analyze-agent step actually executing

Gate 3: Per RFC-0001 §3, gate 3 is "a relayflow can power a factory → Software Garden" - done when "a labeled issue flows to a reviewed PR end-to-end."

**TARGET.md says "gate 3" but describes gate 2 work.** The hn-monitor runner is gate 2 primitives (proactive agent, event triggers), not gate 3 (factory DAG).

## Recommendation

This run cannot proceed with the TARGET.md work package because:
1. The described work is complete (PR #120 merged)
2. Tests exist (packages/sdk/tests/cli-hn-monitor.test.ts)
3. The runner is in production per STATE.md's gate-2 evidence file

**Next steps require human decision:**

**Option A:** Retarget to gate 2's remaining clauses (trigger-plane liveness OR analyze-agent execution)

**Option B:** Retarget to actual gate 3 work (factory DAG on kernel leases, per RFC-0001 §3 lines 114-120)

**Option C:** Retarget to the review-swarm documentation work in the prior ops/NEXT.md

**Option D:** Close this run as successful-no-work-needed (the TARGET described complete work)

## Files Verified

None modified. Assessment only.

## Out of Scope

Everything - this run cannot execute until retargeted to reachable work.
