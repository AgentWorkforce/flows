Build a minimal agent worker in the SDK. CODE task, SDK-side.

## Do not re-do these

Merged and closed; a PR redoing any will be closed:
  - picker actionability (#42), unterminated backticks (#45)
  - deterministic-command preflight refusal (#47) — do not touch preflight
  - the gate-1 race regression test (#48) — do not touch
    kernel/relayflowd/src/server/tests.rs or server.rs
  - ops/NEXT.md validation (#50, open) — do not touch
    sdk/src/work-package-validator.ts

## Why this matters

Nothing in this repo can execute an agent step. Searching for
`workerAttach` / `step.complete` finds only TESTS
(`sdk/tests/live-kernel.test.ts`, `journal-client.test.ts`,
`journal-client-loopback.ts`) and the protocol definitions. `sdk/src/cli/run.ts`
only OBSERVES worker leases and waits for one that never arrives.

The kernel's dispatch, lease and claim machinery is real and tested. The worker
side of the protocol is simply unimplemented, and that is what blocks gate 2
("a workload RUNS as a relayflow" — today a run can only be shown CREATED) and
gate 3 ("every claim/lease/retry served by the kernel").

## The task

Promote the throwaway worker the tests already build into a real SDK component.

`sdk/tests/live-kernel.test.ts` around the `live-manual-agent` case shows the
whole shape: connect, `hello`, `workerAttach` with pins, receive `step.dispatch`,
act, complete. Read it first — the protocol is already proven there.

Scope it small and honest:
  - attach for `agent` steps with the pins it holds
  - on `step.dispatch`, run the step's declared `cli` as a subprocess
  - report the result back through the existing protocol (`step.complete`, and
    the failure path when the CLI exits nonzero)
  - nothing speculative: no retries of its own, no scheduling, no LLM calls.
    The kernel owns retry and lease policy — do not reimplement it.

## Definition of done, all of it

  - the worker in sdk/src, exported from sdk/src/index.ts
  - a test that runs a real flow with an agent step end to end against a live
    `relayflowd`, with this worker attached, and asserts the step reaches
    `done`. `sdk/tests/live-kernel.test.ts` already starts a daemon — follow
    that pattern.
  - **the worker must attach BEFORE the run starts.** A run that finds no worker
    parks, and attaching afterwards does not re-drive it — `run.resume` is what
    picks a parked run back up. That contract is pinned in the live-kernel
    suite; do not fight it.
  - `cd sdk && npm test` green, and `cd kernel && sh ../ops/cargo.sh test` green
  - EVERY new test confirmed to FAIL against current code, with the literal
    failing output quoted in your summary
  - as your LAST action, run `git status --porcelain` and paste it

## If you cannot finish

Say so and file what you learned. A partial worker with an honest account beats
a complete-looking one that cannot execute a step — run 5ecf7078 refused an
impossible task with a reproduction and that was the right call.
