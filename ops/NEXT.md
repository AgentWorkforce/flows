# NEXT — Gate 2 work package: hn-monitor runner is complete, need verification

**Scope (quoted from TARGET.md):**

> Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test). Do not conflate the two.

## Assessment: Work already complete in PR #120

Per ops/STATE.md lines 45-48:
> PR #120 (`201542a`, merged 2026-09-01 08:29 UTC) — **`flows hn-monitor start`**, the CLI runner that turns the poller into an unattended process.

The runner EXISTS and WORKS, proven by live evidence in `ops/reviews/20260901-1050-gate2-live-run.md`. However, it was implemented differently than TARGET.md specified:

**TARGET.md specified:**
- `sdk/src/hn-monitor-runner.ts` (a composable class/function)
- Exported from `sdk/src/index.ts`
- `sdk/tests/hn-monitor-runner.test.ts`

**PR #120 delivered:**
- `sdk/src/cli/hn-monitor.ts` (CLI command implementation)
- NOT exported from index (CLI commands aren't SDK exports)
- `sdk/tests/cli-hn-monitor.test.ts` (exists, tests argv parsing + loop behavior)

**All five TARGET.md findings from closed PR #83 were addressed:**

1. ✅ Fail-closed on journal errors — `cli/hn-monitor.ts` classifies errors: `HnTransientFetchError` continues, all others terminate
2. ✅ AgentWorker.close() documented — `worker.ts:31-36` explicitly states what close() does NOT do (no workerRelease)
3. ✅ Class field declaration order — N/A, not a class-based implementation
4. ✅ Signal handlers opt-in via AbortSignal — `cli/hn-monitor.ts:50` accepts `signal?: AbortSignal`
5. ✅ Test coverage for error branches — `cli-hn-monitor.test.ts` includes transient/fatal error cases

## Current work status

**The runner itself is DONE.** What remains from TARGET.md's definition of done:

1. ❌ `sdk/src/hn-monitor-runner.ts` does not exist (work is in `cli/hn-monitor.ts` instead)
2. ❌ Not exported from `sdk/src/index.ts` (CLI commands don't export)
3. ✅ `worker.ts` documents what `close()` doesn't do (lines 31-36)
4. N/A `protocol.ts` — no workerRelease added (documented approach chosen)
5. ✅ Tests exist in `sdk/tests/cli-hn-monitor.test.ts`
6. ⚠️  `cd sdk && npm test` — cannot verify (TypeScript deps missing in sandbox, tried to run, failed on missing @types/node)
7. ⚠️  Tests confirmed to fail against current code — cannot verify without running tests
8. N/A PR body — PR #120 already merged
9. ✅ ops/STATE.md correctly says Gate 2 AMBER (lines 39-81)
10. ✅ `git status --porcelain` — will run at end

## The decision point

**This run is pinned to Gate 3 per TARGET.md line 1**, but the scope is Gate 2 work (hn-monitor runner). There is a mismatch.

**Options:**

**A. Accept PR #120 as satisfying the requirement**
- The runner works (live evidence exists)
- It addresses all five architectural findings
- Structure differs (CLI vs exported runner) but functionality is complete
- Work package: verify tests pass, update this assessment

**B. Build what TARGET.md specified**
- Create `sdk/src/hn-monitor-runner.ts` as a composable function
- Export from index.ts
- Refactor `cli/hn-monitor.ts` to call the exported runner
- This makes the runner reusable beyond the CLI

**C. Declare this run off-target**
- TARGET.md says Gate 3, but the work is Gate 2
- STATE.md shows Gate 2 is AMBER with different blockers (trigger-plane liveness, analyze-agent execution)
- Write ops/NEEDS_HUMAN.md asking for clarification

## Recommendation: Option B (build what was specified)

TARGET.md's scope is clear: "a real `hn-monitor` polling runner in the SDK", exported and composable. PR #120 delivered a CLI command that embeds the logic but doesn't export a reusable runner. The composable runner makes sense for:
- Sub-PR B (integration tests that import and run the runner directly)
- Future workloads that want the same pattern (poller + worker + journal)
- Separation of concerns (CLI parses args, runner executes logic)

This is legitimate remaining work, not duplication.

## Work package: Extract composable hn-monitor-runner

**Objective:** Create the exportable `HnMonitorRunner` specified in TARGET.md by extracting the logic from `cli/hn-monitor.ts`.

**Files in scope:**
- `packages/sdk/src/hn-monitor-runner.ts` (NEW) — composable runner class/function
- `packages/sdk/src/index.ts` — export `HnMonitorRunner`
- `packages/sdk/src/cli/hn-monitor.ts` — refactor to call exported runner
- `packages/sdk/tests/hn-monitor-runner.test.ts` (NEW) — unit tests for runner
- `packages/sdk/tests/cli-hn-monitor.test.ts` — keep CLI tests, may adjust imports

**Definition of done:**

1. `packages/sdk/src/hn-monitor-runner.ts` exists with exported runner (class or function)
2. Exported from `packages/sdk/src/index.ts`
3. `cli/hn-monitor.ts` refactored to use the exported runner (no duplicate logic)
4. `packages/sdk/tests/hn-monitor-runner.test.ts` covers:
   - Fake fetch + mock journal → runner submits events on each tick
   - AbortSignal triggers clean shutdown within one tick
   - Worker attach happens before first poll
   - Fetch throw → loop survives (finding #5 from TARGET.md)
   - Journal throw → loop TERMINATES (finding #5 from TARGET.md)
5. All existing tests continue to pass
6. Literal test failure output when source is commented out (per TARGET.md)
7. `git status --porcelain` as final action

**Explicitly OUT of scope:**

- `.github/workflows/*` (no GHA changes)
- `kernel/*` (kernel side done)
- `workflows/*.yaml` (later sub-PRs)
- CLI wrapper (already exists in `cli/hn-monitor.ts`)
- End-to-end integration test with real relayflowd (sub-PR B)
- ops/STATE.md gate-2 declaration (sub-PR D)
- `sdk/src/protocol.ts` workerRelease verb (documented as not-implemented per finding #2)

## If blocked

The main blocker is the TypeScript dependency installation failure. If `npm test` cannot run, the work package cannot be completed. This may require human intervention to fix the monorepo setup in the sandbox.
