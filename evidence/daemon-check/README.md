Commands were run from the repository root unless the command includes `cd`.
All `.txt` files contain captured output, not reconstructed output.

`cd packages/sdk && npx vitest run tests/check-daemon-validation.test.ts tests/cli.test.ts tests/cli-watch.test.ts tests/relay-cli-surface.test.ts`

[Captured output](sdk-final.txt)

`cd packages/sdk && npx vitest run tests/check-daemon-validation.test.ts tests/cli.test.ts tests/cli-watch.test.ts`

[Captured output](sdk-targeted-final.txt)

`cd packages/sdk && npx vitest run tests/relay-cli-surface.test.ts`

[Captured output](cli-surface-final.txt)

`cd packages/sdk && npx vitest run tests/plugin-extension.test.ts`

[Captured output](plugin-extension-retry.txt)

`cd packages/sdk && RELAYFLOWD_BIN=/tmp/relayflows-daemon-check-target/debug/relayflowd npx vitest run tests/live-kernel.test.ts -t 'validates the canonical ladder'`

[Captured output](live-ladder.txt)

`CARGO_TARGET_DIR=/tmp/relayflows-daemon-check-target CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0 /home/daytona/.cargo/bin/cargo test --manifest-path kernel/Cargo.toml -p relayflowd --test validate_spec`

[Captured output](rust-targeted-final.txt)

`CARGO_TARGET_DIR=/tmp/relayflows-daemon-check-target CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0 /home/daytona/.cargo/bin/cargo test --manifest-path kernel/Cargo.toml -j 2`

[Captured output](rust-workspace-retry.txt)

`cd packages/sdk && RELAYFLOWS_TOOLCHAIN_HOME=/tmp/daemon-check-toolchain CARGO_TARGET_DIR=/tmp/relayflows-daemon-check-target npm test`

[Captured output](sdk-full.txt)

`cd packages/sdk && PATH=/usr/bin:/bin /usr/local/share/nvm/versions/node/v25.6.0/bin/node node_modules/vitest/vitest.mjs run tests/check-daemon-validation.test.ts tests/cli.test.ts`

[Captured output](sdk-minimal-path.txt)

`node scripts/cli-package-gate.mjs`

[Captured output](package-gate.txt)

`node scripts/build-standalone-cli.mjs bun-linux-x64 /tmp/flows-daemon-check`

[Captured output](standalone-build.txt)

`RELAYFLOWD_BIN=/tmp/stub-relayflowd-check /tmp/flows-daemon-check check --against-daemon --json testdata/hello-deterministic.flow.yaml`

[Captured output](standalone-check.txt)

`cd packages/sdk && npm run typecheck && npm run typecheck:tests`

[Captured output](typecheck-final.txt)

`RELAYFLOWD_BIN=/tmp/relayflows-daemon-check-target/debug/relayflowd node packages/sdk/dist/cli.js check --against-daemon testdata/hello-agent.flow.yaml`

[Captured output](live-cli.txt)

`python3 evidence/daemon-check/mutation-run.py`

[Captured output](mutations.txt)

`git diff --check`

[Captured output](diff-check.txt)

The standalone stub consumed stdin and returned this envelope without running a flow:

```sh
#!/bin/sh
cat >/dev/null
printf '%s\n' '{"ok":true,"protocol":0,"spec_version":"0.1.0"}'
```

Additional historical captures: `rust-targeted.txt` is the private-toolchain
failure; `rust-targeted-retry.txt` contains the initial incorrect test assertion
for the cwd message; `rust-workspace.txt` contains the disk-full linker failure.
`sdk-build*.txt`, `typecheck-tests-final.txt`, and `sdk-targeted.txt` are earlier
build/typecheck/targeted captures. `rustfmt-setup.txt` records tool installation.
`timing.txt` captures shell `time` for the deterministic fixture in auto mode
with RELAYFLOWD_BIN pinned to the built binary, then with --no-daemon-check.
Each `mutation-*.txt` embeds its exact command and exit status. Temporary mutation
working directories are removed by the script; the captured outputs here persist.
