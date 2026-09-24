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

The flow header is bumped to 2.0.23, and the hosted loader's reviewed-base pins
move with it (next section). No workflow files were changed.

## The reviewed-base pins move with the flow

`packages/sdk/src/hosted-extension-runtime.ts` pins the exact Software Factory
flow bytes the hosted capability sandbox will accept, plus the identity it
assigns to that base. Both are functions of
`examples/software-factory/software-factory.flow.ts`:

```console
$ git show HEAD~1:examples/software-factory/software-factory.flow.ts | sha256sum
49c993220b9c34fab2d4b0e51911656f62b8b657f534d988691960d45bb9d9b6  -

$ sha256sum examples/software-factory/software-factory.flow.ts
ee56899fcb5c0a968d845620db3d4229673a3b732dd4d6131ab43b81822bf97b  examples/software-factory/software-factory.flow.ts
```

Changing the flow and leaving the pins behind makes the loader reject the base it
ships with, which is exactly what it should do — and it took the whole
`babysitter-native-extension` suite down with it. `SOFTWARE_FACTORY_SHA256` and
the assigned version are therefore updated to the new bytes and the new `2.0.23`
header, and `docs/BABYSITTER-CATALOG-HANDOFF.md` now states that the two move
together. The check itself is unchanged: any source other than the reviewed one
is still refused, as the untouched rejection regressions in
`tests/hosted-base-snapshot.test.ts` still prove.

## Scope and limitations

This implements reviewed-plan.md's record-the-head portion and three-verdict
protocol in the tracked canonical flow. It does not amend stale PR comments,
clear drafts, rerun reviews on push, or backfill the seven PRs. The future
resident shepherd (examples/babysitter, not yet ready for unattended deployment)
can consume the new marker. The running Garden flow is not tracked here:
the equivalent change must be transplanted into its reviewBlockedCommand and
review.clean check. This does not claim the running Garden is fixed.

22 tests in three files still fail on this machine, all of them the bubblewrap
sandbox failing to start, which no code change here can clear; the numbers and
the evidence are below and in `.relayflow/repair-notes.md`. One `live-kernel`
case that drives the real Claude analyzer is skipped
(`RELAYFLOWS_ALLOW_ANALYZER_SKIP=1`, as CI sets it), so **this is not gate-2
acceptance evidence.**

## Captured verification — repair pass

The whole repository check, `.relayflow/check.sh`, which mirrors the four
PR-triggered workflows (`cloud-runtime-artifact.yml`, `surface-package.yml`,
`schema-publish.yml`'s validate job, and the offline half of
`review-swarm-wrapper-guard.yml`):

```console
$ sh .relayflow/check.sh
node: v25.6.0
npm:  11.8.0
bun:  1.4.0   (CI pins 1.4.0)
cargo: cargo 1.98.1 (797e8a9bc 2026-08-05)
...
 Test Files  3 failed | 192 passed | 1 skipped (196)
      Tests  22 failed | 3194 passed | 4 skipped (3220)
...
FAILED: the SDK suite above exited nonzero (sections 2-4 still ran; see their output)
```

Kernel workspace: 27 `test result: ok` lines, 278 tests, 0 failed. Surface
package gate: 52 source tests, `PACKED_RUNTIME_REFUSAL_OK`,
`PACKED_TYPESCRIPT_OK`, 34 packed-consumer tests. Schema: regenerated twice,
`git diff --exit-code` clean, 79 schema tests pass. Review-gate parity:
`lens-parity-check: PASS`, `lens-cli-parity-check: PASS`, `21 passed, 0 failed`.

Every one of the 22 failures is the bubblewrap sandbox — the machine cannot
create unprivileged user namespaces
(`kernel.apparmor_restrict_unprivileged_userns=1`, `/proc/sys` is a sysbox FUSE
mount that `sudo sysctl -w` cannot write, and Debian's bubblewrap has no setuid
support). Full diagnosis, including the probes that rule out every workaround,
is in `.relayflow/repair-notes.md`.

The two suites this change actually touches:

```console
$ cd packages/sdk && ./node_modules/.bin/vitest run tests/canonical-software-factory.test.ts
Stopped: invalid pull-request metadata (duplicate-github-closing-reference). No branch was pushed and no pull request was opened.
Stopped: invalid pull-request metadata (malformed-review-scope). No branch was pushed and no pull request was opened.
Stopped: invalid pull-request metadata (malformed-review-scope). No branch was pushed and no pull request was opened.
Stopped: could not read the reviewed head commit. Nothing was pushed.
Stopped: could not read the reviewed head commit. Nothing was pushed.
Stopped: could not read the reviewed head commit. Nothing was pushed.
 ✓ tests/canonical-software-factory.test.ts (18 tests) 693ms

 Test Files  1 passed (1)
      Tests  18 passed (18)
```

```console
$ cd packages/sdk && ./node_modules/.bin/vitest run tests/babysitter-native-extension.test.ts
 Test Files  1 failed (1)
      Tests  1 failed | 40 passed (41)
```

The one remaining failure there is
`runs the exact published 2.0.26 native bytes in the isolated capability path`,
the bubblewrap case. Before the pin update the same file could not load at all:
`Tests  41 skipped (41)`, `Error: Hosted capability isolation accepts only the
reviewed Software Factory base source.`

### Mutation checks — the reviewed-base pins

Each mutation changed one pin, ran the suite, then restored the file from a saved
byte copy with `cmp` asserting byte equality, and re-ran.

```console
$ sed -i "s/ee56899fcb5c0a968d845620db3d4229673a3b732dd4d6131ab43b81822bf97b/49c993220b9c34fab2d4b0e51911656f62b8b657f534d988691960d45bb9d9b6/" src/hosted-extension-runtime.ts
$ ./node_modules/.bin/vitest run tests/babysitter-native-extension.test.ts
 FAIL  tests/babysitter-native-extension.test.ts [ tests/babysitter-native-extension.test.ts ]
Error: Hosted capability isolation accepts only the reviewed Software Factory base source.
 ❯ baseAt src/hosted-extension-runtime.ts:239:13
 Test Files  1 failed (1)
      Tests  41 skipped (41)

$ cp /tmp/hosted-extension-runtime.ts.fixed src/hosted-extension-runtime.ts && cmp /tmp/hosted-extension-runtime.ts.fixed src/hosted-extension-runtime.ts && echo "restored byte-for-byte"
restored byte-for-byte
$ ./node_modules/.bin/vitest run tests/babysitter-native-extension.test.ts
 Test Files  1 failed (1)
      Tests  1 failed | 40 passed (41)
```

```console
$ sed -i "246s/'2.0.23'/'2.0.22'/" src/hosted-extension-runtime.ts   # revert the assigned version
$ ./node_modules/.bin/vitest run tests/babysitter-native-extension.test.ts -t 'composes onto Software Factory'
    "name": "software-factory",
-   "version": "2.0.23",
+   "version": "2.0.22",
  }
 ❯ tests/babysitter-native-extension.test.ts:112:32
 Test Files  1 failed (1)
      Tests  1 failed | 40 skipped (41)

$ cp /tmp/hosted-extension-runtime.ts.fixed src/hosted-extension-runtime.ts && cmp /tmp/hosted-extension-runtime.ts.fixed src/hosted-extension-runtime.ts && echo "restored byte-for-byte"
restored byte-for-byte
$ ./node_modules/.bin/vitest run tests/babysitter-native-extension.test.ts -t 'composes onto Software Factory'
 ✓ tests/babysitter-native-extension.test.ts (41 tests | 40 skipped) 259ms
 Test Files  1 passed (1)
      Tests  1 passed | 40 skipped (41)
```

## Captured verification — implementation pass

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

### Mutation checks — scope placement, verdict classification, head validation

Re-run at this branch's head against the committed flow. Each mutation edits
`examples/software-factory/software-factory.flow.ts`, runs the named regression,
restores the file from a copy saved before the first mutation
(`cp examples/software-factory/software-factory.flow.ts /tmp/flow.fixed`), proves
the restore with `cmp`, and re-runs the same regression. Failure and pass are
both captured below; `…/vitest` is `packages/sdk/node_modules/.bin/vitest`, run
from `packages/sdk`. Output is filtered to the result lines
(`grep -E "✓|×|Tests  |Test Files |AssertionError|Expected:|Received:"`).

**M1 — the scope guard must not sit behind the GitHub branch.** The standalone
guard becomes an `elif` after the arm that already answers `valid` for GitHub
sources, so a GitHub PR body would never be scope-checked:

```console
$ git diff -U0 -- examples/software-factory/software-factory.flow.ts
@@ -38 +37,0 @@ const VALIDATE_CHANGE_METADATA = [
-  `if [ -n "$scope" ]; then scope_count=$(grep -cE '^<!-- relayflow-review ' ${WORK}/pr-body.md || true); if [ "$scope_count" -ne 1 ]; then echo malformed-review-scope; exit 0; fi; fi`,
@@ -45,0 +45 @@ const VALIDATE_CHANGE_METADATA = [
+  `elif [ -n "$scope" ] && [ "$(grep -cE '^<!-- relayflow-review ' ${WORK}/pr-body.md || true)" -ne 1 ]; then echo malformed-review-scope`,

$ …/vitest run tests/canonical-software-factory.test.ts -t 'rejects a forged scope for'
   × canonical software-factory review scope > rejects a forged scope for github before publication 57ms
AssertionError: expected 'step_failed' to be 'needs_human' // Object.is equality
Expected: "needs_human"
Received: "step_failed"
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed | 16 skipped (18)

$ cp /tmp/flow.fixed examples/software-factory/software-factory.flow.ts && cmp /tmp/flow.fixed examples/software-factory/software-factory.flow.ts && echo restored-byte-for-byte
restored-byte-for-byte

$ …/vitest run tests/canonical-software-factory.test.ts -t 'rejects a forged scope for'
 ✓ tests/canonical-software-factory.test.ts (18 tests | 16 skipped) 81ms
 Test Files  1 passed (1)
      Tests  2 passed | 16 skipped (18)
```

The `local` case passes under this mutation and the `github` case does not,
which is the point: the guard's placement, not its existence, is what makes it
reach a GitHub body.

**M2 — the classifier's final `else` must stay BLOCKED.** `else echo BLOCKED`
becomes `else echo PASSED`, which is the arm an empty `review.unverified` falls
through to:

```console
$ git diff -U0 -- examples/software-factory/software-factory.flow.ts
@@ -161 +161 @@ export default flow<Input>("software-factory", {
-  const verdict = await f.run(`count=0; for v in blocked unverified passed; do [ -f ${WORK}/review.$v ] && count=$((count+1)); done; if [ "$count" -ne 1 ]; then echo BLOCKED; elif [ -f ${WORK}/review.blocked ]; then echo BLOCKED; elif [ -s ${WORK}/review.unverified ]; then echo UNVERIFIED; elif [ -f ${WORK}/review.passed ]; then echo PASSED; else echo BLOCKED; fi`);
+  const verdict = await f.run(`count=0; for v in blocked unverified passed; do [ -f ${WORK}/review.$v ] && count=$((count+1)); done; if [ "$count" -ne 1 ]; then echo BLOCKED; elif [ -f ${WORK}/review.blocked ]; then echo BLOCKED; elif [ -s ${WORK}/review.unverified ]; then echo UNVERIFIED; elif [ -f ${WORK}/review.passed ]; then echo PASSED; else echo PASSED; fi`);

$ …/vitest run tests/canonical-software-factory.test.ts -t 'fails closed for empty unverified'
   × canonical software-factory review scope > fails closed for empty unverified 137ms
AssertionError: expected 'success' to be 'step_failed' // Object.is equality
Expected: "step_failed"
Received: "success"
 Test Files  1 failed (1)
      Tests  1 failed | 17 skipped (18)

$ cp /tmp/flow.fixed examples/software-factory/software-factory.flow.ts && cmp /tmp/flow.fixed examples/software-factory/software-factory.flow.ts && echo restored-byte-for-byte
restored-byte-for-byte

$ …/vitest run tests/canonical-software-factory.test.ts -t 'fails closed for empty unverified'
 ✓ tests/canonical-software-factory.test.ts (18 tests | 17 skipped) 48ms
 Test Files  1 passed (1)
      Tests  1 passed | 17 skipped (18)
```

**M3 — "not exactly one verdict" must stay BLOCKED.** The `count != 1` arm
becomes `PASSED`; that is the arm a silent adversary (no verdict file at all)
takes:

```console
$ git diff -U0 -- examples/software-factory/software-factory.flow.ts
@@ -161 +161 @@ export default flow<Input>("software-factory", {
-  const verdict = await f.run(`count=0; for v in blocked unverified passed; do [ -f ${WORK}/review.$v ] && count=$((count+1)); done; if [ "$count" -ne 1 ]; then echo BLOCKED; elif [ -f ${WORK}/review.blocked ]; then echo BLOCKED; elif [ -s ${WORK}/review.unverified ]; then echo UNVERIFIED; elif [ -f ${WORK}/review.passed ]; then echo PASSED; else echo BLOCKED; fi`);
+  const verdict = await f.run(`count=0; for v in blocked unverified passed; do [ -f ${WORK}/review.$v ] && count=$((count+1)); done; if [ "$count" -ne 1 ]; then echo PASSED; elif [ -f ${WORK}/review.blocked ]; then echo BLOCKED; elif [ -s ${WORK}/review.unverified ]; then echo UNVERIFIED; elif [ -f ${WORK}/review.passed ]; then echo PASSED; else echo BLOCKED; fi`);

$ …/vitest run tests/canonical-software-factory.test.ts -t 'fails closed for no verdict'
   × canonical software-factory review scope > fails closed for no verdict 48ms
AssertionError: expected 'success' to be 'step_failed' // Object.is equality
Expected: "step_failed"
Received: "success"
 Test Files  1 failed (1)
      Tests  1 failed | 17 skipped (18)

$ cp /tmp/flow.fixed examples/software-factory/software-factory.flow.ts && cmp /tmp/flow.fixed examples/software-factory/software-factory.flow.ts && echo restored-byte-for-byte
restored-byte-for-byte

$ …/vitest run tests/canonical-software-factory.test.ts -t 'fails closed for no verdict'
 ✓ tests/canonical-software-factory.test.ts (18 tests | 17 skipped) 46ms
 Test Files  1 passed (1)
      Tests  1 passed | 17 skipped (18)
```

**M4 — the reviewed head must be validated before it reaches a command.** The
40-hex test is widened to match anything:

```console
$ git diff -U0 -- examples/software-factory/software-factory.flow.ts
@@ -97 +97 @@ export default flow<Input>("software-factory", {
-    if (!/^[0-9a-f]{40}$/.test(reviewedHead)) {
+    if (!/^.*$/.test(reviewedHead)) {

$ …/vitest run tests/canonical-software-factory.test.ts -t 'rejects malformed head'
   × canonical software-factory review scope > rejects malformed head "" before publication 52ms
   × canonical software-factory review scope > rejects malformed head "not-a-sha" before publication 38ms
   × canonical software-factory review scope > rejects malformed head "a'; touch injected; #" before publication 42ms
AssertionError: expected 'step_failed' to be 'needs_human' // Object.is equality
Expected: "needs_human"
Received: "step_failed"
 Test Files  1 failed (1)
      Tests  3 failed | 15 skipped (18)

$ cp /tmp/flow.fixed examples/software-factory/software-factory.flow.ts && cmp /tmp/flow.fixed examples/software-factory/software-factory.flow.ts && echo restored-byte-for-byte
restored-byte-for-byte

$ …/vitest run tests/canonical-software-factory.test.ts -t 'rejects malformed head'
 ✓ tests/canonical-software-factory.test.ts (18 tests | 15 skipped) 64ms
 Test Files  1 passed (1)
      Tests  3 passed | 15 skipped (18)
```

After all four, the flow file is the committed file — which is the restore proof
that outlives `/tmp`:

```console
$ sha256sum examples/software-factory/software-factory.flow.ts
ee56899fcb5c0a968d845620db3d4229673a3b732dd4d6131ab43b81822bf97b  examples/software-factory/software-factory.flow.ts

$ git status --short -- examples packages docs
 M examples/software-factory/README.md
```

(The one modified file is a stray double blank line removed from the README
prose added by this branch; the flow, the tests and the pins are untouched.
`summary.md` — this file — is modified too, which is why the status above is
scoped to the code paths.)

### Re-verified at this head

```console
$ cd packages/sdk && npm run typecheck --silent && npm run typecheck:tests --silent && echo "TYPECHECK OK"
TYPECHECK OK

$ cd packages/sdk && ./node_modules/.bin/vitest run tests/canonical-software-factory.test.ts tests/hosted-base-snapshot.test.ts
Stopped: invalid pull-request metadata (duplicate-github-closing-reference). No branch was pushed and no pull request was opened.
Stopped: invalid pull-request metadata (malformed-review-scope). No branch was pushed and no pull request was opened.
Stopped: invalid pull-request metadata (malformed-review-scope). No branch was pushed and no pull request was opened.
Stopped: could not read the reviewed head commit. Nothing was pushed.
Stopped: could not read the reviewed head commit. Nothing was pushed.
Stopped: could not read the reviewed head commit. Nothing was pushed.
 ✓ tests/canonical-software-factory.test.ts (18 tests) 705ms
 ✓ tests/hosted-base-snapshot.test.ts (18 tests) 2054ms
 Test Files  2 passed (2)
      Tests  36 passed (36)

$ cd packages/sdk && ./node_modules/.bin/vitest run tests/flow-requirements.test.ts tests/catalog-plugins.test.ts tests/babysitter-catalog-export.test.ts tests/babysitter-native-extension.test.ts
 FAIL  tests/babysitter-native-extension.test.ts > native Babysitter extension > runs the exact published 2.0.26 native bytes in the isolated capability path
Caused by: Error: Hosted extension sandbox exited without a valid completion (exit 1): bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
 Test Files  1 failed | 3 passed (4)
      Tests  1 failed | 70 passed (71)
```

The single failure is the bubblewrap case described above and in
`.relayflow/repair-notes.md`; it fails identically on an unmodified checkout of
this machine and no change here can clear it.
