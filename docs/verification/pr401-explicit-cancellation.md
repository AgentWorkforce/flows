# Explicit cancellation fixture verification

Date: 2026-09-14.

This supersedes the source-filter interpretation in `authored-completion.md`.
An event that does not match a subscription should not create a flow run.
Cancellation is an explicit request to stop work, not a filter mismatch.

The revised CLI fixture tests an explicit `cancellationRequested` input and
asserts that the agent never starts. Separate cases execute work and then test
review failure (`step_failed`) and human handoff (`needs_human`). No provider
inventory, source predicate, or label predicate remains in these fixtures.

This change only updates the PR's added test fixture. The tests use a real local
daemon and a fixture agent, with the already installed locally packed surface.
They do not exercise external authentication, event subscription delivery, Cloud
launch, or durable authored-root resume. The authored terminal reason remains
recorded in the output of a successful kernel marker step.

Working directory: `packages/sdk`. Local socket access was granted for this run.

```sh
npm run build && npm run typecheck:tests && RELAYFLOWD_BIN=/tmp/flows-issue-helpers-target/debug/relayflowd npx vitest run tests/authored-completion-live.test.ts
```

Captured output:

```text
npm notice run @relayflows/sdk@2.0.8 build
npm notice run tsc && node scripts/make-cli-executable.mjs
npm notice
npm notice New patch version of npm available! 12.0.1 -> 12.0.2
npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.0.2
npm notice To update run: npm install -g npm@12.0.2
npm notice
npm notice run @relayflows/sdk@2.0.8 typecheck:tests
npm notice run tsc -p tsconfig.tests.json
npm notice run @relayflows/sdk@2.0.8 npx
npm notice run 'vitest' run tests/authored-completion-live.test.ts

 RUN  v2.1.9 /Users/will/Projects/AgentWorkforce/flows/packages/sdk

 ✓ tests/authored-completion-live.test.ts (10 tests) 5319ms
   ✓ authored cancellation and rejection through the live journal > reports an explicit cancellation through the built CLI without starting an agent 2662ms
   ✓ authored cancellation and rejection through the live journal > reports 'step_failed' after reviewing work through the built CLI 1254ms
   ✓ authored cancellation and rejection through the live journal > reports 'needs_human' after reviewing work through the built CLI 1079ms

 Test Files  1 passed (1)
      Tests  10 passed (10)
   Start at  15:42:59
   Duration  6.11s (transform 251ms, setup 0ms, collect 583ms, tests 5.32s, environment 0ms, prepare 45ms)

```

Exit code: 0.
