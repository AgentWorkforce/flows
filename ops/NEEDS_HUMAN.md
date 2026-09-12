# NEEDS_HUMAN — SDK broken state blocks gate 2/3 work

## The block

The SDK build is BROKEN with TypeScript compilation errors. This blocks ALL SDK-side work including:
- Gate 2 hn-monitor runner (ops/TARGET.md scope for this run)
- Gate 3 work that depends on SDK functionality

## Evidence

Running `cd packages/sdk && npm ci` fails with compilation errors:

```
error TS2688: Cannot find type definition file for 'node'.
error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperProviders'.
error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperClients'.
error TS2305: Module '"@relayflows/surface"' has no exported member 'TriggerSource'.
error TS2305: Module '"@relayflows/surface"' has no exported member 'SlackHelper'.
error TS2305: Module '"@relayflows/surface"' has no exported member 'providerEventTypes'.
error TS2305: Module '"@relayflows/surface"' has no exported member 'webhook'.
error TS2305: Module '"@relayflows/surface"' has no exported member 'WebhookFilter'.
error TS2339: Property 'model' does not exist on type 'AgentOptions'.
error TS2339: Property 'cli' does not exist on type 'AgentOptions'.
error TS2339: Property 'handlers' does not exist on type 'AuthoredFlowDefinition<unknown>'.
```

The kernel builds successfully:
```
cd kernel && sh ../ops/cargo.sh build
# Successfully compiles and installs Rust toolchain, builds all kernel crates
```

But the SDK cannot be tested or built, which means:
1. Cannot add `packages/sdk/src/hn-monitor-runner.ts` (ops/TARGET.md scope)
2. Cannot run `packages/sdk && npm test` to verify changes
3. Cannot verify any SDK-side work

## What the human needs to decide

1. **Is this a known/expected state?** The tree appears to be from a cloud sandbox with no git history. Perhaps this is a snapshot mid-work?

2. **What caused the break?** Possible causes:
   - Missing `@types/node` dependency
   - Breaking changes in `@relayflows/surface` package
   - Incomplete monorepo dependency sync
   - Package version mismatches

3. **Should the assessor fix this?** The charter says "If work is blocked on a human decision, write ops/NEEDS_HUMAN.md" — but this may NOT be a decision, it may be a "fix the build first" task that IS my job.

## The specific question

**Should this run:**
- A) Fix the SDK build errors as a prerequisite, THEN do the hn-monitor runner work?
- B) Report blocked and wait for human intervention to fix the build?
- C) Something else?

The ops/TARGET.md scope is "Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK" but the SDK doesn't build. The charter says to stay inside the target or report if unreachable — this appears unreachable without fixing the build first.

If option A: I need confirmation that fixing these compilation errors is in-scope as a prerequisite.
If option B: What needs to be fixed and by whom?
