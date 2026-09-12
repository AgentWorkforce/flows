# NEEDS_HUMAN — blocked on SDK type errors

**Question:** Should this run fix the SDK type errors first, or should that be handled separately?

**Context:** ops/TARGET.md scopes this run to building the HN monitor runner (`packages/sdk/src/hn-monitor-runner.ts`). The implementation is ready to be written, but the SDK package does not compile.

Running `cd packages/sdk && npm install` produces **52 TypeScript errors** from missing exports in `@relayflows/surface`:

- Missing: `MemoryHelper`, `LlmOptions`, `TriggerSource`, `WebhookFilter`, `providerEventTypes`, `webhook`, `helperProviders`, `HelperCall`, `helperClients`, `invokeHelper`
- Missing properties: `cli`/`model` on `AgentOptions`, `use` on `ReadonlyFlowHeader`, `mcp` on `Ctx`, `handlers` on `AuthoredFlowDefinition`

## Options

**A. Fix type errors first (expand scope)**
- Restore missing exports to `@relayflows/surface` and `@relayflows/surface/runtime`
- Fix type definitions
- Then implement HN monitor runner
- Pro: Unblocks SDK work
- Con: Exceeds ops/TARGET.md scope ("CODE task, `sdk/src/`-side")

**B. Report blocked and wait**
- File this blocker, make no changes
- Pro: Stays within scope
- Con: No progress on gate 2

**C. Implement runner ignoring type errors**
- Write runner code despite errors
- Skip tests (can't run if SDK doesn't compile)
- Pro: Shows implementation
- Con: Violates definition of done (`npm test` must pass)

## Recommendation

**Option A**. The SDK is part of this repo and errors block ALL SDK work. Gate-2 work cannot proceed without a compilable SDK.
