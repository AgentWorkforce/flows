`flows check` loads the TypeScript parser at runtime, but clean npm consumers did not receive it. Move `typescript` (`^5.6.0`, unchanged) into SDK runtime dependencies and declare the existing `undici` import at `^7.29.1`. Regenerate the npm lockfile without dependency upgrades. TypeScript remains necessary because the activity checker parses TypeScript syntax, which acorn cannot parse.

Add two regressions to the SDK suite: an AST scan of built JavaScript for undeclared literal imports/re-exports/require calls, and a real tarball installation test for local and global consumers. The latter packs surface, SDK, and relayflows using the existing release packer, copies a checked example outside the repository, and checks both npm's linked `flows` executable and the wrapper entry point. It rejects ancestor node_modules, clears Node resolution overrides, verifies TypeScript resolves inside the installation, and ensures no global tsc/tsserver bins appear.

The test adds an explicit wrapper invocation to the reviewed plan because both SDK and relayflows claim the `flows` bin: npm linked that command to the SDK in this environment. Checking only the bin would leave the wrapper entry point unexercised.

The packaging test runs through the existing CI SDK suite with a 120-second timeout. Registry errors fail the test. `FLOWS_SKIP_PACKAGE_GATE=1` is an explicit, loudly reported local opt-out. It requires Node >=22.18.0, omits unrelated optional platform binaries, and checks that the example imports only the surface package. Workflow path additions are isolated in their own commit, as requested. The optional publish-workflow change is omitted.

Standalone Bun binaries are not tested by this change. The broader published Node engines range and stale SDK bun.lock remain outside this fix.


Verification (literal commands and captured output are in [evidence/cli-runtime-dependencies](evidence/cli-runtime-dependencies/README.md)):

- Mutation-verified both regressions with `python3 evidence/cli-runtime-dependencies/mutation.py`: moved only TypeScript to devDependencies, captured the import scan failure, regenerated the matching lock, captured the packaged CLI crash, restored both files byte-for-byte, then captured both passes. Full [transcript](evidence/cli-runtime-dependencies/mutation-run.txt).
- `npm run typecheck --prefix packages/sdk`, both package builds, and `npm run typecheck:tests --prefix packages/sdk` exited 0. `node --test scripts/publish.test.mjs` passed 7 tests.
- Lock regeneration and `npm ci --prefix packages/sdk --dry-run --ignore-scripts` exited 0; the lock has one undici entry and TypeScript is no longer marked dev-only.
- **Full SDK suite failed** (`cd packages/sdk && ./node_modules/.bin/vitest run`). Both new tests passed. Failures include missing expected relayflowd binaries, unavailable bubblewrap/analyzer, Bun 1.3.6 where 1.4.0 is expected, timeouts, and other integration assertions. These failures were not repaired or established against a baseline; this is not a green full-suite claim. Full [output](evidence/cli-runtime-dependencies/suite.txt).

Captured full-suite summary:

```text
 Test Files  41 failed | 202 passed | 3 skipped (246)
      Tests  182 failed | 3530 passed | 30 skipped (3742)
     Errors  81 errors
   Duration  698.51s (transform 6.61s, setup 1.04s, collect 70.87s, tests 1957.35s, environment 29ms, prepare 9.67s)
```

Captured mutation results (excerpts; full commands/output linked above):

```text
     → Undeclared runtime dependencies: expected [ 'typescript' ] to deeply equal []
AssertionError: Undeclared runtime dependencies: expected [ 'typescript' ] to deeply equal []
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'typescript' imported from /tmp/flows-cli-package-ZIvqJq/local/node_modules/@relayflows/sdk/dist/cli/check-activities.js
Restored manifest and lock byte-for-byte.
 Test Files  1 passed (1)
      Tests  1 passed (1)
CHECK PASSED examples/dependency-upgrade-bot.flow.ts
CHECK PASSED examples/dependency-upgrade-bot.flow.ts
CHECK PASSED examples/dependency-upgrade-bot.flow.ts
CHECK PASSED examples/dependency-upgrade-bot.flow.ts
CLI_PACKAGE_OK: local and global installs
```
