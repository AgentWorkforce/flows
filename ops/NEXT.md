# NEXT — work package for this tick

**Scope:** Build a minimal agent worker in the SDK. CODE task, SDK-side.

This run is pinned to **gate 3** and must not work on any other gate.

## Objective

Promote the throwaway worker the tests already build into a real SDK component
that can execute agent steps by running their declared CLI as a subprocess.

## Context

**CORRECTED:** The worker ALREADY EXISTS at `sdk/src/worker.ts:19-91` (92 lines)
and IS EXPORTED from `sdk/src/index.ts:115`. The `AgentWorker` class implements:
- `attach()` — calls `client.workerAttach()` for 'agent' steps with pins
- `onDispatch` — receives `step.dispatch` events
- `execute()` — runs the CLI as subprocess via `spawn()`
- `stepComplete()` — reports results with `completionReason`

A test ALREADY EXISTS at `sdk/tests/live-kernel.test.ts:206-239` that exercises
the worker end-to-end: starts daemon, creates worker with pins, attaches,
starts a run with an agent step, and waits for the step to reach 'done'.

**Current state:**

Kernel tests: ALL GREEN (57 passed, 0 failed)
```
test result: ok. 19 passed; 0 failed
test result: ok. 1 passed; 0 failed
test result: ok. 26 passed; 0 failed
test result: ok. 5 passed; 0 failed
test result: ok. 6 passed; 0 failed
```

SDK tests: 22 failures out of 197 tests, including worker-related timeouts in
`tests/live-kernel.test.ts` and unrelated CLI test failures.

The gate 3 scope is NOT "build from scratch" — it is "verify the existing
worker is complete and fix any failures."

## Files in scope

- `sdk/src/worker.ts` — EXISTING worker at lines 19-91, verify completeness
- `sdk/src/index.ts` — ALREADY exports AgentWorker at line 115
- `sdk/tests/live-kernel.test.ts` — EXISTING test at lines 206-239, verify it passes

## Definition of done (from TARGET.md)

Quote from gate 3 scope: "the worker in sdk/src, exported from sdk/src/index.ts"
— SATISFIED, worker exists and is exported.

Quote: "a test that runs a real flow with an agent step end to end against a
live relayflowd, with this worker attached, and asserts the step reaches done"
— EXISTS at `tests/live-kernel.test.ts:206-239`, needs verification it passes.

Quote: "the worker must attach BEFORE the run starts. A run that finds no worker
parks, and attaching afterwards does not re-drive it — run.resume is what picks
a parked run back up."

Quote: "cd sdk && npm test green, and cd kernel && sh ../ops/cargo.sh test green"

Quote: "EVERY new test confirmed to FAIL against current code, with the literal
failing output quoted in your summary"

Quote: "as your LAST action, run git status --porcelain and paste it"

ALL of the following LITERAL commands must pass and their output PASTED:

1. ```
   cd sdk && npm test
   ```
   Expected: Test Files N passed, Tests N passed (current: 22 failed)

2. ```
   cd kernel && sh ../ops/cargo.sh test
   ```
   Expected: test result: ok. [total] passed; 0 failed (currently PASSES)

3. ```
   git status --porcelain
   ```
   (As LAST action)

The work is to DIAGNOSE why the SDK tests are failing and FIX them. The worker
implementation appears complete — the failures may be test configuration,
timing, or environmental issues.

## Explicitly OUT of scope

- LLM steps — not in the gate 3 scope
- Retry logic in the worker — the kernel owns retry policy
- Scheduling or lease management — the kernel owns lease policy
- Optimizations, abstractions, or speculative features
- Changes to the kernel
- Changes to existing tests (except adding new test cases)
- Work on any gate other than gate 3

## If blocked

If gate 3 is genuinely unreachable from the current state, write
ops/NEEDS_HUMAN.md saying exactly why and still end with ASSESS_DONE. Do not
silently substitute different work: a run that reports progress on the wrong
gate is worse than one that reports it is blocked.
