# NEXT — work package for this tick

## Scope (from ops/TARGET.md)

Build a minimal agent worker in the SDK. CODE task, SDK-side.

The full scope from TARGET.md:

> Promote the throwaway worker the tests already build into a real SDK component.
>
> `sdk/tests/live-kernel.test.ts` around the `live-manual-agent` case shows the
> whole shape: connect, `hello`, `workerAttach` with pins, receive `step.dispatch`,
> act, complete. Read it first — the protocol is already proven there.
>
> Scope it small and honest:
>   - attach for `agent` steps with the pins it holds
>   - on `step.dispatch`, run the step's declared `cli` as a subprocess
>   - report the result back through the existing protocol (`step.complete`, and
>     the failure path when the CLI exits nonzero)
>   - nothing speculative: no retries of its own, no scheduling, no LLM calls.
>     The kernel owns retry and lease policy — do not reimplement it.

## Objective

Implement a standalone agent worker that can execute agent steps dispatched by
the kernel, running the step's declared CLI as a subprocess and reporting results
through the existing protocol.

## Files in scope

- New file in sdk/src for the worker implementation
- sdk/src/index.ts — export the worker API
- sdk/tests/live-kernel.test.ts — add a test showing an agent step running
  end to end with this worker attached
- New file in sdk/tests for isolated worker tests (optional)

## Definition of done (all required)

1. **Worker in sdk/src, exported from sdk/src/index.ts**

2. **A test that runs a real flow with an agent step end to end against a live
   relayflowd, with this worker attached, and asserts the step reaches `done`**
   - Must follow the pattern in `sdk/tests/live-kernel.test.ts`
   - Worker MUST attach BEFORE the run starts (attaching after does not
     re-drive parked runs - this contract is pinned in the live-kernel suite)

3. **cd sdk && npm test** must be green. Passing commands required:
   ```
   cd sdk && npm test
   ```

4. **cd kernel && sh ../ops/cargo.sh test** must be green. Passing commands:
   ```
   cd kernel && sh ../ops/cargo.sh test
   ```

5. **EVERY new test confirmed to FAIL against current code, with the literal
   failing output quoted in the summary**

6. **Final verification**:
   ```
   git status --porcelain
   ```
   Paste output showing modified/added files.

## Explicitly OUT of scope

- Retry logic (kernel owns this)
- Scheduling (kernel owns this)
- LLM steps (agent steps only)
- Helper surfaces (f.slack, f.notion)
- Integration with old engine
- Documentation files beyond code comments
- Fixing unrelated test failures

## Current state

Kernel tests must be green:
```
$ cd kernel && sh ../ops/cargo.sh test
test result: ok. 77 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.21s
```

SDK tests - current baseline:
```
$ cd sdk && npm test
Test Files  3 failed | 11 passed (14)
Tests  22 failed | 174 passed (196)
```
The 22 failures are CLI exit code mismatches in preflight checks - a known
sandbox environment issue (executable bit not preserved per ops/STATE.md
section on known environment faults). Worker implementation is independent
of these preflight issues.

**Open PRs**: NONE per ops/STATE.md

**Blockers**: NONE - protocol is ready, kernel dispatch machinery operational,
worker extraction from test code is straightforward.
