# PR #134 authored lifecycle repair evidence

This evidence was captured in `flows-132-surface-wt` while repairing the three
P1 lifecycle escapes reported against `5f2c0b9a`. Review reports and gate
scripts were not edited.

## Red-first reproduction

The exact native-resolver, ignored-assimilation, ignored-combinator,
swallowed-callback, and forged-source cases were first committed as
`b89eef8 test(surface): reproduce authored lifecycle escapes`.

```text
$ ./node_modules/.bin/vitest run tests/authored-flow-operation.test.ts --reporter=verbose --maxWorkers=1 --minWorkers=1
Test Files  1 failed (1)
Tests  15 failed (15)
```

All five cases failed for each of `run`, `llm`, and `agent` because the old
implementation resolved instead of returning the expected typed rejection.

## Focused source and type evidence

```text
$ ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run tests/authored-flow-operation.test.ts tests/authored-flow-lifecycle-executor.test.ts tests/authored-flow.test.ts --reporter=verbose --maxWorkers=1 --minWorkers=1
Test Files  3 passed (3)
Tests  38 passed (38)
```

The focused cases prove typed refusal for all three primitive families, no
terminal `complete-*` start through the journal executor, retained root and
nested callback failures, isolation of concurrent lifecycle scopes, and green
direct `await`, `Promise.resolve`, and direct/wrapped `Promise.all` paths.

```text
$ (cd surface && bun run build && bun run test && bun run typecheck:regressions)
Test Files  1 passed (1)
Tests  6 passed (6)
```

## Packed artifact evidence

`bash scripts/surface-package-gate.sh` completed its surface build, six tests,
regression typecheck, and tarball creation, then the environment's
`npm ci --prefix sdk --ignore-scripts` produced no output for more than 60
seconds and was interrupted. The artifacts were therefore packed directly
from the already-installed, typechecked worktree and exercised in a clean
temporary consumer:

```text
7a9d98c9fef8ec34f7562f1efcc72e6e6b3019ed  relayflows-sdk-0.1.0.tgz
da4e66ca062eb34e06d7adccb1a2a4c358f42275  relayflows-surface-0.1.0.tgz
PACKED_EXECUTOR_REFUSAL name=packed-native-resolver code=unawaited_step terminal=absent
PACKED_EXECUTOR_REFUSAL name=packed-ignored-resolve code=unawaited_step terminal=absent
PACKED_EXECUTOR_REFUSAL name=packed-ignored-all code=unawaited_step terminal=absent
PACKED_EXECUTOR_REFUSAL name=packed-nested-callback code=operation_callback_failed terminal=absent
PACKED_EXECUTOR_REFUSAL name=packed-forged-source code=unawaited_step terminal=absent
PACKED_EXECUTOR_GREEN direct-await=pass promise-resolve=pass promise-all=pass
PACKED_PRIMITIVE_REFUSAL verb=run native-resolver=refused ignored-resolve=refused ignored-all=refused
PACKED_PRIMITIVE_REFUSAL verb=llm native-resolver=refused ignored-resolve=refused ignored-all=refused
PACKED_PRIMITIVE_REFUSAL verb=agent native-resolver=refused ignored-resolve=refused ignored-all=refused
```

## Live daemon evidence

The built SDK executor was exercised against
`/Users/khaliqgant/.relayflows-toolchain/target/1914866954/debug/relayflowd`.

```text
LIVE_EXECUTOR_REFUSAL name=live-native-resolver code=unawaited_step terminal=absent
LIVE_EXECUTOR_REFUSAL name=live-ignored-resolve code=unawaited_step terminal=absent
LIVE_EXECUTOR_REFUSAL name=live-ignored-all code=unawaited_step terminal=absent
LIVE_EXECUTOR_REFUSAL name=live-nested-callback code=operation_callback_failed terminal=absent
LIVE_EXECUTOR_REFUSAL name=live-forged-source code=unawaited_step terminal=absent
LIVE_EXECUTOR_GREEN name=live-supported-awaits completion=success steps=5
```

## Full SDK regression evidence

```text
$ RELAYFLOWD_BIN=/Users/khaliqgant/.relayflows-toolchain/target/1914866954/debug/relayflowd RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 ./node_modules/.bin/vitest run --reporter=dot --maxWorkers=1 --minWorkers=1
Test Files  20 passed (20)
Tests  275 passed (275)
Duration  75.27s
```

The run reported `SKIPPED_UNACTIONABLE=0`, executed the live Claude analyzer
round trip, and completed the real-daemon crash/resume case.
