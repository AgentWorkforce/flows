# NEXT — work package for this tick

**Scope:** Fix the failing AgentWorker tests to complete gate 3.

This run is pinned to **gate 3** and must not work on any other gate.

## Objective

The AgentWorker has been implemented in `sdk/src/worker.ts` and is exported from
`sdk/src/index.ts`. Tests exist in `sdk/tests/live-kernel.test.ts` but 3 tests
are timing out or failing. Fix the test failures to complete gate 3.

## Context from ops/TARGET.md

Gate 3 requires: "Build a minimal agent worker in the SDK. CODE task, SDK-side."

The worker exists. The protocol machinery exists. The kernel's dispatch, lease
and claim machinery is real and tested. The worker side implementation is
complete but the end-to-end integration tests are not passing.

## Current state

Verified 2026-08-30 17:04 UTC:

**Kernel tests: GREEN**
```
$ cd kernel && sh ../ops/cargo.sh test
test result: ok. 71 passed; 0 failed
```

**SDK tests: 175/197 passed, 22 failed**

The failing tests are in `sdk/tests/live-kernel.test.ts`:
1. "runs rung (a), parks rung (b), and keeps JSON report-shaped" - expects exit
   code 3 (PARKED), gets 2 (REFUSED due to missing CLI)
2. "follows a live worker dispatch through flows run" - times out after 5000ms
3. "reports a real manual-recovery NeedsHuman state as parked" - times out after 5000ms

And in `sdk/tests/cli.test.ts`:
1. One test expects exit code 1, gets exit code 2

## Files in scope

- `sdk/tests/live-kernel.test.ts` - fix the 3 timing out / failing tests
- `sdk/tests/cli.test.ts` - fix the exit code mismatch (if related to worker)
- `sdk/src/worker.ts` - only if bugs are found in the worker implementation
- Test fixtures in `testdata/` - only if needed to make tests pass

## Definition of done

ALL of the following must hold:

1. `cd sdk && npm test` GREEN with all tests passing. Run it and paste the
   literal command and complete output showing test counts.

2. `cd kernel && sh ../ops/cargo.sh test` GREEN (already passing). Run it and
   paste the literal command and output tail showing test counts.

3. The three timing-out live-kernel tests must pass:
   - "follows a live worker dispatch through flows run"
   - "reports a real manual-recovery NeedsHuman state as parked"

4. The exit code mismatch in the first live-kernel test must be resolved so it
   correctly distinguishes REFUSED (missing CLI) from PARKED (missing worker).

5. Every fix must be explained: what was wrong, how it was fixed, and why the
   test now passes.

6. As your LAST action, run `git status --porcelain` and paste it.

## Explicitly OUT of scope

- LLM steps - not in the gate 3 scope
- New features beyond fixing the existing worker
- Retry logic in the worker - the kernel owns retry policy
- Scheduling or lease management - the kernel owns lease policy
- Changes to the kernel (unless a kernel bug is discovered)
- Work on any gate other than gate 3
- Optimization or refactoring beyond what's needed to pass tests

## If blocked

If gate 3 is genuinely unreachable (e.g., kernel bugs prevent the worker from
functioning), write ops/NEEDS_HUMAN.md with the exact problem, evidence, and
reproduction steps. Then still end with ASSESS_DONE.
