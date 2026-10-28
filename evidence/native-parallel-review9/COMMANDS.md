# Literal verification commands

Commands ran from the Flows worktree root unless the section says
`packages/sdk`. The named volume `ms-flows-parallel-r7` had a native arm64
daemon, the 2.0.51 base SDK, and published 2.0.50/2.0.51 packages from the
[prior bundle](../native-parallel-review8/COMMANDS.md). The Docker container
used no host bind mounts; `docker cp` staged the final SDK build and exact
reviewer fixtures into its volume. `/w/head/packages/sdk` links to
`/w/sdk-head`, and `/w/base/packages/sdk` links to `/w/sdk-base-2051`.

```sh
npm run build --prefix packages/sdk
docker run -d --init --platform linux/arm64 --name ms-flows-parallel-r9 -v ms-flows-parallel-r7:/w -w /w/review9 node:22-trixie sleep infinity
docker exec ms-flows-parallel-r9 sh -c 'cp -a /w/sdk-head/dist /w/sdk-head-r8-dist && rm -rf /w/sdk-head/dist && mkdir -p /w/sdk-head/dist /w/review9'
docker cp packages/sdk/dist/. ms-flows-parallel-r9:/w/sdk-head/dist/
docker cp evidence/native-parallel-review9/. ms-flows-parallel-r9:/w/review9/
docker exec ms-flows-parallel-r9 sh -c "cp -a /w/sdk-head/dist /w/deep/packages/sdk/dist && cp -a /w/sdk-head/dist /w/forced/packages/sdk/dist && sed -i 's/export function parallelRunEligible(body, moduleSource) {/export function parallelRunEligible(body, moduleSource) { return true;/' /w/deep/packages/sdk/dist/authored-parallel-eligibility.js /w/forced/packages/sdk/dist/authored-parallel-eligibility.js && sed -i 's/export function parallelBodySyntaxEligible(body) {/export function parallelBodySyntaxEligible(body) { return true;/' /w/deep/packages/sdk/dist/authored-parallel-eligibility.js"
```

The final candidate was rebuilt once after adding the indexed-array check;
the same `docker cp` replaced `/w/sdk-head/dist`, and the `deep` and `forced`
copies were refreshed before the final runs. The preliminary logs were
discarded. `sdk-dist-hashes.log` verifies the final source/build identity.

## Exact reviewer matrices and probe

```sh
docker exec -w /w/review9 ms-flows-parallel-r9 node --no-warnings h7.mjs s7.mjs all --reps=6 --conc=3 --tag=r9finals7 --sides=head:head > evidence/native-parallel-review9/final-s7.log 2>&1
docker exec -w /w/review9 ms-flows-parallel-r9 node --no-warnings h8.mjs s8.mjs all --reps=6 --conc=3 --tag=r9finals8 > evidence/native-parallel-review9/final-s8.log 2>&1
docker exec -w /w/review9 ms-flows-parallel-r9 node --no-warnings probe8.mjs > evidence/native-parallel-review9/probe8.log 2>&1
docker exec -w /w/review9 ms-flows-parallel-r9 node timing7.mjs 10 > evidence/native-parallel-review9/final-timing.log 2>&1
```

The `deep` side is an isolated copy of the final candidate with only
`parallelRunEligible` and `parallelBodySyntaxEligible` forced to return true.
The base side is the 2.0.51 source build. The s8 harness itself runs the
head, base, and deep sides specified by the reviewer's `s8.mjs` verbatim.

## Scratch mutations

```sh
docker cp evidence/native-parallel-review9/mutation-stage.py ms-flows-parallel-r9:/w/review9/mutation-stage.py
docker exec -w /w/review9 ms-flows-parallel-r9 python3 mutation-stage.py > evidence/native-parallel-review9/mutation-stage.log 2>&1
docker exec -w /w/review9 ms-flows-parallel-r9 node --no-warnings h8.mjs s8.mjs RS1 --reps=6 --conc=3 --tag=r9mutf1parser --sides=fx:fx > evidence/native-parallel-review9/mut-f1-parser.log 2>&1
docker exec -w /w/review9 ms-flows-parallel-r9 node --no-warnings h8.mjs s8.mjs RS3bh --reps=6 --conc=3 --tag=r9mutf1resume --sides=m1:m1 > evidence/native-parallel-review9/mut-f1-resume.log 2>&1
docker exec -w /w/review9 ms-flows-parallel-r9 node --no-warnings h8.mjs s8.mjs PL9dep --reps=6 --conc=3 --tag=r9mutf2backstop --sides=m3:m3 > evidence/native-parallel-review9/mut-f2-backstop.log 2>&1
docker exec -w /w/review9 ms-flows-parallel-r9 node --no-warnings h8.mjs s8.mjs PL9dep --reps=12 --conc=3 --tag=r9mutf2removed --sides=m2:m2 > evidence/native-parallel-review9/mut-f2-removed.log 2>&1
docker exec -w /w/review9 ms-flows-parallel-r9 node --no-warnings h8.mjs s8.mjs PL8hide --reps=12 --conc=3 --tag=r9mutf2hide --sides=m2:m2 > evidence/native-parallel-review9/mut-f2-hide.log 2>&1
```

## SDK checks and build identity

The following commands ran from `packages/sdk`:

```sh
npm run build > ../../evidence/native-parallel-review9/sdk-build.log 2>&1
npm run typecheck > ../../evidence/native-parallel-review9/sdk-typecheck.log 2>&1
npm run typecheck:tests > ../../evidence/native-parallel-review9/sdk-typecheck-tests.log 2>&1
npx vitest run tests/authored-parallel-body.test.ts tests/authored-parallel-eligibility.test.ts tests/authored-step-graph.test.ts tests/authored-flow-lifecycle-executor.test.ts tests/authored-root.test.ts tests/authored-step-secrets.test.ts tests/communication-feature-secret-scoping.test.ts tests/worker-feature-secret-scoping.test.ts > ../../evidence/native-parallel-review9/sdk-focused-unit.log 2>&1
RELAYFLOWD_BIN="$HOME/.relayflows-toolchain/target/ms-step-secrets/debug/relayflowd" npx vitest run tests/authored-step-secrets-live.test.ts > ../../evidence/native-parallel-review9/sdk-secrets-live.log 2>&1
```

From the worktree root:

```sh
shasum -a 256 packages/sdk/dist/authored-flow-lifecycle.js packages/sdk/dist/authored-promise-graph.js packages/sdk/dist/authored-root.js > evidence/native-parallel-review9/sdk-dist-hashes.log
docker exec ms-flows-parallel-r9 sha256sum /w/sdk-head/dist/authored-flow-lifecycle.js /w/sdk-head/dist/authored-promise-graph.js /w/sdk-head/dist/authored-root.js >> evidence/native-parallel-review9/sdk-dist-hashes.log
docker rm -f ms-flows-parallel-r9
```
