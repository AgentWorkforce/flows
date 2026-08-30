# NEXT — work package for this tick

**Target gate:** Gate 3 (Software Garden)

**Current state:** The agent worker prerequisite is COMPLETE. `sdk/src/worker.ts` exists, is exported from `sdk/src/index.ts`, and all tests pass (197/197 SDK, 77/77 kernel). The test "runs an agent CLI end to end through the SDK worker" at `sdk/tests/live-kernel.test.ts:206-239` passes, proving the worker can execute agent steps via their declared CLI.

## Objective

Build the Software Garden flow: issue → implementation → review → PR, with every claim/lease/retry served by the kernel instead of Factory's hand-rolled claim protocols.

## Context

From RFC-0001 §3 Gate 3:

> **Done when:** a labeled issue flows to a reviewed PR end-to-end with every claim/lease/retry served by the kernel, the merge gate holding (no auto-merge without opt-in), and the run legible in the journal — while the customer-facing config surface mentions none of it.

The worker now enables agent steps to execute, which unblocks building the Garden flow as a relayflow. Factory's `FactoryLoop` (~16,900 lines) with ~10 hand-rolled claim protocols (`leaseUntilMs` ×71, `heartbeat` ×490) should be migrated one claim family at a time (charter phase 7).

## Files in scope

TBD by next assess - this likely involves:
- A new `workflows/software-garden.yaml` or `.ts` flow definition
- Migration of Factory claim families to kernel leases
- Relayflow-based issue discovery → implementation → review → merge gate

## Definition of done

1. A labeled GitHub issue flows to a reviewed PR end-to-end
2. Every claim/lease/retry is served by the kernel (no Factory-style hand-rolled protocols)
3. The merge gate holds (no auto-merge without opt-in)
4. The run is legible in the journal
5. The customer-facing config surface mentions none of the internal machinery
6. `cd sdk && npm test` green (currently 197 passed, 0 failed)
7. `cd kernel && sh ../ops/cargo.sh test` green (currently 77 passed, 0 failed)
8. Literal passing command output pasted in the work summary

## Explicitly OUT of scope

- Work on gates other than gate 3
- Optimizations or speculative features
- Changes to the worker (it's complete)
- Changes to gate 1 machinery (tests.rs, server.rs, preflight)

## Notes from this assessment (2026-08-30)

The agent worker task from the previous ops/NEXT.md is COMPLETE:

### What was done (already in the tree)
- `sdk/src/worker.ts` exists with full implementation (92 lines)
- Exported from `sdk/src/index.ts:115`
- Test coverage at `sdk/tests/live-kernel.test.ts:206-239` passes
- Worker attaches for `agent` steps, handles `step.dispatch`, runs CLI as subprocess, reports via `step.complete`

### Test results

SDK tests after fixing known sandbox exec-bit issue:
```
$ cd /project/workflows/runs/b1f0e90d-47d5-49b5-bc5a-489e1a26aab7 && chmod +x testdata/preflight/*cli && npm test

 Test Files  14 passed (14)
      Tests  197 passed (197)
   Start at  14:57:19
   Duration  43.65s (transform 200ms, setup 0ms, collect 472ms, tests 41.29s, environment 2ms, prepare 536ms)
```

Kernel tests:
```
$ cd /project/workflows/runs/b1f0e90d-47d5-49b5-bc5a-489e1a26aab7/kernel && sh ../ops/cargo.sh test

test result: ok. 19 passed; 0 failed
test result: ok. 19 passed; 0 failed
test result: ok. 1 passed; 0 failed
test result: ok. 1 passed; 0 failed
test result: ok. 26 passed; 0 failed
test result: ok. 5 passed; 0 failed
test result: ok. 6 passed; 0 failed
(77 total passed, 0 failed)
```

Git status (cannot run in cloud sandbox):
```
$ git status --porcelain
fatal: not a git repository: /home/daytona/.project-git
```

The sandbox has no working git (known per STATE.md), only testdata/preflight/*cli files had exec bit added to fix test failures (also known per STATE.md §"Known environment faults").
