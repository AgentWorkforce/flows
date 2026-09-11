# Plugin registry minimal slice evidence

Ships npm installation, effect-only manifests/runtime, authored preflight, and
optional module augmentation. Follow-ups are listed in SURFACE §3.
No kernel source changes. No new skipped tests.

Dependency setup: `npm ci --ignore-scripts` in packages/sdk, followed by copying
this worktree's built surface `dist` into its installed surface package. Bun was
added to PATH and the kernel was built from this worktree for the final SDK run.
An earlier SDK run used an older shared daemon and lacked Bun; final results below
supersede that environment run. The last receipt metadata edit was covered by the
focused rerun and both typechecks after the full suite.

## Focused checks

From packages/sdk:
```
RELAYFLOWD_BIN=/Users/khaliqgant/.relayflows-toolchain/target/2930744996/debug/relayflowd ./node_modules/.bin/vitest run tests/preflight.test.ts tests/plugin-add.test.ts tests/plugin-loader.test.ts
```
Captured output:
```

 RUN  v2.1.9 /Users/khaliqgant/flows-spec-J-plugin/packages/sdk

 ✓ tests/preflight.test.ts (27 tests) 35ms
 ✓ tests/plugin-loader.test.ts (5 tests) 146ms
 ✓ tests/plugin-add.test.ts (7 tests) 772ms
   ✓ installs a real offline npm fixture and includes declarations 369ms
   ✓ typechecks the augmented verb and rejects unknown namespaces 392ms

 Test Files  3 passed (3)
      Tests  39 passed (39)
   Start at  19:12:07
   Duration  1.31s (transform 281ms, setup 0ms, collect 960ms, tests 953ms, environment 0ms, prepare 98ms)

```

## Types

From packages/sdk: `npm run typecheck && npm run typecheck:tests` (exit 0).
Captured output:
```

> @relayflows/sdk@2.0.8 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json


> @relayflows/sdk@2.0.8 typecheck:tests
> tsc -p tsconfig.tests.json

```

## Kernel

From kernel:
```
PATH=/Users/khaliqgant/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH sh ../ops/cargo.sh test --workspace
```
Exit 0. Captured result lines (full local log: /private/tmp/spec-J-kernel.log):
```
test result: ok. 40 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.56s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s
test result: ok. 40 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 37.52s
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.07s
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.08s
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 3.55s
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.07s
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.07s
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.58s
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.19s
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.08s
test result: ok. 60 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.59s
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s
test result: ok. 28 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.12s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

## Full SDK suite

From packages/sdk:
```
PATH=/Users/khaliqgant/.bun/bin:$PATH RELAYFLOWD_BIN=/Users/khaliqgant/.relayflows-toolchain/target/2930744996/debug/relayflowd ./node_modules/.bin/vitest run
```
Exit 1: the real Claude analyzer readiness probe is unavailable. This is an
unpassed acceptance test, not a green full suite. Existing opt-in adapter tests
remain skipped; no skip flags were enabled. Captured final output excerpt
(full local log: /private/tmp/spec-J-sdk-final.log):
```
   ✓ built flows CLI against live relayflowd > preflights before journaling and names an unreachable socket 1972ms
   ✓ built flows CLI against live relayflowd > starts exactly one daemon when two runs race for one empty data dir 967ms
   ✓ surface resume after a real daemon kill > resumes a three-step run with each successful completion exactly once 1845ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/live-kernel.test.ts > built flows CLI against live relayflowd > hn-monitor analyze-story reaches done through the real Claude analyzer CLI
Error: LIVE_ANALYZER_UNAVAILABLE: "/Users/khaliqgant/flows-spec-J-plugin/testdata/preflight/analyze-story-claude-cli auth status" exited 1: analyze-story-claude-cli: "claude -p --model claude-haiku-4-5-20251001" exited 1: — failing because gate-2 acceptance requires the real analyzer to execute. Set RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 only if this run is not gate evidence.
 ❯ tests/live-kernel.test.ts:1223:15
    1221|       const notice = `LIVE_ANALYZER_UNAVAILABLE: ${readiness.detail}`;
    1222|       if (process.env['RELAYFLOWS_ALLOW_ANALYZER_SKIP'] !== '1') {
    1223|         throw new Error(
       |               ^
    1224|           `${notice} — failing because gate-2 acceptance requires the …
    1225|           + 'Set RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 only if this run is …

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed | 69 passed | 1 skipped (71)
      Tests  1 failed | 1220 passed | 3 skipped (1224)
   Start at  19:11:02
   Duration  57.03s (transform 1.25s, setup 0ms, collect 8.68s, tests 214.59s, environment 6ms, prepare 1.97s)

```

## CLI smoke

Scratch project used a fixture-only npm shim that forwards to real npm's offline
local-package install, rather than contacting the public npm registry.
```
Command: node packages/sdk/dist/cli.js add helper-datadog (scratch project, npm stand-in installs local offline fixture)
Added @flows/helper-datadog
exit=0
{
  "plugins": [
    "@flows/helper-datadog"
  ]
}

```
