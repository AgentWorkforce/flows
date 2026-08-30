# NEXT — work package for this tick

**Scope (from TARGET.md):** Build a minimal agent worker in the SDK. CODE task, SDK-side.

Gate 3 is the current target, per ops/TARGET.md. The kernel's dispatch, lease, and claim machinery is real and tested. The worker side of the protocol is unimplemented - nothing in this repo can execute an agent step. Tests in `sdk/tests/live-kernel.test.ts` around the `live-manual-agent` case show the protocol shape, but today they are the ONLY code that implements a worker.

## Objective

Promote the throwaway worker the tests build into a real SDK component that attaches for agent steps, receives dispatches, executes the declared CLI as a subprocess, and reports results through the existing protocol.

## Files in scope

- `sdk/src/worker.ts` (new) — the worker implementation
- `sdk/src/index.ts` — export the worker
- `sdk/tests/live-kernel.test.ts` — add a test that runs a real flow with an agent step end to end against a live `relayflowd`, with the worker attached, asserting the step reaches `done`

## Definition of done

1. The worker exists in `sdk/src/worker.ts`, exported from `sdk/src/index.ts`
2. A test runs a real flow with an agent step end to end against a live `relayflowd`, with this worker attached, and asserts the step reaches `done`
3. **The worker attaches BEFORE the run starts** — a run that finds no worker parks, and attaching afterwards does not re-drive it (contract pinned in the live-kernel suite)
4. `cd sdk && npm test` green
5. `cd kernel && sh ../ops/cargo.sh test` green
6. EVERY new test confirmed to FAIL against current code, with the literal failing output quoted in this file
7. As the LAST action, `git status --porcelain` pasted

Commands that must pass:
```
npm test
cd /project/workflows/runs/cddedcb9-59ed-4069-82a1-0f11f9ec28df/kernel && sh ../ops/cargo.sh test
```

## Out of scope

- Retries of its own (kernel owns retry)
- Scheduling logic
- LLM calls (worker only runs CLI subprocesses)
- Anything speculative
- Modifying preflight (`sdk/src/work-package-validator.ts` per TARGET.md)
- Modifying kernel test files (`kernel/relayflowd/src/server/tests.rs` or `server.rs` per TARGET.md)

## Current state

SDK tests currently FAIL:
- 22 failed | 174 passed (196 total)
- Failures include timeouts in worker dispatch tests
- `tests/live-kernel.test.ts` has test cases that show the worker protocol but timeout because no real worker exists

Kernel tests: GREEN - 19+5+26+5+6 = 61 passed, 0 failed (verified 2026-08-30).

This work package will make gate 3 green by enabling agent steps to execute through a real worker, not just park.
