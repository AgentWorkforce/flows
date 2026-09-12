# NEEDS_HUMAN — SDK compilation is broken, blocking ALL gate work

**Date:** 2026-09-12
**Run:** 2dd6fe73-d70c-4583-bf7e-6176faa1f74d

## CRITICAL BLOCKER: SDK cannot compile

The SDK package fails to build with 15+ TypeScript errors. This blocks BOTH ops/TARGET.md work (hn-monitor runner) AND ops/NEXT.md work (review-swarm docs). No gate work can proceed while `npm test` fails.

### Evidence — literal command output

```
$ cd packages/sdk && npm ci 2>&1 | tail -20

src/helper-writeback.ts(5,10): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperClients'.
src/helper-writeback.ts(5,25): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperProviders'.
src/helper-writeback.ts(5,42): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'invokeHelper'.
src/helper-writeback.ts(5,61): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'HelperCall'.
src/preflight.ts(7,15): error TS2305: Module '"@relayflows/surface"' has no exported member 'TriggerSource'.
src/slack-preflight.ts(3,10): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperProviders'.
src/slack-writeback.ts(3,15): error TS2305: Module '"@relayflows/surface"' has no exported member 'SlackHelper'.
src/trigger-executor.ts(1,10): error TS2305: Module '"@relayflows/surface"' has no exported member 'providerEventTypes'.
src/trigger-executor.ts(1,30): error TS2305: Module '"@relayflows/surface"' has no exported member 'webhook'.
npm error code 2
npm error command failed
```

Kernel tests pass: 28 tests, 0 failed. The kernel is healthy, the SDK is broken.

### Why this blocks ops/TARGET.md

ops/TARGET.md line 68 (definition of done):

> `cd sdk && npm test` green (pretest hook builds the kernel automatically)

TARGET explicitly requires literal test output pasted. The SDK cannot run tests because it cannot compile.

### Root cause

The surface package (`packages/surface/src/index.ts`) is missing exports that SDK requires:

**Missing from `@relayflows/surface/runtime`:**
- `helperClients`, `helperProviders`, `invokeHelper`, `HelperCall`

**Missing from `@relayflows/surface`:**
- `providerEventTypes`

Some exports DO exist (`webhook`, `TriggerSource`, `WebhookFilter`, `SlackHelper` at surface/src/index.ts:43-45) but compilation still fails referencing them.

### Why this is structural damage

Per ops/STATE.md (last updated 2026-09-01):
- NO open PRs (all merged or closed as of 2026-08-30 02:30)
- This broken state is on main

This is not a transient test flake. This is API contract breakage that survived merge.

## SECONDARY ISSUE: Conflicting work package definitions

**ops/TARGET.md:** Gate 3, build hn-monitor runner in sdk/src/ (but references closed PR #83)

**ops/NEXT.md:** Gate 3, document review-swarm secrets in README.md

These are completely different tasks. But both are moot while the SDK is broken.

## The question

**How should SDK compilation be fixed?**

**Option A:** Add missing exports to `packages/surface/src/runtime.ts` and `packages/surface/src/index.ts`
- Risk: May be exporting internal implementation details that were deliberately hidden

**Option B:** Remove stale imports from SDK files (helper-writeback.ts, slack-preflight.ts, etc.)
- Risk: May break runtime functionality that depends on those imports

**Option C:** Human investigates the API contract break and decides which side is correct

## Recommendation

**Option C.** This is a cross-package API contract question requiring judgment about:
1. Whether helper/trigger functionality should be exposed from surface package
2. Whether SDK features depending on those imports are still in scope
3. Which PR merged the breaking change (to understand intent)

Charter (charter/LEAD.md user instructions):

> If gate 3 is genuinely unreachable from the current state, write ops/NEEDS_HUMAN.md saying exactly why and still end with ASSESS_DONE.

Gate 3 (either interpretation) is unreachable. Covenant 2 (fail-closed) says do not work around broken tests.

## What unblocking requires

Human decision on the API contract:
1. Identify which commit broke the surface/SDK exports contract
2. Determine whether the break was intentional (surface slimmed down) or accidental (export statement missing)
3. Fix the correct side — either restore exports or remove stale SDK imports
