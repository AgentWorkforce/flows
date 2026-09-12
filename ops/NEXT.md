# NEXT — work package for this tick

**Gate:** 2 (proactive agent)

**Scoped task from ops/TARGET.md:**

> Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side. This is a scaffolding PR — proof that the workload EXECUTES end-to-end is deliberately deferred to sub-PR B (integration test). Do not conflate the two.
>
> Prior attempt (PR #83, closed) produced a functional runner but was rejected by the swarm on five real findings. Address them in this attempt:
>
> 1. Fail-closed on journal errors — split: `try { fetch } catch { onFetchError }` around the network call, `try { eventSubmit } catch { rethrow }` around the journal call.
> 2. AgentWorker.close() must release the worker (or explicitly document it does not).
> 3. Class field declaration order — declare ALL fields at the top of the class body, before the constructor.
> 4. Signal handlers must be opt-in via AbortSignal.
> 5. Test coverage for pollError branch — assert the loop survives a fetcher throw AND the loop TERMINATES on a journal throw.

## Files in scope

- `packages/sdk/src/hn-monitor-runner.ts` (NEW)
- `packages/sdk/src/index.ts` (export HnMonitorRunner)
- `packages/sdk/src/worker.ts` (may modify close() per finding #2)
- `packages/sdk/src/protocol.ts` (if adding workerRelease)
- `packages/sdk/tests/hn-monitor-runner.test.ts` (NEW)

## Definition of done

1. `packages/sdk/src/hn-monitor-runner.ts` exists, exports `HnMonitorRunner` from `packages/sdk/src/index.ts`
2. `packages/sdk/src/worker.ts` — either `close()` calls `workerRelease` (add to protocol.ts if missing), OR a one-line comment names what close() intentionally does NOT do
3. `packages/sdk/src/protocol.ts` — if you added `workerRelease`, matching request/response definitions
4. `packages/sdk/tests/hn-monitor-runner.test.ts` covers ALL of these:
   - fake fetch + mock journal client → runner submits an event on each tick
   - abort signal triggers clean shutdown within one tick (worker released or documented)
   - worker attach happens before first poll
   - fetch throw → loop survives (onPollError called, next tick still runs)
   - journal throw → loop TERMINATES (runner.run() rejects with the error)
5. `cd packages/sdk && npm test` green
6. EVERY new test confirmed to FAIL against current code, with literal failing output pasted
7. As LAST action: `git status --porcelain` and paste it

## Explicit OUT of scope

- CLI wrapper (sub-PR C)
- end-to-end integration test with real relayflowd (sub-PR B)
- ops/STATE.md gate-2 declaration (sub-PR D)
- `.github/workflows/*`, `kernel/*`, `workflows/*.yaml`, `ops/AUTODRIVE_BRIEF.md`

## Current blocker

**BLOCKED on SDK type errors.** The SDK does not compile:

```
cd packages/sdk && npm install
```

Produces **52 TypeScript errors** across multiple files. Sample:

```
src/authored-memory.ts(1,15): error TS2305: Module '"@relayflows/surface"' has no exported member 'MemoryHelper'.
src/authored-worker-step.ts(103,19): error TS2339: Property 'cli' does not exist on type 'AgentOptions'.
src/trigger-executor.ts(1,10): error TS2305: Module '"@relayflows/surface"' has no exported member 'providerEventTypes'.
npm error code 2
npm error path /project/workflows/runs/***/packages/sdk
npm error command failed
npm error command sh -c npm run build
```

Missing exports from `@relayflows/surface` and `@relayflows/surface/runtime`:
- `MemoryHelper`, `LlmOptions`, `TriggerSource`, `WebhookFilter`, `providerEventTypes`, `webhook`
- `helperProviders`, `HelperCall`, `helperClients`, `invokeHelper`

Missing properties on types:
- `cli`, `model` on `AgentOptions`
- `use` on `ReadonlyFlowHeader`
- `mcp` on `Ctx`
- `handlers` on `AuthoredFlowDefinition`

The work package cannot proceed until the SDK compiles. This is a cross-package dependency issue between `@relayflows/sdk` and `@relayflows/surface`.

**This is NOT within gate-3 scope.** ops/TARGET.md constrains changes to `sdk/src/` CODE tasks for the HN monitor runner. Fixing cross-package type exports is a different class of work.

## Assessment

The gate is **BLOCKED**. The blocker is structural (missing exports from a dependency package), not something fixable within the constrained scope. A human needs to:

1. Determine whether the missing exports should exist in `@relayflows/surface`
2. Either restore those exports or update SDK to not depend on them
3. Resolve type incompatibilities

Without a compilable SDK, no new code can be added and no tests can run.
