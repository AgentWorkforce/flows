# NEXT — Gate 2: Agent step handler to unblock AMBER→GREEN

**Scope conflict noted:** ops/TARGET.md requests `hn-monitor-runner.ts` but PR #120 already delivered that functionality as `cli/hn-monitor.ts`. ops/NEEDS_HUMAN.md documents this conflict and requests clarification. This work package addresses the ACTUAL gate 2 blocker identified in ops/STATE.md lines 68-73.

## Objective

Unblock gate 2's second remaining clause: make the analyze-agent step actually execute to completion instead of ending in `worker_error`.

Per ops/STATE.md: "In the recorded run, every step ended in `worker_error` because `hn-monitor start`'s AgentWorker has no user-supplied step handler. The dispatch loop works; the analyzer does not."

## Context

**Gate 2 status:** AMBER (ops/STATE.md lines 39-81)
- PR #120 merged the `flows hn-monitor start` CLI runner
- Live run evidence in `ops/reviews/20260901-1050-gate2-live-run.md` proves:
  - Trigger → subscription → dispatch loop works end-to-end
  - Real HN stories matched, deduped, dispatched under lease
  - But: every step ended in `worker_error`
- Two clauses remain for GREEN:
  1. Trigger plane liveness-checked (separate work)
  2. **Analyze-agent step actually executing** ← THIS PACKAGE

**What exists:**
- `packages/sdk/src/worker.ts` — AgentWorker class that attaches and receives dispatches
- `packages/sdk/src/cli/hn-monitor.ts` — CLI runner that creates AgentWorker
- `testdata/hn-monitor.flow.yaml` — flow spec with agent step(s)

**The gap:** AgentWorker has no mechanism to inject a step execution handler. It receives dispatches but cannot execute them to completion.

## Files in scope

- `packages/sdk/src/worker.ts` — add optional step handler to AgentWorker constructor
- `packages/sdk/src/cli/hn-monitor.ts` — wire a minimal handler into defaultAttachWorker
- `packages/sdk/tests/cli-hn-monitor.test.ts` — test that handler is invoked and step completes
- `testdata/hn-monitor.flow.yaml` — verify it has agent step(s) that would be dispatched

## Definition of done

All of these must hold:

1. **Test proves handler executes and step completes successfully**
   ```bash
   cd packages/sdk && npm test 2>&1
   ```
   Output must show:
   - All existing tests pass (no regressions)
   - New test in `cli-hn-monitor.test.ts` verifies:
     - Handler callback is invoked with step dispatch
     - Step completes with `completion_reason: "success"`, not `worker_error`
   - Total test count increases by at least 1

2. **worker.ts close() contract already satisfied**
   - Lines 32-37 already document: "Not implemented: releasing the worker registration"
   - This satisfies TARGET.md finding #2's OR clause

3. **No file moves or renames**
   - Keep `cli/hn-monitor.ts` (don't create `hn-monitor-runner.ts`)
   - Keep test in `cli-hn-monitor.test.ts` (don't create `hn-monitor-runner.test.ts`)
   - PR #120's structure is the accepted solution

4. **Minimal implementation**
   - Handler can be a no-op that calls `stepComplete` with success
   - No LLM integration required (that's gate 4 territory)
   - Focus: prove the dispatch → handler → completion loop closes

5. **As final action, capture:**
   ```bash
   git status --porcelain
   ```

## Explicitly out of scope

- Creating `sdk/src/hn-monitor-runner.ts` (TARGET.md asked for this, but PR #120 delivered `cli/hn-monitor.ts` instead - see ops/NEEDS_HUMAN.md)
- Exporting `HnMonitorRunner` from `index.ts` (CLI tool, not library export)
- LLM calls or real story analysis (gate 2 is about the LOOP, not analysis quality)
- Trigger plane liveness checking (gate 2 clause 1, separate work)
- workerRelease implementation (worker.ts already documents it's not implemented)
- ops/STATE.md gate-2 GREEN declaration (requires both clauses + Khaliq's approval)

## Why this is highest priority

Gate 1 is GREEN. Gate 2 is AMBER with two blockers. This is one of those two blockers.

Clause 2 ("analyze-agent step actually executing") is testable in isolation and unblocks:
- Gate 2 GREEN (once clause 1 also resolves)
- Gate 3 (depends on agent step execution working)
- Gate 4 (chief-as-relayflow depends on agent steps)

The trigger plane liveness check (clause 1) requires kernel changes. This work package can proceed in parallel and proves the SDK/worker side is ready.

## If blocked

If AgentWorker's architecture cannot accept a step handler without breaking its contract, document in ops/NEEDS_HUMAN.md:
- What was attempted
- What the architectural constraint is
- Options: refactor worker.ts vs. add handler interface vs. other approaches
