# Parallel `f.run` review #5 verification

Base: `origin/main` at `5de41849` (Flows 2.0.51). The branch remained draft while these checks ran. All commands below used the rebased branch source; the Linux images copied the built `packages/sdk/dist` with a matching SHA-256 for `authored-parallel-eligibility.js` (`682ca6b984deaaaa23e916655688566d841821bc0622b676092abfe92f545634`).

## Build and focused Mac run

From `packages/sdk`:

```sh
npm run build
npm run typecheck
npm run typecheck:tests
RELAYFLOWD_BIN=/Users/khaliqgant/.relayflows-toolchain/target/ms-step-secrets/debug/relayflowd \
RELAYFLOWS_PREVIOUS_CLI='/Volumes/Paris Drive/AgentWorkforce/ms-sandboxes/native-selfhosted-measure-2026-10-16/node_modules/@relayflows/sdk/dist/cli.js' \
npx vitest run tests/authored-parallel-run-live.test.ts tests/authored-step-secrets-live.test.ts tests/authored-parallel-eligibility.test.ts tests/authored-flow-lifecycle-executor.test.ts tests/journal-client-step-env.test.ts
```

Captured output: [build-typecheck.log](build-typecheck.log), [mac-focused.log](mac-focused.log). The final lines were:

```text
Test Files  5 passed (5)
     Tests  88 passed (88)
```

The live suite includes six crash/resume repetitions each for P1, P1h, P1c, P1n, P1bn, P1b, and P2. It asserts serial mode and one copy of every completed effect. The secret test asserts parallel mode, a granted child receives the delivered token, and its ungranted sibling does not. The loopback test asserts an isolated peer refuses a withheld grant before `run.start`.

## Published 2.0.51 compatibility

The test names still say “2.0.50”, but this command supplied the published 2.0.51 CLI as the previous version:

```sh
RELAYFLOWD_BIN=/Users/khaliqgant/.relayflows-toolchain/target/ms-step-secrets/debug/relayflowd \
RELAYFLOWS_PREVIOUS_CLI='/Volumes/Paris Drive/AgentWorkforce/swarm/ms-flows-parallel/prior-2051/node_modules/@relayflows/sdk/dist/cli.js' \
npx vitest run tests/authored-parallel-run-live.test.ts -t '2.0.50'
```

Captured output: [mac-2051-compat.log](mac-2051-compat.log).

```text
Test Files  1 passed (1)
     Tests  7 passed | 30 skipped (37)
```

The selected cases cover previous-version resume after `run-4` and `run-5`, A1/B1/N2 legacy roots, and rollback refusal for a new parallel root followed by successful head resume.

## Linux x64 crash and upgrade runs

The image installed published `@relayflows/sdk`, `@relayflows/surface`, and `@relayflows/runtime-linux-x64` at 2.0.51, then copied the branch's built SDK `dist`. Commands from the worker workspace:

```sh
docker build --platform linux/amd64 -t ms-flows-parallel:review5 -f Dockerfile .
docker run --rm --platform linux/amd64 --init -e REPETITIONS=6 ms-flows-parallel:review5 node /bench/replay.mjs
docker build --platform linux/amd64 -t ms-flows-parallel:review5-upgrade -f Dockerfile.upgrade .
docker run --rm --platform linux/amd64 --init -e REPETITIONS=6 ms-flows-parallel:review5-upgrade node /bench/upgrade.mjs
```

The build context was `swarm/ms-flows-parallel/docker-review5`, with the branch's `packages/sdk/dist` and `package.json` copied in. The exact [Dockerfile](Dockerfile), [upgrade Dockerfile](Dockerfile.upgrade), [replay harness](replay.mjs), and [upgrade harness](upgrade.mjs) are copied here. Captured output: [linux-replay.log](linux-replay.log), [linux-upgrade.log](linux-upgrade.log). Their final lines were:

```text
{"done":true,"cases":10,"repetitions":6}
{"done":true,"cases":3,"repetitions":6}
```

The first matrix covers A1, B1, N2, eager work, race, any, dispatch, LLM, arguments-alias LLM, and agent branches (60/60); the second resumes 2.0.51 A1/B1/N2 roots under the branch (18/18). Each log records the effect letters before and after resume and fails the command on an extra effect or provider call.

## Mutation checks

Each check changed one production guard, ran its focused test, restored the source from a saved copy, verified the original SHA-256, and reran the same test. The exact test commands and captured outputs are below. `authored-parallel-eligibility.ts` restored to `94b2a8025319c42f86a6efb3436a71323e65491a3b44b415c9f15f1b16e411a1`; `authored-flow-executor.ts` restored to `c72b093a48111fea56615df35f9a695039e57ab00bc9c94d905fdcb13e6e50ce`.

| Guard temporarily changed | Command from `packages/sdk` | Captured failure and restored pass |
|---|---|---|
| Module-source check changed to `if (false && !moduleUsesIntrinsicPromise(moduleSource))` | `npx vitest run tests/authored-parallel-eligibility.test.ts -t 'requires the module Promise binding'` | [fail](mutation-f1-fail.log): `expected true to be false`; [pass](mutation-f1-pass.log): `1 passed` |
| Branch check changed from `return valid && runs > before` to `return valid` | `npx vitest run tests/authored-parallel-eligibility.test.ts -t 'keeps groups with empty async branches serial'` | [fail](mutation-f2-fail.log): `expected true to be false`; [pass](mutation-f2-pass.log): `1 passed` |
| Removed `if (parallelViolation !== undefined) throw parallelViolation` | `npx vitest run tests/authored-flow-lifecycle-executor.test.ts -t 'refuses later admissions after a caught parallel violation'` | [fail](mutation-f4-fail.log): one child admitted after refusal; [pass](mutation-f4-pass.log): `1 passed` |
| Removed the `predecessors.unregisteredAggregate` refusal | `npx vitest run tests/authored-flow-lifecycle-executor.test.ts -t 'refuses a parallel follow-up through an unobserved Promise.all'` | [fail](mutation-backstop-fail.log): refusal changed to `unawaited_step`; [pass](mutation-backstop-pass.log): `1 passed` |

The pre-existing serial LLM completion-order conflict, reproduced on released 2.0.50 and 2.0.51, is tracked separately in [#674](https://github.com/AgentWorkforce/flows/issues/674).
