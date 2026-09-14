# Authored completion verification

Date: 2026-09-14. Base: `a9360ed49fdfe1c04b53cfa89377830b55d91a58`.

Scope: accept authored `canceled` and `step_failed` completions, journal the
terminal outcome and report CLI exit 1. The fixture owns its input type and
inline source/label predicates. The surface package, provider catalogs, kernel,
and gates have no net changes in this PR.

The CLI tests use a real local daemon and a fixture agent. They do not verify
external provider authentication, Cloud launch, or durable authored-root resume.
The terminal marker remains a successful kernel step with the authored outcome
in its output, consistent with the existing human-handoff marker.

## Local surface build

The SDK at this checkout requires the current surface source, as in
`scripts/surface-package-gate.sh`. Its locked registry version predates some
existing SDK APIs. The initial registry-only check below failed; it was replaced
with a local build of the unchanged surface. The old build directory was moved
aside so removed helper output could not remain in the package.

Working directory: `packages/surface`.

```sh
mv dist /tmp/flows-surface-before-pr401-revision && npm run build && npm pack --silent --ignore-scripts --pack-destination /tmp --cache /tmp/flows-npm-cache
```

```text
npm notice run @relayflows/surface@2.0.8 build
npm notice run tsc
relayflows-surface-2.0.8.tgz
```

Exit code: 0. This creates a local test tarball, not a release.

## Build, typechecks and real-daemon tests

Working directory: `packages/sdk`. The daemon at the path below was built from
this checkout during the original PR verification; no kernel files changed.
The test invocation was granted local socket access.

```sh
npm install /tmp/relayflows-surface-2.0.8.tgz --no-save --ignore-scripts --no-audit --no-fund --cache /tmp/flows-npm-cache && npm run typecheck && npm run build && npm run typecheck:tests && RELAYFLOWD_BIN=/tmp/flows-issue-helpers-target/debug/relayflowd npx vitest run tests/authored-completion-live.test.ts tests/authored-flow.test.ts tests/authored-flow-lifecycle-executor.test.ts tests/direct-input.test.ts tests/close-pr-flow.test.ts
```

```text

changed 1 package in 857ms
npm notice run @relayflows/sdk@2.0.8 typecheck
npm notice run tsc --noEmit && tsc -p tsconfig.type-tests.json
npm notice run @relayflows/sdk@2.0.8 build
npm notice run tsc && node scripts/make-cli-executable.mjs
npm notice run @relayflows/sdk@2.0.8 typecheck:tests
npm notice run tsc -p tsconfig.tests.json
npm notice run @relayflows/sdk@2.0.8 npx
npm notice run 'vitest' run tests/authored-completion-live.test.ts tests/authored-flow.test.ts tests/authored-flow-lifecycle-executor.test.ts tests/direct-input.test.ts tests/close-pr-flow.test.ts

 RUN  v2.1.9 /Users/will/Projects/AgentWorkforce/flows/packages/sdk

 ✓ tests/authored-flow-lifecycle-executor.test.ts (27 tests) 542ms
 ✓ tests/authored-flow.test.ts (25 tests) 685ms
 ✓ tests/close-pr-flow.test.ts (28 tests) 2200ms
   ✓ close-pr journaled repair loop > executes the deterministic commit and force-push steps against a local Git remote, including a no-op repair 578ms
   ✓ PR state parsing and shell boundaries > preserves gh output and handles exit status 0 301ms
   ✓ PR state parsing and shell boundaries > preserves gh output and handles exit status 127 522ms
 ✓ tests/authored-completion-live.test.ts (10 tests) 5221ms
   ✓ authored cancellation and rejection through the live journal > reports 'canceled' from a generated-style flow through the built CLI 2121ms
   ✓ authored cancellation and rejection through the live journal > reports 'step_failed' from a generated-style flow through the built CLI 1512ms
   ✓ authored cancellation and rejection through the live journal > reports 'needs_human' from a generated-style flow through the built CLI 1293ms
 ✓ tests/direct-input.test.ts (5 tests) 11450ms
   ✓ direct .flow.ts input through the built CLI and live runtime > returns exit 3 for an authored human handoff and persists its outcome 2937ms
   ✓ direct .flow.ts input through the built CLI and live runtime > executes inline and file JSON input through relayflowd 3073ms
   ✓ direct .flow.ts input through the built CLI and live runtime > refuses missing and malformed input before contacting relayflowd 3381ms
   ✓ direct .flow.ts input through the built CLI and live runtime > does not run the authored body before daemon availability 1337ms
   ✓ direct .flow.ts input through the built CLI and live runtime > refuses oversized file input before contacting relayflowd 718ms

 Test Files  5 passed (5)
      Tests  95 passed (95)
   Start at  13:46:46
   Duration  11.79s (transform 455ms, setup 0ms, collect 2.64s, tests 20.10s, environment 1ms, prepare 281ms)

```

Exit code: 0.

The new cases assert that excluded input invokes no agent, rejection reports
`step_failed`, human handoff remains parked, unawaited steps are refused, and
failure to journal a terminal marker prevents reporting the requested outcome.

A read-only subagent reviewed the revised SDK diff and inline fixture and found
no actionable issues. No merge or release was performed.

## Initial dependency mismatch

This attempt installed the locked registry surface and stopped at typecheck;
no tests ran in this attempt. The complete command and output are retained to
distinguish this failure from the successful source-matched verification above.

Working directory: `packages/sdk`.

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund --cache /tmp/flows-npm-cache && npm run typecheck && npm run build && npm run typecheck:tests && RELAYFLOWD_BIN=/tmp/flows-issue-helpers-target/debug/relayflowd npx vitest run tests/authored-completion-live.test.ts tests/authored-flow.test.ts tests/authored-flow-lifecycle-executor.test.ts tests/direct-input.test.ts tests/close-pr-flow.test.ts
```

```text
npm warn deprecated whatwg-encoding@3.1.1: Use @exodus/bytes instead for a more spec-conformant and faster implementation

added 191 packages in 2s
npm notice run @relayflows/sdk@2.0.8 typecheck
npm notice run tsc --noEmit && tsc -p tsconfig.type-tests.json
src/authored-flow-executor.ts(17,8): error TS2305: Module '"@relayflows/surface"' has no exported member 'LlmOptions'.
src/authored-flow-executor.ts(21,8): error TS2724: '"@relayflows/surface"' has no exported member named 'FlowCompletionReason'. Did you mean 'CompletionReason'?
src/authored-flow-executor.ts(25,10): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'createHelpers'.
src/authored-flow-executor.ts(25,25): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperProviders'.
src/authored-flow-executor.ts(25,47): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'HelperCall'.
src/authored-flow-executor.ts(144,115): error TS7006: Parameter 'p' implicitly has an 'any' type.
src/authored-flow-executor.ts(239,14): error TS7006: Parameter 'channel' implicitly has an 'any' type.
src/authored-flow-executor.ts(239,23): error TS7006: Parameter 'text' implicitly has an 'any' type.
src/authored-flow-executor.ts(239,29): error TS7006: Parameter 'opts' implicitly has an 'any' type.
src/authored-flow-executor.ts(240,12): error TS7006: Parameter 'user' implicitly has an 'any' type.
src/authored-flow-executor.ts(240,18): error TS7006: Parameter 'text' implicitly has an 'any' type.
src/authored-flow-executor.ts(241,15): error TS7006: Parameter 'channel' implicitly has an 'any' type.
src/authored-flow-executor.ts(241,24): error TS7006: Parameter 'threadTs' implicitly has an 'any' type.
src/authored-flow-executor.ts(241,34): error TS7006: Parameter 'text' implicitly has an 'any' type.
src/authored-flow-executor.ts(242,15): error TS7006: Parameter 'channel' implicitly has an 'any' type.
src/authored-flow-executor.ts(242,24): error TS7006: Parameter 'messageTs' implicitly has an 'any' type.
src/authored-flow-executor.ts(242,35): error TS7006: Parameter 'emoji' implicitly has an 'any' type.
src/authored-flow-executor.ts(260,9): error TS7006: Parameter 'command' implicitly has an 'any' type.
src/authored-flow-executor.ts(260,18): error TS7006: Parameter 'runOptions' implicitly has an 'any' type.
src/authored-flow-executor.ts(298,11): error TS2367: This comparison appears to be unintentional because the types '"success" | "step_failed" | "canceled" | "budget_exceeded"' and '"needs_human"' have no overlap.
src/authored-flow-executor.ts(310,35): error TS2367: This comparison appears to be unintentional because the types '"step_failed" | "canceled" | "budget_exceeded"' and '"needs_human"' have no overlap.
src/authored-flow-loader.ts(63,56): error TS2339: Property 'use' does not exist on type 'ReadonlyFlowHeader'.
src/authored-flow-operation.ts(2,15): error TS2305: Module '"@relayflows/surface"' has no exported member 'NamedGate'.
src/authored-helper-effect.ts(12,10): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperProviders'.
src/authored-helper-effect.ts(12,32): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'HelperCall'.
src/authored-helper-effect.ts(20,42): error TS7006: Parameter 'p' implicitly has an 'any' type.
src/authored-helper-effect.ts(64,55): error TS7006: Parameter 'p' implicitly has an 'any' type.
src/authored-mcp.ts(19,8): error TS2339: Property 'mcp' does not exist on type 'Ctx'.
src/authored-memory.ts(1,15): error TS2305: Module '"@relayflows/surface"' has no exported member 'MemoryHelper'.
src/authored-memory.ts(45,14): error TS7006: Parameter 'query' implicitly has an 'any' type.
src/authored-memory.ts(45,21): error TS7006: Parameter 'options' implicitly has an 'any' type.
src/authored-memory.ts(46,10): error TS7006: Parameter 'task' implicitly has an 'any' type.
src/authored-worker-step.ts(3,42): error TS2305: Module '"@relayflows/surface"' has no exported member 'LlmOptions'.
src/authored-worker-step.ts(3,54): error TS2305: Module '"@relayflows/surface"' has no exported member 'NamedGate'.
src/authored-worker-step.ts(103,19): error TS2339: Property 'cli' does not exist on type 'AgentOptions'.
src/authored-worker-step.ts(103,55): error TS2339: Property 'cli' does not exist on type 'AgentOptions'.
src/authored-worker-step.ts(106,80): error TS2339: Property 'cli' does not exist on type 'AgentOptions'.
src/authored-worker-step.ts(109,19): error TS2339: Property 'model' does not exist on type 'AgentOptions'.
src/authored-worker-step.ts(109,57): error TS2339: Property 'model' does not exist on type 'AgentOptions'.
src/authored-worker-step.ts(112,82): error TS2339: Property 'model' does not exist on type 'AgentOptions'.
src/authored-worker-step.ts(115,19): error TS2339: Property 'cwd' does not exist on type 'AgentOptions'.
src/authored-worker-step.ts(115,55): error TS2339: Property 'cwd' does not exist on type 'AgentOptions'.
src/authored-worker-step.ts(118,80): error TS2339: Property 'cwd' does not exist on type 'AgentOptions'.
src/authored-worker-step.ts(121,19): error TS2339: Property 'transport' does not exist on type 'AgentOptions'.
src/authored-worker-step.ts(121,54): error TS2339: Property 'transport' does not exist on type 'AgentOptions'.
src/authored-worker-step.ts(121,88): error TS2339: Property 'transport' does not exist on type 'AgentOptions'.
src/authored-worker-step.ts(124,96): error TS2339: Property 'transport' does not exist on type 'AgentOptions'.
src/authored-worker-step.ts(131,21): error TS2339: Property 'cli' does not exist on type 'AgentOptions'.
src/authored-worker-step.ts(131,61): error TS2339: Property 'cli' does not exist on type 'AgentOptions'.
src/authored-worker-step.ts(132,21): error TS2339: Property 'model' does not exist on type 'AgentOptions'.
src/authored-worker-step.ts(132,65): error TS2339: Property 'model' does not exist on type 'AgentOptions'.
src/authored-worker-step.ts(133,21): error TS2339: Property 'cwd' does not exist on type 'AgentOptions'.
src/authored-worker-step.ts(133,61): error TS2339: Property 'cwd' does not exist on type 'AgentOptions'.
src/authored-worker-step.ts(134,21): error TS2339: Property 'transport' does not exist on type 'AgentOptions'.
src/authored-worker-step.ts(134,73): error TS2339: Property 'transport' does not exist on type 'AgentOptions'.
src/cli/check-triggers.ts(23,19): error TS2339: Property 'handlers' does not exist on type 'AuthoredFlowDefinition<unknown>'.
src/cli/check-triggers.ts(23,39): error TS7006: Parameter 'handler' implicitly has an 'any' type.
src/helper-preflight.ts(1,10): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperProviders'.
src/helper-writeback.ts(5,10): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperClients'.
src/helper-writeback.ts(5,25): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperProviders'.
src/helper-writeback.ts(5,42): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'invokeHelper'.
src/helper-writeback.ts(5,61): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'HelperCall'.
src/helper-writeback.ts(22,41): error TS7006: Parameter 'p' implicitly has an 'any' type.
src/preflight.ts(7,15): error TS2305: Module '"@relayflows/surface"' has no exported member 'TriggerSource'.
src/slack-preflight.ts(3,10): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperProviders'.
src/slack-preflight.ts(18,55): error TS7006: Parameter 'p' implicitly has an 'any' type.
src/slack-writeback.ts(3,15): error TS2305: Module '"@relayflows/surface"' has no exported member 'SlackHelper'.
src/slack-writeback.ts(58,65): error TS18046: 'call.params.text' is of type 'unknown'.
src/slack-writeback.ts(58,94): error TS2345: Argument of type 'unknown' is not assignable to parameter of type '{ replyTo?: string | undefined; } | undefined'.
src/trigger-executor.ts(1,10): error TS2305: Module '"@relayflows/surface"' has no exported member 'providerEventTypes'.
src/trigger-executor.ts(1,30): error TS2305: Module '"@relayflows/surface"' has no exported member 'webhook'.
src/trigger-executor.ts(1,44): error TS2305: Module '"@relayflows/surface"' has no exported member 'TriggerSource'.
src/trigger-executor.ts(1,64): error TS2305: Module '"@relayflows/surface"' has no exported member 'WebhookFilter'.
npm notice
npm notice New patch version of npm available! 12.0.1 -> 12.0.2
npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.0.2
npm notice To update run: npm install -g npm@12.0.2
npm notice
```

Exit code: 2.

