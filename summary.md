Fix: let flows check report Cloud-bound helper requirements without local mounts

A laptop without Slack mounted can inspect an authored Slack flow: check reports
REQUIRES slack and helper_credential_unresolved, then passes. Local run retains
its credential refusal before daemon attachment. The same rule applies to YAML
helpers, whose requirements are now derived from compiled steps with an authoring
fallback for invalid specs.

The warning is opt-in at the check surface, emitted once after REQUIRES.
Non-.flow.* modules receive a self-contained warning without a requirements line.
Unsupported providers and Notion appendBlock remain refusals even without mounts.
Hosted submission, execution, resume, and pure preflight retain their existing
credential checks. Watch inherits the CLI behavior through its child process.

Implementation follows reviewed-plan.md Parts A and B as separate commits.
The two existing authored Slack assertions were retargeted because their check
behavior changes; their executeAuthoredFlow rejection assertions remain intact.
No quality gates or GitHub workflow files were edited.

Validation and limits:
- 269 regression tests and 3 daemon-free authored tests passed; build and both
  TypeScript checks passed. Commands and literal output follow.
- Warning placement and Notion refusal were mutation-verified: each specific
  source change was reverted, its test failed, the source bytes were restored,
  and the same test passed. Both outputs are below.
- The named-agent and unresolved-use requirements comparison preserved the
  codex requirement. The use fixture is deliberately invalid; it verifies the
  compile-failure fallback, not successful import expansion.
- The exact example passes check and refuses local run with a temporary
  package.json module boundary. The helper script restores the checkout.
  Without that boundary, this checkout's Node import fails before preflight
  (example-check.txt and example-run.txt). An attempted Node module flag was
  unsupported (example-*-module.txt); no loader fix is included.
- Full SDK tests were not run: Cargo and relayflowd are unavailable.
  The initial broader command failed direct-input.test.ts setup for the absent
  binary; its literal output is in evidence/helper-check/regression.txt, alongside
  an initial YAML test argument error corrected before the final run.
  The authored subset skips ten daemon-dependent cases: Slack structured posts,
  journaled effect, confirm/complete SIGKILL replay, and multi-call writeback;
  generic helper acceptance, all-provider resume, confirm/complete SIGKILL replay,
  and provider-failure journaling. Those crash gates remain unverified here.

Captured evidence (paths relative to the repository):

evidence/helper-check/build.txt

```text
$ npm --prefix packages/sdk run build

> @relayflows/sdk@2.0.42 build
> tsc && node scripts/make-cli-executable.mjs


```

evidence/helper-check/typecheck.txt

```text
$ npm --prefix packages/sdk run typecheck

> @relayflows/sdk@2.0.42 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json


```

evidence/helper-check/typecheck-tests.txt

```text
$ npm --prefix packages/sdk run typecheck:tests

> @relayflows/sdk@2.0.42 typecheck:tests
> tsc -p tsconfig.tests.json


```

evidence/helper-check/regression-final.txt

```text
$ cd packages/sdk && npx vitest run tests/check-helper-surface.test.ts tests/check-worker-surface.test.ts tests/preflight.test.ts tests/helpers-fanout.test.ts tests/helper-reference.test.ts tests/flow-requirements.test.ts tests/flow-extension-compose.test.ts

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ✓ tests/helper-reference.test.ts (30 tests) 22ms
 ✓ tests/preflight.test.ts (70 tests) 100ms
 ✓ tests/check-worker-surface.test.ts (11 tests) 88ms
 ✓ tests/flow-requirements.test.ts (14 tests) 1030ms
   ✓ flows check prints REQUIRES > names the helper, the harness and the mcp server of an authored flow 786ms
 ✓ tests/helpers-fanout.test.ts (96 tests) 156ms
 ✓ tests/check-helper-surface.test.ts (15 tests) 4150ms
   ✓ reports the declared integration once after REQUIRES and before CHECK PASSED 479ms
   ✓ keeps default and explicit opt-out checks strict, and local run refuses before attach 339ms
   ✓ preserves requirements when compilation refuses and for named agents 2248ms
 ✓ tests/flow-extension-compose.test.ts (33 tests) 5886ms
   ✓ composing flow extensions onto a base flow > composes two extensions in declaration order, and the order is the lockfile order 445ms
   ✓ composing flow extensions onto a base flow > flows check reports the composition and keeps the composed triggers deliverable 973ms
   ✓ composing flow extensions onto a base flow > flows check probes extension preflight before reporting the project healthy 305ms
   ✓ composing flow extensions onto a base flow > uses extension permissions for hosted deploy preflight and the deploy body 322ms

 Test Files  7 passed (7)
      Tests  269 passed (269)
   Start at  13:40:37
   Duration  7.93s (transform 1.99s, setup 57ms, collect 6.67s, tests 11.43s, environment 1ms, prepare 287ms)


```

evidence/helper-check/authored-subset.txt

```text
$ cd packages/sdk && npx vitest run tests/authored-flow-slack.test.ts tests/authored-helpers.test.ts -t 'refuses missing credentials|on `.flow.ts` paths too|rejects malformed arguments'

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ✓ tests/authored-helpers.test.ts (6 tests | 5 skipped) 28ms
 ✓ tests/authored-flow-slack.test.ts (7 tests | 5 skipped) 727ms
   ✓ authored Slack helper effects > refuses missing credentials before running the body while flows check warns 511ms

 Test Files  2 passed (2)
      Tests  3 passed | 10 skipped (13)
   Start at  13:40:46
   Duration  2.58s (transform 1.11s, setup 27ms, collect 2.85s, tests 755ms, environment 0ms, prepare 112ms)


```

evidence/helper-check/requirements.txt

```text
$ node evidence/helper-check/requirements.mjs
named-agent before: REQUIRES codex (step "review")
named-agent after: REQUIRES codex (step "review")
named-agent refusals: model_unavailable
use before: REQUIRES codex (step "review")
use after: REQUIRES codex (step "review")
use refusals: invalid_spec

```

evidence/helper-check/example-module-boundary.txt

```text
$ python3 evidence/helper-check/example.py
$ env -u SLACK_BOT_TOKEN -u RELAYFLOWS_SLACK_MOCK -u RELAYFILE_MOUNT_PATH -u WORKSPACE_ROOT -u WORKFORCE_SANDBOX_ROOT -u RELAYFILE_MOUNT_ROOT -u RELAYFILE_ROOT node packages/sdk/dist/cli.js check examples/stale-issues/stale-issues.flow.ts
REQUIRES slack (tools.slack), claude (llm step)
WARNING [helper_credential_unresolved] f.slack needs a slack mount, which is not available locally. flows schedule / flows deploy / flows run --cloud check the integration against your workspace at submit and refuse if Cloud cannot connect it. A local flows run needs a relayfile slack mount (a slack/ directory under RELAYFILE_MOUNT_PATH) or RELAYFLOWS_SLACK_MOCK=1, and refuses with [helper_slack.credential_missing] without one.
CHECK PASSED examples/stale-issues/stale-issues.flow.ts
exit=0
$ env -u SLACK_BOT_TOKEN -u RELAYFLOWS_SLACK_MOCK -u RELAYFILE_MOUNT_PATH -u WORKSPACE_ROOT -u WORKFORCE_SANDBOX_ROOT -u RELAYFILE_MOUNT_ROOT -u RELAYFILE_ROOT node packages/sdk/dist/cli.js run examples/stale-issues/stale-issues.flow.ts --input '{"repo":"acme/api","channel":"#eng"}'
REFUSED [helper_slack.credential_missing] f.slack requires a relayfile slack mount; direct-token transport is not implemented.
exit=2

```

evidence/helper-check/mutation-placement-fail.txt

```text
$ npx vitest run tests/check-helper-surface.test.ts -t reports the declared integration once

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ❯ tests/check-helper-surface.test.ts (11 tests | 1 failed | 10 skipped) 542ms
   × reports the declared integration once after REQUIRES and before CHECK PASSED 541ms
     → expected 0 to be greater than 1

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/check-helper-surface.test.ts > reports the declared integration once after REQUIRES and before CHECK PASSED
AssertionError: expected 0 to be greater than 1
 ❯ tests/check-helper-surface.test.ts:57:19
     55|   const passed = result.lines.findIndex(line => line.includes('CHECK P…
     56|   expect(requires).toBeGreaterThanOrEqual(0);
     57|   expect(warning).toBeGreaterThan(requires);
       |                   ^
     58|   expect(passed).toBeGreaterThan(warning);
     59|   expect(result.stderr.filter(line => line.includes('[helper_credentia…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 10 skipped (11)
   Start at  13:39:05
   Duration  2.45s (transform 1.09s, setup 16ms, collect 1.70s, tests 542ms, environment 0ms, prepare 42ms)


exit=1

```

evidence/helper-check/mutation-placement-pass.txt

```text
$ npx vitest run tests/check-helper-surface.test.ts -t reports the declared integration once

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ✓ tests/check-helper-surface.test.ts (11 tests | 10 skipped) 577ms
   ✓ reports the declared integration once after REQUIRES and before CHECK PASSED 576ms

 Test Files  1 passed (1)
      Tests  1 passed | 10 skipped (11)
   Start at  13:39:08
   Duration  2.58s (transform 1.19s, setup 17ms, collect 1.80s, tests 577ms, environment 0ms, prepare 53ms)


exit=0

```

evidence/helper-check/mutation-notion-fail.txt

```text
$ npx vitest run tests/check-helper-surface.test.ts -t still refuses unsupported notion

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ❯ tests/check-helper-surface.test.ts (11 tests | 1 failed | 10 skipped) 590ms
   × still refuses unsupported notion appendBlock without a mount 588ms
     → expected +0 to be 2 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/check-helper-surface.test.ts > still refuses unsupported notion appendBlock without a mount
AssertionError: expected +0 to be 2 // Object.is equality

- Expected
+ Received

- 2
+ 0

 ❯ tests/check-helper-surface.test.ts:80:23
     78| ])('still refuses unsupported %s without a mount', async (_name, body)…
     79|   const result = await check(fixture(body));
     80|   expect(result.exit).toBe(2);
       |                       ^
     81|   expect(result.stderr.join('\n')).toContain('[helper_provider.unsuppo…
     82| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 10 skipped (11)
   Start at  13:39:11
   Duration  2.56s (transform 1.12s, setup 18ms, collect 1.72s, tests 590ms, environment 0ms, prepare 84ms)


exit=1

```

evidence/helper-check/mutation-notion-pass.txt

```text
$ npx vitest run tests/check-helper-surface.test.ts -t still refuses unsupported notion

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ✓ tests/check-helper-surface.test.ts (11 tests | 10 skipped) 90ms

 Test Files  1 passed (1)
      Tests  1 passed | 10 skipped (11)
   Start at  13:39:14
   Duration  2.16s (transform 1.23s, setup 20ms, collect 1.87s, tests 90ms, environment 0ms, prepare 50ms)


exit=0

```
