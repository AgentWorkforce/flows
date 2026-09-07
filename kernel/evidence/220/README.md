# Issue #220 evidence

The crash-resume test was committed before implementation in `72e03d5`.
Its first execution exited 101 because the kernel rejected the new declaration.

```sh
cd kernel && cargo test -p relayflowd --test crash_resume memory_sigkill -- --nocapture
```

Literal captured output: [red-memory.txt](red-memory.txt).

The final kernel gate exited 0:

```sh
cd kernel && cargo test --workspace
```

Literal captured output, including the crash-resume, disabled-provider replay,
semantic-retry, epoch, exact-decimal, and shared-spec-corpus tests:
[workspace-tests.txt](workspace-tests.txt).

SDK compilation/parity and real wrapper execution exited 0:

```sh
cd packages/sdk && node node_modules/vitest/vitest.mjs run tests/memory.test.ts tests/spec-parity.test.ts tests/worker-cli.test.ts
```

Literal captured output: [sdk-tests.txt](sdk-tests.txt).

SDK type checks and build ran from `packages/sdk` using the commands below.
The capture includes each command and its actual subprocess exit status;
the commands themselves emitted no output:

```sh
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.type-tests.json
node node_modules/typescript/bin/tsc -p tsconfig.tests.json
node node_modules/typescript/bin/tsc
node scripts/make-cli-executable.mjs
```

Literal captured output: [sdk-typecheck.txt](sdk-typecheck.txt).

Dependencies were installed locally with `bun install --ignore-scripts` in
`packages/sdk`; no dependency or lockfile changes are part of this PR.
The fixed provider is synthetic substrate evidence, not a retrieval or
memory-quality evaluation. No mutation-verification claim is made.
