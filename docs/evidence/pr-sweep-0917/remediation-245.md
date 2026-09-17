# PR #245 remediation — 2026-09-17

## Remote-head guard

Initial literal command:

```sh
git fetch origin main refs/pull/245/head && git ls-remote origin 'refs/pull/245/head'
```

Captured output:

```text
From github.com:AgentWorkforce/flows
 * branch              main       -> FETCH_HEAD
 * branch              refs/pull/245/head -> FETCH_HEAD
   c8c68315..45417541  main       -> origin/main
b88244113be0ca330b01871fdd0588ac483e5f59	refs/pull/245/head
```

Sweep-baseline lookup command:

```sh
rg -n --hidden --glob '!node_modules' 'PR #245|feat/ts-named-agents|b88244113be0ca330b01871fdd0588ac483e5f59' docs/evidence . 2>/dev/null || true
```

Captured matching sweep evidence:

```text
docs/evidence/pr-sweep-0917/inventory.md:30:| #245 | `b88244113be0ca330b01871fdd0588ac483e5f59` | khaliqgant | no | CONFLICTING | none | 0 | decision 13 authoring surface; **fix_required** (conflict; review FAILURE). |
```

The fetched remote head equals the sweep baseline: `b88244113be0ca330b01871fdd0588ac483e5f59`.

## Rebase

Literal command:

```sh
git rebase origin/main
```

Captured result:

```text
Rebasing (1/2)
CONFLICT (content): Merge conflict in packages/relayflows/package-lock.json
CONFLICT (content): Merge conflict in packages/relayflows/package.json
CONFLICT (content): Merge conflict in packages/runtime-darwin-arm64/package.json
CONFLICT (content): Merge conflict in packages/runtime-linux-x64/package.json
CONFLICT (content): Merge conflict in packages/sdk/package-lock.json
CONFLICT (content): Merge conflict in packages/sdk/package.json
CONFLICT (content): Merge conflict in packages/sdk/src/authored-flow-executor.ts
CONFLICT (content): Merge conflict in packages/sdk/src/cli/check.ts
CONFLICT (content): Merge conflict in packages/sdk/src/cli/direct-run.ts
CONFLICT (content): Merge conflict in packages/sdk/src/preflight.ts
CONFLICT (content): Merge conflict in packages/surface/package-lock.json
CONFLICT (content): Merge conflict in packages/surface/package.json
CONFLICT (content): Merge conflict in packages/surface/src/context.ts
CONFLICT (content): Merge conflict in packages/surface/src/flow.ts
```

Resolution retained current-main package versions and authored worker/preflight paths, then integrated the named-agent declaration map, per-step CLI/model overrides, up-front declaration preflight, and causal runtime diagnostics. Generated package locks were regenerated from the resolved manifests.

## Validation

Surface command (the package script first failed because `bun` is unavailable; this equivalent uses the installed Node tooling):

```sh
cd packages/surface && npm run build && npx tsc -p tsconfig.test.json && npx vitest run tests/flow.test.ts
```

Captured output:

```text
> @relayflows/surface@2.0.14 build
> tsc

 RUN  v2.1.9 /Volumes/Paris Drive/AgentWorkforce/.worktrees/flows-v2-lead-0913/pr-remediation-245/packages/surface

 ✓ tests/flow.test.ts (24 tests) 5ms

 Test Files  1 passed (1)
      Tests  24 passed (24)
```

SDK command:

```sh
cd packages/sdk && npm run build && npx vitest run tests/authored-named-agents.test.ts tests/authored-agent-failure.test.ts tests/direct-input.test.ts
```

Captured output:

```text
> @relayflows/sdk@2.0.14 build
> tsc && node scripts/make-cli-executable.mjs

 RUN  v2.1.9 /Volumes/Paris Drive/AgentWorkforce/.worktrees/flows-v2-lead-0913/pr-remediation-245/packages/sdk

 ✓ tests/authored-agent-failure.test.ts (5 tests) 5ms
 ✓ tests/authored-named-agents.test.ts (7 tests) 474ms
 ✓ tests/direct-input.test.ts (7 tests) 22781ms

 Test Files  3 passed (3)
      Tests  19 passed (19)
```

SDK typecheck command:

```sh
cd packages/sdk && npm run typecheck && npm run typecheck:tests
```

Captured output:

```text
> @relayflows/sdk@2.0.14 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json

> @relayflows/sdk@2.0.14 typecheck:tests
> tsc -p tsconfig.tests.json
```

The live named-agent suite is not green in this environment. Literal command:

```sh
cd packages/sdk && npx vitest run tests/live-named-agents.test.ts
```

Captured output:

```text
 RUN  v2.1.9 /Volumes/Paris Drive/AgentWorkforce/.worktrees/flows-v2-lead-0913/pr-remediation-245/packages/sdk

 FAIL  tests/live-named-agents.test.ts [ tests/live-named-agents.test.ts ]
Error: Build this checkout's daemon and set RELAYFLOWD_BIN to it: /Volumes/Paris Drive/AgentWorkforce/.worktrees/flows-v2-lead-0913/pr-remediation-245/kernel/target/debug/relayflowd

 Test Files  1 failed (1)
      Tests  1 skipped (1)
```

Its documented preparation command also cannot run because the environment has no Rust compiler:

```sh
cd packages/sdk && npm run test:prep
```

Captured output:

```text
> @relayflows/sdk@2.0.14 test:prep
> ( cd ../../kernel && sh ../ops/cargo.sh build ) && ( [ ! -d ../../testdata/preflight ] || find ../../testdata/preflight -name '*-cli' -type f -exec chmod +x {} + )

error: could not execute process `rustc -vV` (never executed)

Caused by:
  No such file or directory (os error 2)
```

Because this required affected suite is blocked and not green, this remediation must not update the remote PR branch.

## Final remote-head guard and update

Final literal command (run even though no push is allowed):

```sh
git fetch origin refs/pull/245/head && git ls-remote origin 'refs/pull/245/head' && git rev-parse HEAD && git status --short --branch
```

Captured output:

```text
From github.com:AgentWorkforce/flows
 * branch              refs/pull/245/head -> FETCH_HEAD
b88244113be0ca330b01871fdd0588ac483e5f59	refs/pull/245/head
2ea87580b5dd6cd1c7d420ce5961c0ccd6f5e97a
## feat/ts-named-agents...origin/feat/ts-named-agents [ahead 88, behind 2]
 M packages/sdk/src/authored-worker-step.ts
 M packages/sdk/src/cli/check-typescript.ts
 M packages/sdk/src/cli/check.ts
 M packages/sdk/src/preflight.ts
 M packages/surface/src/flow.ts
?? docs/evidence/pr-sweep-0917/
```

The remote PR head still equals the sweep head. The last committed local remediation SHA and exact branch head are `2ea87580b5dd6cd1c7d420ce5961c0ccd6f5e97a`. The worktree deliberately remains uncommitted and the remote branch was not updated: the required live named-agent suite is not green in this environment.
