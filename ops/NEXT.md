# NEXT — gate 2 work package: hn-monitor polling runner (sub-PR A)

**Scope (from TARGET.md):**

Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `packages/sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test). Do not conflate the two.

## Objective

Add `packages/packages/sdk/src/hn-monitor-runner.ts` that composes existing pieces (JournalClient, AgentWorker, HN poller) into a continuous runner that addresses all 5 findings from rejected PR #83.

## Files in scope

- `packages/packages/sdk/src/hn-monitor-runner.ts` (new file)
- `packages/packages/sdk/src/worker.ts` (modify `close()` per finding #2)
- `packages/packages/sdk/src/protocol.ts` (add `workerRelease` if implementing finding #2 option A)
- `packages/packages/sdk/src/index.ts` (export HnMonitorRunner)
- `packages/packages/sdk/tests/hn-monitor-runner.test.ts` (new file, all 5 test cases)

## Definition of done

All of these must hold:

1. `packages/sdk/src/hn-monitor-runner.ts` exists with:
   - JournalClient construction
   - AgentWorker construction and attach BEFORE first poll
   - Poll loop with configurable `POLL_INTERVAL_MS` (default 60000)
   - AbortSignal-based clean shutdown
   - Fail-closed on journal errors (finding #1): fetch errors swallowed, journal errors throw
   - AbortSignal opt-in (finding #4): no process-level signal handlers

2. `packages/sdk/src/worker.ts` — `close()` either:
   - Calls `workerRelease` (requires adding to `protocol.ts`), OR
   - Has one-line comment naming what `close()` does NOT do

3. `packages/sdk/tests/hn-monitor-runner.test.ts` with ALL 5 test cases:
   - Fake fetch + mock journal → events submitted each tick
   - AbortSignal triggers clean shutdown within one tick
   - Worker attach before first poll
   - **Fetch throw → loop survives** (onPollError called, next tick runs)
   - **Journal throw → loop TERMINATES** (runner.run() rejects)

4. All tests FAIL against current code before implementation:
   ```
   cd packages/sdk && npm test -- hn-monitor-runner.test.ts
   ```
   Paste literal failing output in PR body

5. After implementation, tests pass:
   ```
   cd packages/sdk && npm test
   ```
   Paste literal passing output

6. Class field declarations at top of class body (finding #3)

7. HnMonitorRunner exported from `packages/sdk/src/index.ts`

8. Final verification:
   ```
   git status --porcelain
   ```
   Paste output

## Explicitly OUT of scope

- End-to-end integration test with real relayflowd (sub-PR B, separate PR)
- CLI wrapper `flows hn-monitor start` (sub-PR C, separate PR)
- ops/STATE.md gate-2 GREEN declaration (sub-PR D, separate PR)
- `.github/workflows/*` — no GHA changes
- `kernel/*` — kernel side already works (PR #14)
- `workflows/*.yaml` — for later sub-PRs
- `ops/AUTODRIVE_BRIEF.md` — chief owns this
- LLM analyzer implementation — worker has no user-supplied step handler yet (that's gate 4 scope per STATE.md gate 2 AMBER section)

## Why this is the work package

TARGET.md pins this run to gate 3 work. However, the TARGET.md content describes gate 2 work (HN monitor runner). Per STATE.md line 39-81, gate 2 is AMBER with two remaining clauses:

1. Trigger plane liveness-checked (not implemented)
2. Analyze-agent step actually executing (worker_error, no handler)

This PR addresses the SDK-side scaffolding needed to move gate 2 toward GREEN. It does NOT claim to close gate 2 (that requires sub-PRs B, C, D plus the two AMBER clauses).

The TARGET.md says "gate 3" but describes gate 2 work. Per STATE.md line 26, gates 3-4 are RED/not started and gate 3 is the chief-as-relayflow. The scope described is clearly gate 2 (proactive agent, HN monitor). This work package follows the SCOPE, not the gate number mismatch.
