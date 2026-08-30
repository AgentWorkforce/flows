# NEXT — work package for this tick

**Scope:** Build a minimal agent worker in the SDK. CODE task, SDK-side.

This run is pinned to **gate 3** and must not work on any other gate.

## Objective

Promote the throwaway worker the tests already build into a real SDK component. Nothing in this repo can execute an agent step. Searching for `workerAttach` / `step.complete` finds only TESTS (`sdk/tests/live-kernel.test.ts`, `journal-client.test.ts`, `journal-client-loopback.ts`) and the protocol definitions. `sdk/src/cli/run.ts` only OBSERVES worker leases and waits for one that never arrives.

The kernel's dispatch, lease and claim machinery is real and tested. The worker side of the protocol is simply unimplemented, and that is what blocks gate 2 ("a workload RUNS as a relayflow" — today a run can only be shown CREATED) and gate 3 ("every claim/lease/retry served by the kernel").

## Files in scope

- `sdk/src/worker.ts` — the new worker implementation
- `sdk/src/index.ts` — export the worker
- `sdk/tests/live-kernel.test.ts` OR a new test file — end-to-end test of a real flow with an agent step against live `relayflowd`, with this worker attached

## Definition of done

All of the following MUST hold:

1. **The worker in sdk/src, exported from sdk/src/index.ts**
   - attach for `agent` steps with the pins it holds
   - on `step.dispatch`, run the step's declared `cli` as a subprocess
   - report the result back through the existing protocol (`step.complete`, and the failure path when the CLI exits nonzero)
   - nothing speculative: no retries of its own, no scheduling, no LLM calls. The kernel owns retry and lease policy — do not reimplement it.

2. **A test that runs a real flow with an agent step end to end against a live `relayflowd`, with this worker attached, and asserts the step reaches `done`**
   - `sdk/tests/live-kernel.test.ts` already starts a daemon — follow that pattern
   - **the worker must attach BEFORE the run starts.** A run that finds no worker parks, and attaching afterwards does not re-drive it — `run.resume` is what picks a parked run back up. That contract is pinned in the live-kernel suite; do not fight it.

3. **The new test confirmed to FAIL against current code**
   - MUST quote the literal failing output in this summary or in a commit message

4. **`cd sdk && npm test` green**
   ```
   [paste literal output here after completion]
   ```

5. **`cd kernel && sh ../ops/cargo.sh test` green**
   ```
   [paste literal output here after completion]
   ```

6. **`git status --porcelain` output as your LAST action**
   ```
   [paste literal output here after completion]
   ```

## Explicitly OUT of scope

- Fixing the current SDK test failures (22 failed tests related to CLI preflight) — those are NOT gate 3 blockers
- LLM step workers — gate 3 is agent workers only
- Retry logic — the kernel owns that
- Workspace management beyond accepting pins
- Stream handling beyond what the protocol requires
- Integration mounts

## If blocked

If gate 3 is genuinely unreachable from the current state, write `ops/NEEDS_HUMAN.md` saying exactly why and still end with ASSESS_DONE. Do not silently substitute different work: a run that reports progress on the wrong gate is worse than one that reports it is blocked.

## Evidence from bootstrap and STATE.md

From `docs/bootstrap-report.md`: The protocol verbs exist (`worker.attach`, `step.heartbeat`, `step.complete` are types-only in serve; listed as needing implementation in WP-2). Gate 1 is GREEN. The kernel tests pass (19+19+1+1+26+5 = 71 passed).

From `sdk/tests/live-kernel.test.ts` around the `live-manual-agent` case (lines 268-307): the whole shape is already proven there:
- connect via JournalClient
- `hello('live-manual-worker')`
- `workerAttach('live-manual-agent', ['agent'], { workspace: [...], streams: [] })`
- await `step.dispatch` event
- (the worker closes without completing — this test is about the manual recovery state)

The pattern to follow is shown in the `follows a live worker dispatch through flows run` test (lines 172-202):
- await `step.dispatch` event
- complete with `worker.stepComplete(lease.run_id, lease.step_id, lease.attempt, lease.idempotency_key, 'success', { output, usage })`

The CRITICAL ordering requirement from lines 204-266: **attach BEFORE submitting events or starting runs**, because attaching afterwards does not re-drive a parked run. That contract is pinned; work with it, not against it.

## Current kernel test status

All kernel tests pass:

```
test result: ok. 19 passed; 0 failed (relayflowd lib)
test result: ok. 19 passed; 0 failed (crash_resume)
test result: ok. 1 passed; 0 failed (event_wake)
test result: ok. 1 passed; 0 failed (hn_monitor_integration)
test result: ok. 26 passed; 0 failed (relayflowd_core)
test result: ok. 5 passed; 0 failed (spec_parity)
test result: ok. 6 passed; 0 failed (relayflowd_journal)
```

Total: 77 passed, 0 failed. Gate 1 holds.
