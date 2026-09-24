# Bind draft review verdicts to the commit they judged

Draft PRs from the canonical Software Factory flow now name their reviewed
40-hex head, include a single machine-readable review marker, and explain that
a new head supersedes the verdict. Missing verification prerequisites use
NOT VERIFIED, name the prerequisite, and end with needs_human (exit 3) after
opening a draft. Defects, absent or contradictory verdicts, and empty unverified
markers remain BLOCKED / step_failed (exit 1). Completion details identify the
head and publication state. Hook-blocked drafts use the same scope contract.

Publication rejects malformed heads and duplicate/forged scope markers before
push, including GitHub inputs. Passed PR body formatting is preserved.
Regression coverage exercises these cases using the real /bin/sh body-generation
and validation commands; the harness now throws for unhandled commands.

The flow header is bumped to 2.0.23. The native babysitter identity expectation
was updated from 2.0.22 to match that header, as required by reviewed-plan.md;
the handoff document explains the outstanding source authorization below.
No workflow files were changed.

## Outstanding integration blocker — not ready for hosted use

The plan missed the exact source digest and assigned 2.0.22 identity in
packages/sdk/src/hosted-extension-runtime.ts. The native babysitter suite rejects
the changed flow at this security boundary before running its tests. This is
a consequence of this change, not an environment failure or a baseline defect.
The digest and assigned version are untouched: authorizing our own changed
source as independently reviewed would contradict AGENTS.md's
“Never edit a gate that judges your own work.” Independent review must authorize
the new source digest and assigned version, then rerun the babysitter suite.
Verification is therefore incomplete; this PR is not merge-ready.

## Scope and limitations

This implements reviewed-plan.md's record-the-head portion and three-verdict
protocol in the tracked canonical flow. It does not amend stale PR comments,
clear drafts, rerun reviews on push, or backfill the seven PRs. The future
resident shepherd (examples/babysitter, not yet ready for unattended deployment)
can consume the new marker. The running Garden flow is not tracked here:
the equivalent change must be transplanted into its reviewBlockedCommand and
review.clean check. This does not claim the running Garden is fixed.

Bun here is 1.3.6, whereas CI pins 1.4.0. The surface package gate and full SDK
suite were not run. Existing local dependencies were sufficient for the commands
below; no installation or kernel rebuild is claimed.

## Captured verification

Before implementation, with only the harness made strict:

```console
$ cd packages/sdk && ./node_modules/.bin/vitest run tests/canonical-software-factory.test.ts

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

Stopped: invalid pull-request metadata (duplicate-github-closing-reference). No branch was pushed and no pull request was opened.
 ✓ tests/canonical-software-factory.test.ts (3 tests) 164ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Start at  05:42:22
   Duration  865ms (transform 311ms, setup 0ms, collect 524ms, tests 164ms, environment 0ms, prepare 43ms)

exit=0
```

Final selected suites:

```console
$ cd packages/sdk && ./node_modules/.bin/vitest run tests/canonical-software-factory.test.ts tests/flow-requirements.test.ts tests/babysitter-native-extension.test.ts

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

Stopped: invalid pull-request metadata (duplicate-github-closing-reference). No branch was pushed and no pull request was opened.
Stopped: invalid pull-request metadata (malformed-review-scope). No branch was pushed and no pull request was opened.
Stopped: invalid pull-request metadata (malformed-review-scope). No branch was pushed and no pull request was opened.
Stopped: could not read the reviewed head commit. Nothing was pushed.
Stopped: could not read the reviewed head commit. Nothing was pushed.
Stopped: could not read the reviewed head commit. Nothing was pushed.
 ✓ tests/canonical-software-factory.test.ts (18 tests) 787ms
 ❯ tests/babysitter-native-extension.test.ts (41 tests | 41 skipped) 279ms
 ✓ tests/flow-requirements.test.ts (14 tests) 727ms
   ✓ flows check prints REQUIRES > names the helper, the harness and the mcp server of an authored flow 388ms

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/babysitter-native-extension.test.ts [ tests/babysitter-native-extension.test.ts ]
Error: Hosted capability isolation accepts only the reviewed Software Factory base source.
 ❯ baseAt src/hosted-extension-runtime.ts:239:13
    237|   try {
    238|     if (snapshot.snapshotFlowSha256 !== SOFTWARE_FACTORY_SHA256) {
    239|       throw new PluginError(
       |             ^
    240|         'plugin_source_invalid',
    241|         'Hosted capability isolation accepts only the reviewed Softwar…
 ❯ Module.loadHostedExtensionRuntime src/hosted-extension-runtime.ts:90:16
 ❯ composed tests/babysitter-native-extension.test.ts:64:25
 ❯ tests/babysitter-native-extension.test.ts:100:37

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed | 2 passed (3)
      Tests  32 passed | 41 skipped (73)
   Start at  05:45:22
   Duration  2.80s (transform 1.88s, setup 0ms, collect 4.07s, tests 1.79s, environment 0ms, prepare 128ms)

exit=1
```

Test TypeScript compilation:

```console
$ cd packages/sdk && ./node_modules/.bin/tsc -p tsconfig.tests.json
exit=0
```

Examples typecheck produced the same errors before and after implementation
in an untouched file (neither run passes):

```console
$ cd packages/surface && ./node_modules/.bin/tsc -p ../../examples/tsconfig.json
../../workflows/stuck-run-triage.flow.ts(77,12): error TS2304: Cannot find name 'URL'.
../../workflows/stuck-run-triage.flow.ts(79,15): error TS2552: Cannot find name 'URL'. Did you mean 'url'?
exit=2
```

## Mutation checks

Each mutation temporarily changed the production flow, ran the named regression,
and restored the original bytes using a saved byte buffer with equality asserted.
The final command reran the affected tests on the restored source.

1. Moved the standalone scope guard into an elif after the GitHub branch.
   The GitHub forged-marker regression fails.
2. Changed the classifier's final else from BLOCKED to PASSED. The empty
   unverified regression fails. Correction to the reviewed plan: no-verdict
   takes the count != 1 arm, so that test still passes under this mutation.
3. Changed the count != 1 arm from BLOCKED to PASSED. The no-verdict regression
   then fails. This additionally verifies the default the plan intended to test.

```console
$ cd packages/sdk && ./node_modules/.bin/vitest run tests/canonical-software-factory.test.ts -t 'rejects a forged scope for github'

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ❯ tests/canonical-software-factory.test.ts (18 tests | 1 failed | 17 skipped) 79ms
   × canonical software-factory review scope > rejects a forged scope for github before publication 77ms
     → expected 'step_failed' to be 'needs_human' // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/canonical-software-factory.test.ts > canonical software-factory review scope > rejects a forged scope for github before publication
AssertionError: expected 'step_failed' to be 'needs_human' // Object.is equality

Expected: "needs_human"
Received: "step_failed"

 ❯ tests/canonical-software-factory.test.ts:177:37
    175|     const forged = `<!-- relayflow-review verdict=blocked reviewed-hea…
    176|     const result = await runCanonical({ ...issue, source, identifier: …
    177|     expect(result.completionReason).toBe('needs_human');
       |                                     ^
    178|     expect(result.detail).toContain('malformed-review-scope');
    179|     expect(result.commands.some(command => command.startsWith('git pus…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 17 skipped (18)
   Start at  05:46:08
   Duration  679ms (transform 259ms, setup 0ms, collect 430ms, tests 79ms, environment 0ms, prepare 42ms)

exit=1
```

```console
$ cd packages/sdk && ./node_modules/.bin/vitest run tests/canonical-software-factory.test.ts -t 'fails closed for (no verdict|empty unverified)'

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ❯ tests/canonical-software-factory.test.ts (18 tests | 1 failed | 16 skipped) 88ms
   × canonical software-factory review scope > fails closed for empty unverified 37ms
     → expected 'success' to be 'step_failed' // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/canonical-software-factory.test.ts > canonical software-factory review scope > fails closed for empty unverified
AssertionError: expected 'success' to be 'step_failed' // Object.is equality

Expected: "step_failed"
Received: "success"

 ❯ tests/canonical-software-factory.test.ts:148:37
    146|   ] as [string, Record<string, string>][])('fails closed for %s', asyn…
    147|     const result = await runCanonical(issue, summary, { verdicts });
    148|     expect(result.completionReason).toBe('step_failed');
       |                                     ^
    149|     expect(result.detail).toContain(head);
    150|     expect(result.ghArgs).toContain('--draft');

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed | 16 skipped (18)
   Start at  05:46:09
   Duration  616ms (transform 212ms, setup 0ms, collect 361ms, tests 88ms, environment 0ms, prepare 44ms)

exit=1
```

```console
$ cd packages/sdk && ./node_modules/.bin/vitest run tests/canonical-software-factory.test.ts -t 'fails closed for no verdict'

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ❯ tests/canonical-software-factory.test.ts (18 tests | 1 failed | 17 skipped) 66ms
   × canonical software-factory review scope > fails closed for no verdict 65ms
     → expected 'success' to be 'step_failed' // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/canonical-software-factory.test.ts > canonical software-factory review scope > fails closed for no verdict
AssertionError: expected 'success' to be 'step_failed' // Object.is equality

Expected: "step_failed"
Received: "success"

 ❯ tests/canonical-software-factory.test.ts:148:37
    146|   ] as [string, Record<string, string>][])('fails closed for %s', asyn…
    147|     const result = await runCanonical(issue, summary, { verdicts });
    148|     expect(result.completionReason).toBe('step_failed');
       |                                     ^
    149|     expect(result.detail).toContain(head);
    150|     expect(result.ghArgs).toContain('--draft');

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 17 skipped (18)
   Start at  05:46:10
   Duration  630ms (transform 220ms, setup 0ms, collect 394ms, tests 66ms, environment 0ms, prepare 43ms)

exit=1
```

```console
$ cd packages/sdk && ./node_modules/.bin/vitest run tests/canonical-software-factory.test.ts -t 'rejects a forged scope for github|fails closed for (no verdict|empty unverified)'

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

Stopped: invalid pull-request metadata (malformed-review-scope). No branch was pushed and no pull request was opened.
 ✓ tests/canonical-software-factory.test.ts (18 tests | 15 skipped) 142ms

 Test Files  1 passed (1)
      Tests  3 passed | 15 skipped (18)
   Start at  05:46:11
   Duration  693ms (transform 217ms, setup 0ms, collect 378ms, tests 142ms, environment 0ms, prepare 44ms)

exit=0
```
