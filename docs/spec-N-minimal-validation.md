# Slice N minimal proof: validation

Scope: generated Slack argument types, namespace composition, and drift detection.
The full five-provider slice remains open; see
[follow-up notes](../packages/surface/src/helpers/README.md).

Surface command (from `packages/surface`, with Bun on PATH):

```sh
bun install --frozen-lockfile --ignore-scripts && bun run build && bun run test && bun run typecheck && bun run typecheck:regressions
```

Captured output:

```text
bun install v1.4.2 (744846f84)

Checked 91 installs across 142 packages (no changes) [39.00ms]
$ tsc
$ bun run build && tsc -p tsconfig.test.json && vitest run
$ tsc

 RUN  v2.1.9 /Users/khaliqgant/flows-spec-N-helpers/packages/surface

 ✓ tests/flow.test.ts (7 tests) 3ms
 ✓ tests/helpers.snapshot.test.ts (1 test) 190ms

 Test Files  2 passed (2)
      Tests  8 passed (8)
   Start at  13:35:43
   Duration  413ms (transform 32ms, setup 0ms, collect 34ms, tests 193ms, environment 0ms, prepare 68ms)

$ tsc --noEmit
$ tsc -p ../../regressions/tsconfig.json && tsc -p tsconfig.test.json && node scripts/check-generated-helpers.mjs
HELPERS_GENERATED_OK index.ts, slack.ts
```

SDK used the local surface tarball via:

```sh
# From packages/surface
npm pack --ignore-scripts --pack-destination /tmp/spec-N-surface-pack
npm ci --prefix ../sdk --ignore-scripts
npm install /tmp/spec-N-surface-pack/relayflows-surface-2.0.8.tgz --prefix ../sdk --no-save --ignore-scripts
```

SDK command (from `packages/sdk`):

```sh
npm run typecheck && npm run typecheck:tests && ./node_modules/.bin/vitest run tests/authored-flow.test.ts
```

Captured output:

```text

> @relayflows/sdk@2.0.8 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json


> @relayflows/sdk@2.0.8 typecheck:tests
> tsc -p tsconfig.tests.json


 RUN  v2.1.9 /Users/khaliqgant/flows-spec-N-helpers/packages/sdk

 ✓ tests/authored-flow.test.ts (25 tests) 639ms

 Test Files  1 passed (1)
      Tests  25 passed (25)
   Start at  13:35:23
   Duration  1.07s (transform 110ms, setup 0ms, collect 217ms, tests 639ms, environment 0ms, prepare 34ms)

```
