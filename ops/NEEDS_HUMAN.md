# NEEDS_HUMAN — SDK build broken, blocks gate 3 hn-monitor work

## The ask

**Should this gate 3 run fix the SDK TypeScript build errors first, or report blocked?**

## Context

TARGET.md assigns this run to gate 3: build sdk/src/hn-monitor-runner.ts (sub-PR A of gate 2 push). Definition of done requires `cd sdk && npm test` green.

**The SDK build is broken.** `npm ci` fails with 14 TypeScript compilation errors in files NOT mentioned in TARGET.md scope:

```
src/helper-writeback.ts(5,10): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperClients'.
src/helper-writeback.ts(5,25): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperProviders'.
src/helper-writeback.ts(5,42): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'invokeHelper'.
src/helper-writeback.ts(5,61): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'HelperCall'.
src/preflight.ts(7,15): error TS2305: Module '"@relayflows/surface"' has no exported member 'TriggerSource'.
(plus 9 more in slack-preflight.ts, slack-writeback.ts, trigger-executor.ts)
```

SDK depends on @relayflows/surface@2.0.8 but these imports reference non-existent exports.

## Options

### A: Fix the build, then do assigned work

1. Investigate @relayflows/surface package (monorepo? needs building? version mismatch?)
2. Fix imports or update package version
3. Verify `npm ci` succeeds
4. Implement hn-monitor-runner.ts per TARGET.md

**Risk:** TARGET.md warns "several runs execute in parallel, each pinned to a different gate" and "work outside this target collides with a sibling." If another run is fixing the SDK build, we collide.

**Benefit:** YC deadline is 2026-09-15 (3 days). Blocking might miss the window.

### B: Report this run as blocked

This file serves as the block report. assess-gate step parks the run as BLOCKED_NEEDS_HUMAN.

**Risk:** Delays gate 3 by at least one tick.

**Benefit:** Honors "stay inside your target" rule. Avoids collision. Clear separation of concerns.

## Why I cannot decide this

- Charter says "if a target is genuinely unreachable, write ops/NEEDS_HUMAN.md" — SDK not building makes done-when unreachable
- But charter also says "deadline truth: YC 2026-09-15" — fixing might be critical path
- TARGET.md explicitly says pinned to gate 3, warns against working outside scope
- I don't know if the surface/sdk breakage is being fixed by another parallel run
- I don't know if this is a known issue or a fresh regression

## What I know

- The SDK worked at some point (ops/STATE.md mentions passing SDK tests in merged PRs)
- This is a cloud sandbox (ops/STATE.md line 195 "known environment faults")
- The broken files are real SDK source files (not test fixtures)
- The symbols being imported (helperClients, helperProviders, TriggerSource, etc.) sound like legitimate API surface

## Recommendation

If no other run is assigned to fix the SDK build: **Option A** (fix then proceed) given deadline pressure.

If another run is fixing it: **Option B** (report blocked) to avoid collision.

I cannot determine which is true from this sandbox.

