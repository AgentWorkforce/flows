# Agent timeout verification

Commands ran from the repository root unless a `cd` is shown. The linked files
contain captured stdout/stderr, including failures; they are not paraphrases.
Dependencies were installed in surface and SDK, the SDK's surface dependency was
linked to this checkout's built surface, and `ops/cargo.sh` installed its private
toolchain. No workflow files or gate workflows were changed.

| Literal command | Captured output |
| --- | --- |
| `npm run build --prefix packages/sdk` | [build-sdk.txt](build-sdk.txt) |
| `sh ops/cargo.sh build --manifest-path kernel/Cargo.toml` | [build-kernel.txt](build-kernel.txt) |
| `npm run typecheck --prefix packages/sdk` | [typecheck.txt](typecheck.txt) |
| `npm run typecheck:tests --prefix packages/sdk` | [test-typecheck.txt](test-typecheck.txt) |
| `sh ops/cargo.sh test --manifest-path kernel/Cargo.toml -p relayflowd-core` | [kernel.txt](kernel.txt) |
| `npm run generate --prefix packages/schema` | [schema-generate.txt](schema-generate.txt) |
| `npm test --prefix packages/schema` | [schema-tests.txt](schema-tests.txt) |

Final SDK regression command, with [captured output](final-regressions.txt):

```sh
cd packages/sdk && npx vitest run tests/agent-timeout.test.ts tests/agent-timeout-outcome.test.ts tests/agent-timeout-worker.test.ts tests/agent-timeout-live.test.ts tests/step-lease.test.ts tests/spec-parity.test.ts tests/verb-field-lint.test.ts tests/wrapper-execution-duration.test.ts tests/stop-process-group.test.ts tests/worker-cli.test.ts tests/authored-node-result.test.ts tests/authored-retried-child-resume-live.test.ts tests/authored-agent-artifacts.test.ts
```

Earlier broader command, with [captured failures](regression-tests.txt):

```sh
cd packages/sdk && npx vitest run tests/agent-timeout.test.ts tests/agent-timeout-worker.test.ts tests/agent-timeout-live.test.ts tests/step-lease.test.ts tests/spec-parity.test.ts tests/verb-field-lint.test.ts tests/wrapper-execution-duration.test.ts tests/stop-process-group.test.ts tests/worker-cli.test.ts tests/authored-node-result.test.ts tests/live-kernel.test.ts tests/authored-retried-child-resume-live.test.ts tests/authored-agent-artifacts.test.ts
```

That run found a stale per-verb descriptor expectation (updated to admit agent
`timeoutMs`) and nine live-kernel failures in this checkout. The checkout inherits
`type: commonjs` from `/home/daytona/package.json`; its extensionless ESM fixtures
did not emit their wrapper handshake. A daemon-discovery test also needed an
explicit binary path.

The live-kernel suite was rerun in `/tmp/agent-timeout-baseline`, an isolated
worktree **overlaid with the changed source, new files, and current SDK dist**.
Despite the directory name, this is the implemented code, not a baseline test.
Its SDK dependencies link to the installed dependencies in the working checkout.
No fixtures were rewritten to change their behavior. The analyzer opt-out flag
allows the existing suite to report unavailable live Claude access if needed;
the captured output records whether the analyzer actually executed.

```sh
cd /tmp/agent-timeout-baseline/packages/sdk && RELAYFLOWD_BIN=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 ./node_modules/.bin/vitest run tests/live-kernel.test.ts
```

[Captured isolated live-kernel output](isolated-live-kernel.txt).

The timeout-specific runtime and kill/resume tests ran in the original checkout
as part of the final SDK regression command. They do not depend on the isolated
checkout or on live provider access.

The remaining real Claude analyzer failure was also run against the original
branch head (`c88c3d0`) in `/tmp/agent-timeout-original`, with its own original
surface and SDK rebuilt. It used the same daemon executable. The original
source produced the same execution-gate failure; this is not a green live
analyzer acceptance claim.

```sh
cd /tmp/agent-timeout-original/packages/sdk && RELAYFLOWD_BIN=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd ./node_modules/.bin/vitest run tests/live-kernel.test.ts -t 'hn-monitor analyze-story reaches done through the real Claude analyzer CLI'
```

[Captured original-head analyzer output](original-analyzer.txt).
