# Slice S verification

Run from `/Users/khaliqgant/fl-slice-S` on branch
`feat/spec-S-helpers-runtime-fanout`. No push or external provider write was
performed. Local mount tests simulate delivery receipts; provider writes in
kernel integration tests use mock mode.

## Scope and outstanding acceptance

See [HELPERS-RUNTIME.md](../../docs/HELPERS-RUNTIME.md) for the API and upstream
limitations. The generated registry covers 50 discovered namespaces, 40 with
runtime clients. Ten namespaces have no upstream client and are explicitly
unavailable. Notion appendBlock is mock-only because the adapter has no such
writeback route. This commit must not be treated as closing #340's full live
provider acceptance bar.

The final catalog factory adjustment is also covered by the full final run.
The earlier successful run is retained in
[sdk-tests-before-catalog-fallback.txt](sdk-tests-before-catalog-fallback.txt).

Registry inventory command:

```sh
node --input-type=module - <<'JS'
import { helperProviders } from './packages/surface/dist/runtime.js';
console.log(JSON.stringify({
  namespaces: helperProviders.length,
  runtimeClients: helperProviders.filter(p => p.supported).length,
  unavailable: helperProviders.filter(p => !p.supported).map(p => p.provider),
}, null, 2));
JS
```

Literal output: [provider-inventory.txt](provider-inventory.txt).

## Local package resolution

The SDK's `node_modules/@relayflows/surface` points to this worktree's
`packages/surface`, not the published 2.0.8 package. Dependencies were installed
with `npm install --ignore-scripts --prefix packages/surface` and
`npm install --ignore-scripts --prefix packages/sdk`, then the local surface
was built and linked. The surface lockfile repair is included in the commit.

For a fresh worktree, CI's equivalent local-package setup is:

```sh
npm ci --ignore-scripts --prefix packages/surface
npm run build --prefix packages/surface
npm ci --ignore-scripts --prefix packages/sdk
npm install ./packages/surface --prefix packages/sdk --no-save --ignore-scripts
```

## Commands and literal output

Surface typecheck:

```sh
npm run typecheck --prefix packages/surface
```

Captured output:

```text
> @relayflows/surface@2.0.8 typecheck
> tsc --noEmit
```

Surface tests and typed smoke fixture:

```sh
npm test --prefix packages/surface
```

Full captured output: [surface-tests.txt](surface-tests.txt).

Surface regression typechecks and codegen drift guard:

```sh
npm run typecheck:regressions --prefix packages/surface
```

Full captured output: [surface-regressions.txt](surface-regressions.txt).

Discovery from the supplied adapter checkout, followed by byte comparison with
regeneration from the pinned published inputs:

```sh
node scripts/generate-helpers.mjs --adapters-dir /Users/khaliqgant/Projects/AgentWorkforce/relayfile-adapters
node packages/surface/scripts/check-generated-helpers.mjs
```

Full captured output: [codegen.txt](codegen.txt).

Full SDK check, including kernel build, SDK and test typechecks, build, and all
SDK tests:

```sh
PATH=/Users/khaliqgant/.cargo/bin:$PATH RUSTUP_TOOLCHAIN=stable RELAYFLOWD_BIN=/Users/khaliqgant/.relayflows-toolchain/target/2945819964/debug/relayflowd VITEST_MAX_FORKS=2 VITEST_MIN_FORKS=1 npm test --prefix packages/sdk
```

Full captured output: [sdk-tests-final.txt](sdk-tests-final.txt). Exit status: 1: two watch-mode tests hit their unchanged five-second timeout under concurrent load. All typecheck/build phases completed successfully.

Literal final test output:

```text
 Test Files  1 failed | 70 passed | 1 skipped (72)
      Tests  2 failed | 1314 passed | 3 skipped (1319)
```

Both timeout failures were rerun as part of the entire watch suite, in isolation:

```sh
cd /Users/khaliqgant/fl-slice-S/packages/sdk
npm exec -- vitest run tests/cli-watch.test.ts --maxWorkers=1 --minWorkers=1
```

Literal output: [sdk-watch-retry.txt](sdk-watch-retry.txt). Exit status: 0.

```text
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

No assertions, timeouts, or test selection within that suite were changed.
The final tree therefore has passing evidence for every enabled test across
the full run and isolated retry; the final full invocation was not green.

The skipped tests are the existing opt-in real CLI adapter suite. The new
helper tests and the existing Slack crash/resume tests ran.

The explicit Rust toolchain bypasses a stale mise shim; RELAYFLOWD_BIN points
all test consumers at this worktree's freshly built daemon. The fork limits
reduce contention without changing test selection or timeout assertions.

The earlier full run is retained at [sdk-tests.txt](sdk-tests.txt):

```sh
PATH=/Users/khaliqgant/.cargo/bin:$PATH RUSTUP_TOOLCHAIN=stable npm test --prefix packages/sdk
```

It exposed the memory.recall/provider-name collision and missing refusal-kind
coverage, which were repaired, as well as missing daemon paths and timeout
failures. Its output is not passing evidence.
