# NEXT — work package for this tick

**Scope:** Build a minimal agent worker in the SDK. CODE task, SDK-side.

This run is pinned to **gate 3** and must not work on any other gate.

## Objective

Promote the throwaway worker the tests already build into a real SDK component
that can execute agent steps by running their declared CLI as a subprocess.

## Context

Nothing in this repo can execute an agent step. Searching for `workerAttach` /
`step.complete` finds only TESTS (`sdk/tests/live-kernel.test.ts`,
`journal-client.test.ts`, `journal-client-loopback.ts`) and the protocol
definitions. `sdk/src/cli/run.ts` only OBSERVES worker leases and waits for one
that never arrives.

The kernel's dispatch, lease and claim machinery is real and tested. The worker
side of the protocol is simply unimplemented, and that is what blocks gate 2
("a workload RUNS as a relayflow" — today a run can only be shown CREATED) and
gate 3 ("every claim/lease/retry served by the kernel").

`sdk/tests/live-kernel.test.ts` around the `live-manual-agent` case (line 288)
shows the whole shape: connect, `hello`, `workerAttach` with pins, receive
`step.dispatch`, act, complete. The protocol is already proven there.

## Files in scope

- `sdk/src/worker.ts` — new file, the worker implementation
- `sdk/src/index.ts` — export the worker
- `sdk/tests/live-kernel.test.ts` OR a new test file — add a test that runs a
  real flow with an agent step end to end against a live `relayflowd`, with
  this worker attached, and asserts the step reaches `done`.

## Definition of done

ALL of the following must hold:

1. The worker in `sdk/src/worker.ts`, exported from `sdk/src/index.ts`

2. A test that runs a real flow with an agent step end to end against a live
   `relayflowd`, with this worker attached, and asserts the step reaches
   `done`. `sdk/tests/live-kernel.test.ts` already starts a daemon — follow
   that pattern.

3. **The worker must attach BEFORE the run starts.** A run that finds no worker
   parks, and attaching afterwards does not re-drive it — `run.resume` is what
   picks a parked run back up. That contract is pinned in the live-kernel
   suite; do not fight it.

4. The worker must:
   - attach for `agent` steps with the pins it holds
   - on `step.dispatch`, run the step's declared `cli` as a subprocess
   - report the result back through the existing protocol (`step.complete`, and
     the failure path when the CLI exits nonzero)
   - nothing speculative: no retries of its own, no scheduling, no LLM calls.
     The kernel owns retry and lease policy — do not reimplement it.

5. `cd sdk && npm test` must be green. Run it and paste the literal command and
   output tail showing test counts.

6. `cd kernel && sh ../ops/cargo.sh test` must be green. Run it and paste the
   literal command and output tail showing test counts.

7. EVERY new test confirmed to FAIL against current code, with the literal
   failing output quoted in the summary.

8. As your LAST action, run `git status --porcelain` and paste it.

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
