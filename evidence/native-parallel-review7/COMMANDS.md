# Commands and captured output

These are the literal verification commands, run from the flows worktree root.
The named `ms-flows-parallel-r7` volume held the native arm64 daemon, SDK
builds, reviewer generators, and harness at `/bench`; `review6-exact.mjs`
created and removed each fixture in that volume. Every command's complete
stdout and stderr is in the named log file.

```sh
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/bench -e RELAYFLOWD_BIN=/bench/relayflowd -e CASE=R1,R1w,R1wn,R2w,R3w,R3,R4w,R1c,R5n node:22-trixie node /bench/cases/review6-exact.mjs > evidence/native-parallel-review7/arm-volume-r-all.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/bench -e RELAYFLOWD_BIN=/bench/relayflowd -e CASE=Q5,Q5n,Q5h,Q5w,Q5wn,Q5wh,Q6Pw node:22-trixie node /bench/cases/review6-exact.mjs > evidence/native-parallel-review7/arm-volume-q.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/bench -e RELAYFLOWD_BIN=/bench/relayflowd -e CASE=E1factory,E2helper,E3dyn,E4json,E4jsonuse,E5ns node:22-trixie node /bench/cases/review6-exact.mjs > evidence/native-parallel-review7/arm-volume-e.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/bench -e RELAYFLOWD_BIN=/bench/relayflowd -e CASE=P1,P1h,P1c,P1n,P1bn,P2,C1e,G1,H1,H2,K4,I1,K2b,K3,K5b,K13b node:22-trixie node /bench/cases/review6-exact.mjs > evidence/native-parallel-review7/arm-volume-prior-all.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/bench -e RELAYFLOWD_BIN=/bench/relayflowd -e CASE=A1,B1,N2 node:22-trixie node /bench/cases/review6-exact.mjs > evidence/native-parallel-review7/arm-volume-native.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/bench -e RELAYFLOWD_BIN=/bench/relayflowd -e CASE=K1 -e EXPECT_BASE_FAILURE=1 node:22-trixie node /bench/cases/review6-exact.mjs > evidence/native-parallel-review7/arm-volume-k1-head.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/bench -e RELAYFLOWD_BIN=/bench/relayflowd -e CASE=K1 -e EXPECT_BASE_FAILURE=1 -e BASELINE=1 -e FIRST_BIN=/bench/sdk-base-2051/dist/cli.js -e RESUME_BIN=/bench/sdk-base-2051/dist/cli.js node:22-trixie node /bench/cases/review6-exact.mjs > evidence/native-parallel-review7/arm-volume-k1-base2051.log 2>&1
```

The upgrade and rollback commands used the published npm SDKs. The 2.0.50
side used `relayflowd2050` built from `da6eeb3f`; the 2.0.51 side used this
branch's kernel, which matches the published kernel for these cases.

```sh
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/bench -e RELAYFLOWD_BIN=/bench/relayflowd -e FIRST_DAEMON_BIN=/bench/relayflowd2050 -e RESUME_DAEMON_BIN=/bench/relayflowd -e FIRST_BIN=/bench/p2050/node_modules/@relayflows/sdk/dist/cli.js -e FIXTURE_NODE_MODULES=/bench/p2050/node_modules -e CASE=UCI4,UCI5,UA1,UB1,UN2 -e BASELINE=1 node:22-trixie node /bench/cases/review6-exact.mjs > evidence/native-parallel-review7/arm-volume-upgrade2050.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/bench -e RELAYFLOWD_BIN=/bench/relayflowd -e CASE=UCI4,UCI5,UA1,UB1,UN2 -e BASELINE=1 -e FIRST_BIN=/bench/sdk-base-2051/dist/cli.js node:22-trixie node /bench/cases/review6-exact.mjs > evidence/native-parallel-review7/arm-volume-upgrade2051.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/bench -e RELAYFLOWD_BIN=/bench/relayflowd -e RESUME_DAEMON_BIN=/bench/relayflowd2050 -e FINAL_DAEMON_BIN=/bench/relayflowd -e RESUME_BIN=/bench/p2050/node_modules/@relayflows/sdk/dist/cli.js -e FINAL_BIN=/bench/node_modules/@relayflows/sdk/dist/cli.js -e CASE=RBCI4,RBCI5,RBA1,RBB1,RBN2 -e EXPECT_ROLLBACK_REFUSAL=1 node:22-trixie node /bench/cases/review6-exact.mjs > evidence/native-parallel-review7/arm-volume-rollback2050.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/bench -e RELAYFLOWD_BIN=/bench/relayflowd -e CASE=RBCI4,RBCI5,RBA1,RBB1,RBN2 -e EXPECT_ROLLBACK_REFUSAL=1 -e RESUME_BIN=/bench/sdk-base-2051/dist/cli.js -e FINAL_BIN=/bench/node_modules/@relayflows/sdk/dist/cli.js node:22-trixie node /bench/cases/review6-exact.mjs > evidence/native-parallel-review7/arm-volume-rollback2051.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/bench node:22-trixie node /bench/cases/timing.mjs > evidence/native-parallel-review7/arm-volume-timing.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/bench -e RELAYFLOWD_BIN=/bench/relayflowd -e FORCE_ELIGIBLE=1 -e CASE=FRrace,FRany,FRnestrace,FRdefer,FRthen,FRcatch,FRwrap,FRsettled,FRset,FRgen,FRthenagg,FRfinally,FRiter,FRmicro node:22-trixie node /bench/cases/review6-exact.mjs > evidence/native-parallel-review7/arm-volume-forced.log 2>&1
```

The forced command modified only the staged SDK dist. After it exited,
`authored-parallel-eligibility.js` was restored from the pristine `sdk-head`
copy and compared with `cmp`.

Mutation commands and complete fail/pass output are captured by:

```sh
bash evidence/native-parallel-review7/mutation-proof.sh > evidence/native-parallel-review7/mutation-proof.log 2>&1
```

Final SDK checks ran from `packages/sdk` after the mutations were restored:

```sh
npm run build > ../../evidence/native-parallel-review7/sdk-build.log 2>&1
npm run typecheck > ../../evidence/native-parallel-review7/sdk-typecheck.log 2>&1
npm run typecheck:tests > ../../evidence/native-parallel-review7/sdk-typecheck-tests.log 2>&1
npx vitest run tests/authored-parallel-body.test.ts tests/authored-parallel-eligibility.test.ts tests/authored-step-graph.test.ts tests/authored-flow-lifecycle-executor.test.ts tests/authored-step-secrets.test.ts tests/communication-feature-secret-scoping.test.ts tests/worker-feature-secret-scoping.test.ts > ../../evidence/native-parallel-review7/sdk-focused-unit.log 2>&1
RELAYFLOWD_BIN="$HOME/.relayflows-toolchain/target/ms-step-secrets/debug/relayflowd" npx vitest run tests/authored-step-secrets-live.test.ts > ../../evidence/native-parallel-review7/sdk-secrets-live.log 2>&1
npm ci > ../../evidence/native-parallel-review7/sdk-npm-ci.log 2>&1
{ ls -ld node_modules node_modules/@relayflows/surface; node -p "require.resolve('@relayflows/surface')"; node -p "require('node:fs').realpathSync('node_modules/@relayflows/surface')"; } > ../../evidence/native-parallel-review7/workspace-resolution.log 2>&1
```

The built source and the staged Docker SDK were compared from the worktree root:

```sh
shasum -a 256 packages/sdk/dist/authored-parallel-eligibility.js packages/sdk/dist/authored-parallel-body.js packages/sdk/dist/authored-flow-lifecycle.js packages/sdk/dist/authored-step-graph.js > evidence/native-parallel-review7/sdk-dist-hashes.log
docker run --rm --platform linux/arm64 -v ms-flows-parallel-r7:/bench node:22-trixie sha256sum /bench/sdk-head/dist/authored-parallel-eligibility.js /bench/sdk-head/dist/authored-parallel-body.js /bench/sdk-head/dist/authored-flow-lifecycle.js /bench/sdk-head/dist/authored-step-graph.js >> evidence/native-parallel-review7/sdk-dist-hashes.log
```
