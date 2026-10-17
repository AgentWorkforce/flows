# Literal verification commands

Commands below were run from the Flows worktree root unless a section says
`packages/sdk`. Each redirection is to the complete stdout/stderr log in this
directory. The existing named volume was prepared by the previous
[review-6 evidence](../native-parallel-review7/COMMANDS.md): native arm64
daemon, current-head and published-2.0.51 SDK builds, and published 2.0.50
SDK/daemon. This run copied the rebuilt `packages/sdk/dist` and exact fixture
files into that volume with `docker cp`, then linked `/w/head/packages/sdk` to
the candidate copy and `/w/base/packages/sdk` to the published 2.0.51 copy.
The corrected `/w/p2051/node_modules/@relayflows/sdk` link points to
`/w/sdk-base-2051`; `published-2051-pin.log` records its hash and version.

## Exact review-7 and prior fixtures

```sh
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/w -w /w/review8 node:22-trixie node --no-warnings h7.mjs s7.mjs all --reps=6 --conc=3 --tag=r8s7head --sides=head:head > evidence/native-parallel-review8/h7-s7-head.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/w -w /w/review8 node:22-trixie node --no-warnings h7.mjs s7.mjs PL3sub,PL4ctor,SEC7 --reps=6 --conc=3 --tag=r8basefail --sides=base:base > evidence/native-parallel-review8/h7-base-fail-controls.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/w -w /w/review8 node:22-trixie node --no-warnings h7.mjs s2.mjs R1,R1w,R1wn,R2w,R3,R3w,R4w,R1c --reps=6 --conc=3 --tag=r8prior-r --sides=head:head > evidence/native-parallel-review8/h7-prior-r.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/w -w /w/review8 node:22-trixie node --no-warnings h7.mjs s4.mjs R5n --reps=6 --conc=3 --tag=r8prior-r5n --sides=head:head > evidence/native-parallel-review8/h7-prior-r5n.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/w -w /w/review8 node:22-trixie node --no-warnings h7.mjs s.mjs Q5,Q5n,Q5h,Q5w,Q5wn,Q5wh,Q6Pw --reps=6 --conc=3 --tag=r8prior-q --sides=head:head > evidence/native-parallel-review8/h7-prior-q.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/w -w /w/review8 node:22-trixie node --no-warnings h7.mjs s2.mjs E1factory,E2helper,E3dyn,E4json,E4jsonuse,E5ns --reps=6 --conc=3 --tag=r8prior-e --sides=head:head > evidence/native-parallel-review8/h7-prior-e.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/w -w /w/review8 node:22-trixie node --no-warnings h7.mjs s.mjs P1,P1h,P1c,P1n,P1bn,P2,C1e,G1,H1,H2,K4,I1,K2b,K3,K5b,K13b --reps=6 --conc=3 --tag=r8prior-p --sides=head:head > evidence/native-parallel-review8/h7-prior-p.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/w -w /w/review8 node:22-trixie node --no-warnings h7.mjs s.mjs I1 --reps=6 --conc=3 --tag=r8i1base --sides=base:base > evidence/native-parallel-review8/h7-i1-base-control.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/w -w /w/review8 node:22-trixie node --no-warnings h7.mjs s.mjs K1 --reps=6 --conc=3 --tag=r8k1 > evidence/native-parallel-review8/h7-k1-controls.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/w -w /w/review8 node:22-trixie node --no-warnings h7.mjs s.mjs A1,B1,N2 --reps=6 --conc=3 --tag=r8prior-native --sides=head:head > evidence/native-parallel-review8/h7-prior-native.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/w -w /w/review8 node:22-trixie node --no-warnings h7.mjs s2.mjs FRrace,FRany,FRnestrace,FRdefer,FRthen,FRsettled,FRset,FRgen,FRthenagg,FRmicro,FRcatch,FRfinally,FRiter,FRwrap --reps=6 --conc=3 --tag=r8prior-fr --sides=forced:forced > evidence/native-parallel-review8/h7-prior-fr.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/w -w /w/review8 node:22-trixie node --no-warnings h7.mjs s2.mjs FRrace,FRany,FRnestrace,FRdefer,FRthen,FRsettled,FRset,FRgen,FRthenagg,FRmicro,FRcatch,FRfinally,FRiter,FRwrap --reps=6 --conc=3 --tag=r8prior-deep --sides=deep:deep > evidence/native-parallel-review8/h7-prior-deep.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/w -w /w/review8 node:22-trixie node --no-warnings h7.mjs s3.mjs FB1,FB2,FB3,FB3c,FB4,FB6,FB7,FB8 --reps=6 --conc=3 --tag=r8prior-fb --sides=forced:forced > evidence/native-parallel-review8/h7-prior-fb.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/w -w /w/review8 node:22-trixie node --no-warnings h7.mjs s3.mjs S1,S2missing --reps=6 --conc=3 --tag=r8secrets-prior > evidence/native-parallel-review8/h7-prior-secrets.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/w -w /w/review8 node:22-trixie node --no-warnings h7.mjs s2.mjs UCI4,UCI5,UA1,UB1,UN2 --reps=6 --conc=3 --tag=r8upgrade-pinned > evidence/native-parallel-review8/h7-upgrade-pinned.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/w -w /w/review8 node:22-trixie node --no-warnings h7.mjs s2.mjs RBCI4,RBCI5,RBA1,RBB1,RBN2 --reps=6 --conc=3 --tag=r8rollback-pinned > evidence/native-parallel-review8/h7-rollback-pinned.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/w -w /w/review8 node:22-trixie node timing7.mjs 10 > evidence/native-parallel-review8/h7-timing.log 2>&1
docker run --rm --init --platform linux/arm64 -v ms-flows-parallel-r7:/w -w /w/review8 node:22-trixie node --no-warnings probe.mjs > evidence/native-parallel-review8/h7-probe.log 2>&1
```

The `forced` copy changes only `parallelRunEligible` to return true. The `deep`
copy additionally changes `parallelBodySyntaxEligible` to return true. Both
were scratch `dist` copies inside the volume; the worktree source and built
candidate were untouched. The F5 script makes its own scratch copy.

## Mutation proofs and SDK checks

```sh
python3 evidence/native-parallel-review8/mutation-proof.py > evidence/native-parallel-review8/mutation-proof.log 2>&1
bash evidence/native-parallel-review8/f5-mutation-proof.sh > evidence/native-parallel-review8/f5-mutation-proof.log 2>&1
```

The following commands ran from `packages/sdk`:

```sh
npm run build > ../../evidence/native-parallel-review8/sdk-build.log 2>&1
npm run typecheck > ../../evidence/native-parallel-review8/sdk-typecheck.log 2>&1
npm run typecheck:tests > ../../evidence/native-parallel-review8/sdk-typecheck-tests.log 2>&1
npx vitest run tests/authored-parallel-body.test.ts tests/authored-parallel-eligibility.test.ts tests/authored-step-graph.test.ts tests/authored-flow-lifecycle-executor.test.ts tests/authored-root.test.ts tests/authored-step-secrets.test.ts tests/communication-feature-secret-scoping.test.ts tests/worker-feature-secret-scoping.test.ts > ../../evidence/native-parallel-review8/sdk-focused-unit.log 2>&1
RELAYFLOWD_BIN="$HOME/.relayflows-toolchain/target/ms-step-secrets/debug/relayflowd" npx vitest run tests/authored-step-secrets-live.test.ts > ../../evidence/native-parallel-review8/sdk-secrets-live.log 2>&1
```

The final candidate and published-base identity checks ran from the worktree
root:

```sh
shasum -a 256 packages/sdk/dist/authored-flow-executor.js packages/sdk/dist/authored-flow-lifecycle.js packages/sdk/dist/authored-parallel-body.js packages/sdk/dist/authored-parallel-eligibility.js > evidence/native-parallel-review8/sdk-dist-hashes.log
docker run --rm --platform linux/arm64 -v ms-flows-parallel-r7:/w node:22-trixie sha256sum /w/sdk-head/dist/authored-flow-executor.js /w/sdk-head/dist/authored-flow-lifecycle.js /w/sdk-head/dist/authored-parallel-body.js /w/sdk-head/dist/authored-parallel-eligibility.js >> evidence/native-parallel-review8/sdk-dist-hashes.log
docker run --rm --platform linux/arm64 -v ms-flows-parallel-r7:/w node:22-trixie sh -c 'sha256sum /w/p2051/node_modules/@relayflows/sdk/dist/authored-root.js /w/sdk-base-2051/dist/authored-root.js /w/sdk-head/dist/authored-root.js; node -p "require(\"/w/p2051/node_modules/@relayflows/sdk/package.json\").version"; node -p "require(\"/w/p2051/node_modules/@relayflows/surface/package.json\").version"' > evidence/native-parallel-review8/published-2051-pin.log 2>&1
```
