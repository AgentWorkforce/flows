# NEEDS_HUMAN — Gate 3 Work Blocked on SDK Compilation Failures

**Date:** 2026-09-12
**Assessor:** Relayflow Lead (run 7b278196-2456-4206-a809-e1ec502a9205)
**Target Gate:** Gate 3

## The Block

Gate 3 work is pinned to building `sdk/src/hn-monitor-runner.ts` per ops/TARGET.md. However, the SDK cannot compile due to missing exports from the `@relayflows/surface` package.

## Evidence

Running `cd packages/sdk && npm ci` fails during the `prepare` script with TypeScript compilation errors. The kernel tests PASS (28 passed, 0 failed), so the kernel side is healthy. The SDK build fails with dozens of TS2305 errors:

```
> @relayflows/sdk@2.0.8 build
> tsc && node scripts/make-cli-executable.mjs

src/authored-flow-executor.ts(16,8): error TS2305: Module '"@relayflows/surface"' has no exported member 'LlmOptions'.
src/authored-flow-executor.ts(20,8): error TS2724: '"@relayflows/surface"' has no exported member named 'FlowCompletionReason'. Did you mean 'CompletionReason'?
src/authored-flow-executor.ts(24,10): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'createHelpers'.
src/authored-flow-executor.ts(24,25): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperProviders'.
src/authored-flow-executor.ts(24,47): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'HelperCall'.
src/helper-writeback.ts(5,10): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperClients'.
src/helper-writeback.ts(5,25): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperProviders'.
src/helper-writeback.ts(5,42): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'invokeHelper'.
src/helper-writeback.ts(5,61): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'HelperCall'.
src/preflight.ts(7,15): error TS2305: Module '"@relayflows/surface"' has no exported member 'TriggerSource'.
src/slack-preflight.ts(3,10): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperProviders'.
src/slack-writeback.ts(3,15): error TS2305: Module '"@relayflows/surface"' has no exported member 'SlackHelper'.
src/trigger-executor.ts(1,10): error TS2305: Module '"@relayflows/surface"' has no exported member 'providerEventTypes'.
src/trigger-executor.ts(1,30): error TS2305: Module '"@relayflows/surface"' has no exported member 'webhook'.
src/trigger-executor.ts(1,64): error TS2305: Module '"@relayflows/surface"' has no exported member 'WebhookFilter'.
```

And dozens more across authored-flow-executor.ts, authored-flow-loader.ts, authored-helper-effect.ts, authored-mcp.ts, authored-memory.ts, authored-worker-step.ts.

## Why This Blocks Gate 3 Work

1. Cannot run `npm test` — the test suite depends on `npm ci` completing successfully
2. Cannot add new code to `packages/sdk/src/` — any new file would inherit the broken build environment
3. Cannot verify existing SDK tests pass — definition of done requires "`cd packages/sdk && npm test` green"
4. Cannot write or test `hn-monitor-runner.ts` without a functioning SDK build

## The Question

**Which option should be pursued?**

### Option A: Fix the SDK compilation errors first (NOT gate 3 work)

This would require:
- Auditing `packages/surface/` to determine which exports are missing
- Either restoring the missing exports or updating all SDK import sites to use renamed/moved exports
- This is gate 6 territory ("integrations via relayfile") that would unblock gate 3

Downside: Violates the run's gate-3 scope. A gate-3 run fixing gate-6 blocking issues collides with any sibling gate-6 run.

### Option B: Wait for a human to resolve the SDK/surface import mismatch

A human audits `packages/surface/` and either:
1. Restores the missing exports, OR
2. Updates the SDK imports to match the current surface API

Once resolved, gate 3 work can proceed on a clean SDK.

Downside: Delays gate 3 progress until the human acts.

### Option C: File as blocked and park this run

Accept that gate 3 is unreachable from the current tree state. File this evidence and end with ASSESS_DONE. Let a different run (or a human) resolve the SDK compilation before gate-3 work resumes.

## Recommendation

**Option C.** The scope is gate 3 ("hn-monitor runner in SDK"). The blocker is gate 6 ("integrations/surface layer"). Fixing it here violates the parallel-runs contract from the charter: "Several drive runs execute in parallel, each pinned to a different gate. Work outside this target collides with a sibling run."

A blocked assessment with evidence is better than a run that wanders into different territory.

## If Human Chooses Option A

The work package would be:
- Audit `packages/surface/src/index.ts` and `packages/surface/src/runtime.ts`
- Restore missing exports OR update SDK import sites
- Verify `cd packages/sdk && npm ci && npm test` green
- Commit the fix separately before resuming gate 3

Files: `packages/surface/`, `packages/sdk/src/*.ts` (import sites)

Target: SDK compiles clean, no new features added
