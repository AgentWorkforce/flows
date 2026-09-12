# NEXT — Gate 3 Work Package (BLOCKED)

**Date:** 2026-09-12 15:43 UTC
**Assessor:** Relayflow Lead (run 7b278196-2456-4206-a809-e1ec502a9205, attempt 2/3)
**Target Gate:** Gate 3
**Status:** BLOCKED on SDK compilation failures

## Scope (Quoted from Task)

Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test). Do not conflate the two.

RFC-0001 §3 gate 2 is done when "hn-monitor runs as a relayflow in production, triggered by its real events, with zero bespoke persistence." Every primitive already exists in this repo — event triggers (PR #14, `kernel/relayflowd/tests/event_wake.rs`), the flow spec (`testdata/hn-monitor.flow.yaml`), the poller (`sdk/src/hn-poller.ts`), the agent worker (`sdk/src/worker.ts` from PR #53), a one-shot demo (`sdk/src/demo-hn-monitor.ts`) — but nothing has ever run them together as a continuous workload. This PR fixes that.

## Assessment Findings

### Critical Block: SDK Cannot Compile

Attempted to assess gate 3 work (`hn-monitor-runner.ts` in the SDK). The SDK package cannot compile due to missing exports from `@relayflows/surface`. Running `cd packages/sdk && npm ci` fails during the `prepare` script:

```
> @relayflows/sdk@2.0.8 build
> tsc && node scripts/make-cli-executable.mjs

src/authored-flow-executor.ts(16,8): error TS2305: Module '"@relayflows/surface"' has no exported member 'LlmOptions'.
src/authored-flow-executor.ts(20,8): error TS2724: '"@relayflows/surface"' has no exported member named 'FlowCompletionReason'. Did you mean 'CompletionReason'?
src/authored-flow-executor.ts(24,10): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'createHelpers'.
src/authored-flow-executor.ts(24,25): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperProviders'.
src/authored-flow-executor.ts(24,47): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'HelperCall'.
```

Plus dozens more errors across authored-flow-executor.ts, authored-flow-loader.ts, authored-helper-effect.ts, authored-mcp.ts, authored-memory.ts, authored-worker-step.ts.

### Why This Blocks Gate 3

1. Cannot run `npm test` in packages/sdk — test suite depends on successful `npm ci`
2. Cannot add new code to `packages/sdk/src/` — any new file inherits the broken build
3. Cannot verify definition-of-done requirement: "`cd sdk && npm test` green"
4. Cannot write or test `hn-monitor-runner.ts` without a functioning SDK build

### Environment Status

**Cloud sandbox per ops/STATE.md known faults:**
- No `.git` (expected: sync in snapshot mode)
- No `cargo` command (expected: exec bit not preserved, tools unavailable)
- No `gh` auth (expected: no network to GitHub)

**Kernel status:** Cannot verify (`cargo test` unavailable in sandbox), but ops/STATE.md reports gate 1 GREEN on commit `9e1d9eb` (PR #8), extended by PR #12 (`e48631d`), asterisk closed by PR #48. No reason to suspect kernel regression.

**The block is SDK/surface layer mismatch**, not kernel health.

## The Work Package (If Unblocked)

### Objective

Add `sdk/src/hn-monitor-runner.ts` composing existing pieces into a continuous runner addressing five findings from closed PR #83:

1. **Fail-closed on journal errors** — Only fetch-level errors may be swallowed; `eventSubmit` journal failures MUST throw and terminate the runner
2. **AgentWorker.close() must release worker** — Add `workerRelease` verb to protocol.ts and call from `close()`, OR add one-line comment documenting what close() does NOT do
3. **Class field declaration order** — Declare ALL fields at top of class body, before constructor (ES2022 hoisting works today but breaks silently if `= someDefault` added)
4. **Signal handlers opt-in via AbortSignal** — Accept `signal?: AbortSignal` in options; no process-wide SIGTERM/SIGINT handlers (a library user embedding this can't cancel one runner without affecting others)
5. **Test coverage for pollError branch** — Assert loop survives a fetcher throw AND loop TERMINATES on a journal throw (without these, someone regresses `onPollError` to no-op and every test still passes)

### Files in Scope (When SDK Compiles)

- `sdk/src/hn-monitor-runner.ts` (new)
- `sdk/src/worker.ts` (modify `close()` only, per finding #2)
- `sdk/src/protocol.ts` (add `workerRelease` if needed)
- `sdk/src/index.ts` (add export)
- `sdk/tests/hn-monitor-runner.test.ts` (new, all 5 coverage cases)

### Definition of Done (When SDK Compiles)

1. `sdk/src/hn-monitor-runner.ts` exists, exports `HnMonitorRunner` from `sdk/src/index.ts`
2. `sdk/src/worker.ts` — either `close()` calls `workerRelease` (preferred), OR one-line comment names what close() intentionally does NOT do
3. `sdk/src/protocol.ts` — if `workerRelease` added, matching request/response definitions
4. `sdk/tests/hn-monitor-runner.test.ts` covers ALL:
   - fake fetch + mock journal client → runner submits event on each tick
   - abort signal triggers clean shutdown within one tick (worker released or documented)
   - worker attach happens before first poll
   - **fetch throw → loop survives** (onPollError called, next tick runs)
   - **journal throw → loop TERMINATES** (runner.run() rejects with error)
5. EVERY new test confirmed to FAIL against current code (comment out source; test fails), with literal failing output pasted in summary
6. `cd sdk && npm test` green (pretest hook builds kernel automatically per PR #69)
7. PR body explicitly names non-goals (test-actually-runs is sub-PR B; CLI is sub-PR C; gate-2 declaration is sub-PR D)
8. As LAST action, run `git status --porcelain` and paste it

### Explicit Non-Goals for THIS PR

- End-to-end integration test proving workload executes (dispatch → step complete) — sub-PR B
- CLI wrapper (`flows hn-monitor start`) — sub-PR C
- ops/STATE.md gate-2 GREEN declaration — sub-PR D

This PR ONLY proves the runner assembles and its unit tests hold.

### Out of Scope — DO NOT TOUCH

- `.github/workflows/*` — no GHA changes
- `kernel/*` — kernel side of gate 2 already works via PR #14
- `workflows/*.yaml` — for later sub-PRs
- `ops/AUTODRIVE_BRIEF.md` — chief owns this, not drive loop
- CLI wrapper — sub-PR C
- end-to-end integration test with real relayflowd — sub-PR B
- ops/STATE.md gate-2 declaration — sub-PR D

## Why Blocked (Human Decision Required)

Per charter: "Several drive runs execute in parallel, each pinned to a different gate. Work outside this target collides with a sibling run."

The scope is gate 3 ("hn-monitor runner in SDK"). The blocker is SDK/surface layer misalignment (missing exports from `@relayflows/surface`, likely gate 6 territory: "integrations via relayfile").

**Three options exist:**

### Option A: Fix SDK compilation in this run (NOT gate 3 work)

Audit `packages/surface/src/index.ts` and `packages/surface/src/runtime.ts`, restore missing exports OR update all SDK import sites to renamed/moved exports.

**Downside:** Violates gate-3 scope. A gate-3 run fixing gate-6 issues collides with any sibling gate-6 run.

### Option B: Wait for human to resolve SDK/surface import mismatch

Human audits `packages/surface/` and either restores missing exports or updates SDK imports to match current surface API. Once resolved, gate 3 work proceeds on clean SDK.

**Downside:** Delays gate 3 progress until human acts.

### Option C: Park this run as BLOCKED (Recommended)

Accept gate 3 is unreachable from current tree state. File evidence, end with ASSESS_DONE, let a different run (or human) resolve SDK compilation before gate-3 work resumes.

**Rationale:** Staying inside the target scope is what makes parallel execution safe. A blocked assessment with evidence is better than wandering into different territory.

## Recommendation

**Option C.** Park this run. The SDK/surface mismatch is outside gate-3 scope and needs resolution before hn-monitor-runner work is reachable.

## See Also

ops/NEEDS_HUMAN.md — filed by previous attempt, carries same evidence and options
