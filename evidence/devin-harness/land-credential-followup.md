# Hosted-land credential diagnostics follow-up

Hosted flow operators supply a CLI-login token through `FLOW_DEVIN_API_KEY`; the Cloud alias passes it to the runtime as `DEVIN_API_KEY`. Local runtime use retains `DEVIN_API_KEY`. Sign-in refusals now state both contexts, and auth probes retain actual error details with credential values redacted.

The first regression attempt accidentally ran `npx` from the repository root and selected Vitest 5.1.0. Its new assertion also expected the wrong casing for the redaction marker. That assertion was corrected to the implementation's marker, and the check reran from `packages/sdk` using the installed Vitest 2.1.9. This was a test-expectation failure; the output already showed the credential value redacted.

Initial command, from repository root:

```sh
TMPDIR=/Users/khaliqgant/.cache/devin-harness/tmp npx vitest run tests/devin.test.ts tests/cli-probe.test.ts tests/preflight.test.ts
```

```text
npm warn exec The following package was not found and will be installed: vitest@5.1.0

 RUN  v5.1.0 /Volumes/T7/Projects/AgentWorkforce/worktrees/flows/devin-harness-20261102

 ❯ packages/sdk/tests/devin.test.ts (13 tests | 1 failed) 1925ms
   × redacts a provider auth failure that echoes its staged credential, including a padded key 355ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  packages/sdk/tests/devin.test.ts > redacts a provider auth failure that echoes its staged credential, including a padded key
AssertionError: expected 'windsurf_api_key = "[redacted:DEVIN_A…' to contain 'REDACTED'

Expected: "REDACTED"
Received: "windsurf_api_key = "[redacted:DEVIN_API_KEY]""

 ❯ packages/sdk/tests/devin.test.ts:191:38
    189|     expect(result.authExitCode).toBe(1);
    190|     expect(result.authFailureDetail).not.toContain('invalid-devin-secr…
    191|     expect(result.authFailureDetail).toContain('REDACTED');
       |                                      ^
    192|   }
    193| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed | 2 passed (3)
      Tests  1 failed | 100 passed (101)
   Start at  12:14:57
   Duration  6.31s (tests 71%, transform 17%, import 12%)
```

Corrected command, from `packages/sdk`:

```sh
TMPDIR=/Users/khaliqgant/.cache/devin-harness/tmp node node_modules/vitest/vitest.mjs run tests/devin.test.ts tests/cli-probe.test.ts tests/preflight.test.ts && npm run typecheck && npm run typecheck:tests
```

```text

 RUN  v2.1.9 /Volumes/T7/Projects/AgentWorkforce/worktrees/flows/devin-harness-20261102/packages/sdk

 ✓ tests/preflight.test.ts (70 tests) 39ms
 ✓ tests/devin.test.ts (14 tests) 1840ms
   ✓ checks provider auth with isolated credentials in both synchronous and asynchronous preflight 349ms
   ✓ refuses an unavailable model and missing model-probe credentials in both preflight drivers 520ms
 ✓ tests/cli-probe.test.ts (18 tests) 5186ms
   ✓ returns the absolute executable selected for a bare CLI name 341ms
   ✓ executes a canonical shebang target through its authored alias in both probe drivers 307ms
   ✓ scopes delivered secrets in PATH lookup and provider probes for checked and authored steps 794ms
   ✓ reports timeout in both drivers while the async driver leaves the loop free 496ms

 Test Files  3 passed (3)
      Tests  102 passed (102)
   Start at  12:18:04
   Duration  6.41s (transform 988ms, setup 30ms, collect 2.71s, tests 7.06s, environment 0ms, prepare 137ms)

> @relayflows/sdk@2.0.55 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json


> @relayflows/sdk@2.0.55 typecheck:tests
> tsc -p tsconfig.tests.json

```

The actual replacement workspace CLI token has not been tested by this session. No secret was created, replaced, or printed.

Known secret values are redacted before general email/token/hex patterns so an interior match cannot expose a token suffix. The regression includes an echoed padded key with a 32-hex interior fragment.

The hosted operator prefix was subsequently renamed from `LAND_` to `FLOW_`. Current guidance uses `FLOW_DEVIN_API_KEY`; historical captured runs above remain unchanged. Focused rename checks, run from `packages/sdk`:

```sh
TMPDIR=/Users/khaliqgant/.cache/devin-harness/tmp node node_modules/vitest/vitest.mjs run tests/devin.test.ts tests/preflight.test.ts && npm run typecheck && npm run typecheck:tests
```

```text

 RUN  v2.1.9 /Volumes/T7/Projects/AgentWorkforce/worktrees/flows/devin-harness-20261102/packages/sdk

 ✓ tests/preflight.test.ts (70 tests) 41ms
 ✓ tests/devin.test.ts (14 tests) 2126ms
   ✓ launches print mode with file input and cleans up after --version
Do the task 339ms
   ✓ checks provider auth with isolated credentials in both synchronous and asynchronous preflight 346ms
   ✓ refuses an unavailable model and missing model-probe credentials in both preflight drivers 443ms
   ✓ fully redacts echoed credentials before shape-based scrubbing 309ms
   ✓ fully redacts echoed credentials before shape-based scrubbing 380ms

 Test Files  2 passed (2)
      Tests  84 passed (84)
   Start at  12:46:04
   Duration  2.89s (transform 911ms, setup 20ms, collect 1.78s, tests 2.17s, environment 0ms, prepare 110ms)

> @relayflows/sdk@2.0.55 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json


> @relayflows/sdk@2.0.55 typecheck:tests
> tsc -p tsconfig.tests.json

```

Short-key review follow-up: preflight removes explicitly supplied normalized Devin credentials even when they are shorter than the shared redactor's eight-character threshold. Regression cases include one, three and seven characters in both probe drivers. Documentation describes the required hosted mapping without a PR-specific dependency. Captured grouped command, from `packages/sdk`:

```sh
set -o pipefail; { TMPDIR=/Users/khaliqgant/.cache/devin-harness/tmp node node_modules/vitest/vitest.mjs run tests/devin.test.ts tests/cli-probe.test.ts tests/preflight.test.ts && npm run typecheck && npm run typecheck:tests; } 2>&1 | tee /Users/khaliqgant/.cache/devin-harness/flows-short-key-tests.log
```

```text

 RUN  v2.1.9 /Volumes/T7/Projects/AgentWorkforce/worktrees/flows/devin-harness-20261102/packages/sdk

 ✓ tests/preflight.test.ts (70 tests) 45ms
 ✓ tests/devin.test.ts (17 tests) 3471ms
   ✓ launches print mode with file input and cleans up after --version
Do the task 412ms
   ✓ redacts the normalized token when the supplied key has surrounding whitespace 348ms
   ✓ checks provider auth with isolated credentials in both synchronous and asynchronous preflight 338ms
   ✓ refuses an unavailable model and missing model-probe credentials in both preflight drivers 486ms
   ✓ fully redacts echoed credentials before shape-based scrubbing 303ms
   ✓ fully redacts echoed credentials before shape-based scrubbing 312ms
   ✓ fully redacts echoed credentials before shape-based scrubbing 394ms
   ✓ fully redacts echoed credentials before shape-based scrubbing 432ms
 ✓ tests/cli-probe.test.ts (18 tests) 6828ms
   ✓ executes a canonical shebang target through its authored alias in both probe drivers 323ms
   ✓ keeps synchronous and asynchronous classification equal: model denied 469ms
   ✓ keeps synchronous and asynchronous classification equal: auth denied 390ms
   ✓ keeps missing executables and unsupported identification fail closed 332ms
   ✓ uses an explicit provider environment for every probe process 318ms
   ✓ scopes delivered secrets in PATH lookup and provider probes for checked and authored steps 1009ms
   ✓ reports timeout in both drivers while the async driver leaves the loop free 538ms
   ✓ reports signal termination in both drivers 370ms
   ✓ classifies a failed claude model probe from its own output: outdated CLI 388ms
   ✓ classifies a failed claude model probe from its own output: usage limit 443ms
   ✓ classifies a failed claude model probe from its own output: rate limit 380ms
   ✓ classifies a failed claude model probe from its own output: unknown model 429ms
   ✓ classifies a failed claude model probe from its own output: unrecognised output 441ms

 Test Files  3 passed (3)
      Tests  105 passed (105)
   Start at  12:55:36
   Duration  8.22s (transform 1.05s, setup 34ms, collect 3.03s, tests 10.34s, environment 0ms, prepare 149ms)


> @relayflows/sdk@2.0.55 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json


> @relayflows/sdk@2.0.55 typecheck:tests
> tsc -p tsconfig.tests.json
```
