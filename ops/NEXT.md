# NEXT — work package for this tick

**Scope:** Fix the existing agent worker in the SDK to make its tests pass. CODE task, SDK-side.

This run is pinned to **gate 3** and must not work on any other gate.

## Objective

Fix the existing `AgentWorker` class in `sdk/src/worker.ts` (92 lines) so that
the existing test at `sdk/tests/live-kernel.test.ts:206` "runs an agent CLI end
to end through the SDK worker" passes.

## Current state (2026-08-30)

**AgentWorker already exists:** `sdk/src/worker.ts` (92 lines), exported from
`sdk/src/index.ts` line 8.

**Tests already exist:**
- `sdk/tests/live-kernel.test.ts:206` — "runs an agent CLI end to end through the SDK worker"
- `sdk/tests/live-kernel.test.ts:174` — "follows a live worker dispatch through flows run"

Both tests are FAILING (timeout in 5000ms). The worker exists but is not
working correctly.

**Kernel tests: GREEN** — all 44 tests pass (4+3+26+5+6 across all crates).

**SDK tests: 22 failed / 175 passed** — the worker tests are among the failures.

The worker code at sdk/src/worker.ts implements the protocol (workerAttach,
step.dispatch handler, stepComplete), but the tests time out, indicating the
worker is not handling dispatches correctly.

## Files in scope

- `sdk/src/worker.ts` — fix the existing worker implementation (92 lines)
- `sdk/tests/live-kernel.test.ts` — tests already exist at lines 174 and 206

## Definition of done

ALL of the following must hold and be verified with LITERAL COMMAND OUTPUT:

1. **The agent worker test passes.** Run this exact command and paste full output:

   ```
   cd sdk && npm test -- tests/live-kernel.test.ts -t "runs an agent CLI end to end through the SDK worker"
   ```

   Current state: FAILS with timeout in 5000ms.

   Must show: test PASSED.

2. **The worker dispatch test passes.** Run this exact command and paste full output:

   ```
   cd sdk && npm test -- tests/live-kernel.test.ts -t "follows a live worker dispatch through flows run"
   ```

   Current state: FAILS with timeout in 5000ms.

   Must show: test PASSED.

3. **Full SDK test suite green.** Run this exact command and paste the summary:

   ```
   cd sdk && npm test
   ```

   Current state: 22 failed / 175 passed.

   Must show: 0 failed tests.

4. **Kernel tests remain green.** Run this exact command and paste the summary:

   ```
   cd kernel && sh ../ops/cargo.sh test
   ```

   Current state: 44 tests pass (GREEN).

   Must show: all tests passed, 0 failed.

5. **AS YOUR LAST ACTION,** run this command and paste full output:

   ```
   git status --porcelain
   ```

   This shows which files were modified.

## Explicitly OUT of scope

Per TARGET.md constraints:

- Do NOT touch picker actionability (#42), unterminated backticks (#45)
- Do NOT touch deterministic-command preflight refusal (#47) — do not touch preflight
- Do NOT touch the gate-1 race regression test (#48) — do not touch
  kernel/relayflowd/src/server/tests.rs or server.rs
- Do NOT touch ops/NEXT.md validation (#50) — do not touch
  sdk/src/work-package-validator.ts
- Do NOT modify any kernel code (kernel/**)
- Do NOT add LLM step handling — not in gate 3 scope
- Do NOT add retries, scheduling, or lease management in the worker — kernel owns that
- Do NOT create new files — worker.ts already exists
- Do NOT add speculative features or optimizations
- Do NOT work on any other gate besides gate 3

## If blocked

If gate 3 is genuinely unreachable, write ops/NEEDS_HUMAN.md with the exact
reason and still end with ASSESS_DONE. Do not silently substitute different
work.
