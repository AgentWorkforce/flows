# Issue-source helper verification

Base: `a9360ed49fdfe1c04b53cfa89377830b55d91a58` (freshly fetched `origin/main`).
Date: 2026-09-14. Platform: macOS arm64, Node 22.22.2.

This verifies the shared source matcher, SDK completion handling and local CLI
execution against the real daemon with a fixture agent. It does not verify real
provider authentication, a Cloud deployment, automatic event subscriptions, or
full authored-flow crash/resume. No kernel source or acceptance gate changed.

## Setup

Dependencies were installed with `npm ci --ignore-scripts --no-audit --no-fund --cache /tmp/flows-npm-cache`
in each of `packages/surface` and `packages/sdk`. Restricted network attempts
failed with DNS resolution errors; dependency installation succeeded with network
access. The surface was built, packed locally with `npm pack --ignore-scripts
--pack-destination /tmp`, and installed into SDK test dependencies using
`npm install /tmp/relayflows-surface-2.0.8.tgz --no-save --ignore-scripts --no-audit
--no-fund --cache /tmp/flows-npm-cache`. The tarball's existing version is a local
build identifier, not a new published release. Package manifests and locks are
unchanged.

## Kernel build

Working directory: repository root. The initial offline build required missing
locked crates; a build with network access downloaded them. The final offline
build command and its complete output follow.

```sh
cargo build --offline --locked --manifest-path kernel/Cargo.toml --package relayflowd --target-dir /tmp/flows-issue-helpers-target
```

```text
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.28s
```

Exit code: 0.

## Surface package

Working directory: `packages/surface`.

```sh
npm test && npm run typecheck:regressions
```

```text
npm notice run @relayflows/surface@2.0.8 test
npm notice run bun run build && tsc -p tsconfig.test.json && vitest run
$ tsc

 RUN  v2.1.9 /Users/will/Projects/AgentWorkforce/flows/packages/surface

 ✓ tests/issues.test.ts (21 tests) 4ms
 ✓ tests/slack-block-kit.test.ts (5 tests) 3ms
 ✓ tests/provider-triggers.test.ts (3 tests) 3ms
 ✓ tests/triggers.test.ts (4 tests) 4ms
 ✓ tests/flow.test.ts (20 tests) 6ms
 ✓ tests/helpers.snapshot.test.ts (1 test) 221ms

 Test Files  6 passed (6)
      Tests  54 passed (54)
   Start at  13:19:07
   Duration  444ms (transform 209ms, setup 0ms, collect 834ms, tests 241ms, environment 1ms, prepare 274ms)

npm notice run @relayflows/surface@2.0.8 typecheck:regressions
npm notice run tsc -p ../../regressions/tsconfig.json && tsc -p tsconfig.test.json && node scripts/check-generated-helpers.mjs
HELPERS_GENERATED_OK airtable.ts, asana.ts, azure-blob.ts, box.ts, calendly.ts, clickup.ts, clients.ts, cloudflare.ts, confluence.ts, daytona.ts, docker-hub.ts, dropbox.ts, fathom.ts, gcp.ts, gcs.ts, github.ts, gitlab.ts, gmail.ts, google-calendar.ts, google-drive.ts, granola.ts, hubspot.ts, index.ts, intercom.ts, jira.ts, linear.ts, mailgun.ts, mixpanel.ts, neon.ts, notion.ts, onedrive.ts, pipedrive.ts, postgres.ts, posthog.ts, providers.ts, ramp.ts, recall.ts, reddit.ts, redis.ts, s3.ts, salesforce.ts, segment.ts, sendgrid.ts, sharepoint.ts, shopify.ts, shortcut.ts, slack.ts, stripe.ts, teams.ts, telegram.ts, webhook-server.ts, x.ts, zendesk.ts
```

Exit code: 0. The test command includes a fresh build and test-file
typechecking; the regression command also verifies generated helpers were not
changed.

## SDK and real CLI/journal tests

Working directory: `packages/sdk`.

```sh
npm run typecheck
npm run build
npm run typecheck:tests
RELAYFLOWD_BIN=/tmp/flows-issue-helpers-target/debug/relayflowd npx vitest run tests/authored-completion-live.test.ts tests/authored-flow.test.ts tests/authored-flow-lifecycle-executor.test.ts tests/direct-input.test.ts tests/close-pr-flow.test.ts
```

```text
npm notice run @relayflows/sdk@2.0.8 typecheck
npm notice run tsc --noEmit && tsc -p tsconfig.type-tests.json
npm notice run @relayflows/sdk@2.0.8 build
npm notice run tsc && node scripts/make-cli-executable.mjs
npm notice run @relayflows/sdk@2.0.8 typecheck:tests
npm notice run tsc -p tsconfig.tests.json
npm notice run @relayflows/sdk@2.0.8 npx
npm notice run 'vitest' run tests/authored-completion-live.test.ts tests/authored-flow.test.ts tests/authored-flow-lifecycle-executor.test.ts tests/direct-input.test.ts tests/close-pr-flow.test.ts

 RUN  v2.1.9 /Users/will/Projects/AgentWorkforce/flows/packages/sdk

 ✓ tests/authored-flow-lifecycle-executor.test.ts (27 tests) 544ms
 ✓ tests/authored-flow.test.ts (25 tests) 686ms
 ✓ tests/close-pr-flow.test.ts (28 tests) 1331ms
   ✓ close-pr journaled repair loop > executes the deterministic commit and force-push steps against a local Git remote, including a no-op repair 515ms
 ✓ tests/authored-completion-live.test.ts (10 tests) 5808ms
   ✓ authored cancellation and rejection through the live journal > reports 'canceled' from a generated-style flow through the built CLI 2933ms
   ✓ authored cancellation and rejection through the live journal > reports 'step_failed' from a generated-style flow through the built CLI 1363ms
   ✓ authored cancellation and rejection through the live journal > reports 'needs_human' from a generated-style flow through the built CLI 1146ms
 ✓ tests/direct-input.test.ts (5 tests) 10735ms
   ✓ direct .flow.ts input through the built CLI and live runtime > returns exit 3 for an authored human handoff and persists its outcome 3873ms
   ✓ direct .flow.ts input through the built CLI and live runtime > executes inline and file JSON input through relayflowd 2874ms
   ✓ direct .flow.ts input through the built CLI and live runtime > refuses missing and malformed input before contacting relayflowd 2499ms
   ✓ direct .flow.ts input through the built CLI and live runtime > does not run the authored body before daemon availability 731ms
   ✓ direct .flow.ts input through the built CLI and live runtime > refuses oversized file input before contacting relayflowd 756ms

 Test Files  5 passed (5)
      Tests  95 passed (95)
   Start at  13:20:40
   Duration  11.05s (transform 439ms, setup 0ms, collect 2.75s, tests 19.10s, environment 0ms, prepare 245ms)

```

Each command exited 0. Local socket access was enabled for the successful test
invocation. The first restricted invocation failed during socket setup and was
interrupted (exit 130); its captured output is preserved in
[the restricted attempt log](issue-source-helpers-sandbox-attempt.txt).

The new CLI cases import `matchesIssue` from the packed package and assert an
excluded issue invokes no agent, review rejection reports `step_failed`, and
an accepted/reviewed issue reports `needs_human`. They inspect the journaled
terminal output and assert the marker's kernel completion remains `success`.
This is an authored outcome marker, not a new durable root or kernel status.

## Independent review

Two read-only subagents reviewed the source, tests and integration contract and
reported no actionable findings. One also checked the existing human-handoff
marker implementation in git history. Neither review is a merge authorization.

## Release and consumer boundary

Release the CLI/SDK completion changes and `@relayflows/surface` helper together
after human review and merge; no package version was guessed or published here.
Then update the builder's pinned install/runtime versions and generated imports.
Cloud still needs saved-flow launch wiring, normalized input mapping and authorized
integration mounts. A helper import does not by itself make that Cloud path live.

