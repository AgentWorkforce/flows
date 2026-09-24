# #561 verification commands and captured output

Commands ran from the repository root unless a `cd` is shown. Output files are literal stdout/stderr captures, not rewritten summaries. The initial pre-fix tests were committed in `7533229`; the fix and corrected assertions are in `55caf19`. The first baseline predates the corrected journal entry spelling and timing headroom; the mutation transcript uses the final assertions.

## Regression and mutation

For `baseline.txt`, `fixed.txt`, `mutation-red.txt`, and `mutation-green.txt`:

```sh
cd packages/sdk
RELAYFLOWD_BIN=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd npx vitest run tests/authored-probe-cache.test.ts
```

[Baseline](baseline.txt), [fixed](fixed.txt), [mutation failure](mutation-red.txt), [restored pass](mutation-green.txt).

To reproduce the mutation from the fixed checkout:

```sh
git apply evidence/561/mutation.patch
# Run the regression command above (exit 1).
git restore -- packages/sdk/src/authored-worker-step.ts
git diff --exit-code -- packages/sdk/src/authored-worker-step.ts
# Run the regression command above again (exit 0).
```

The mutation removes only the fifth `checkAuthoredFlow` argument, as captured in [mutation.patch](mutation.patch). After the failure, `git restore -- packages/sdk/src/authored-worker-step.ts` restores the committed bytes. [restore.txt](restore.txt) captures `git diff --exit-code` and the SHA-256 comparison with HEAD.

The spread bound allows one 300 ms synchronous probe plus process startup under load (1,000 ms total); the original nine probes take over 3 seconds. Exact auth and identify-only counts additionally pin the cache independently of timing. Worker identification sessions are counted separately from preflight probes. Tests also cover failures, agents, run isolation, capacity, and every child journal.

## Broader checks

```sh
cd packages/sdk
npm test
```

[sdk-suite.txt](sdk-suite.txt) is the full output, including failures. It includes production and existing test typechecks and the SDK build. It is **not green**. No gates or existing tests were weakened to accommodate this environment.

```sh
cd kernel
sh ../ops/cargo.sh test
```

[kernel.txt](kernel.txt) contains the full kernel result.

```sh
cd packages/sdk
npm run typecheck
```

[typecheck.txt](typecheck.txt).

```sh
cd packages/sdk
npx vitest run tests/preflight-run-cache.test.ts
```

[cache-keys.txt](cache-keys.txt).

## Live reproduction

The [repro source](runtime-parallel-llm-repro.flow.ts) is copied verbatim from `origin/feat/examples-prompt-lab:examples/prompt-lab/evidence/runtime-findings/runtime-parallel-llm-repro.flow.ts`. Adjacent `flows.json` chooses Claude and allows its declared model; `package.json` declares ESM.

```sh
RELAYFLOWD_BIN=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd node packages/sdk/dist/cli.js run --local-agent --no-observer-link --data-dir /tmp/flows-561-live-default evidence/561/runtime-parallel-llm-repro.flow.ts --input '{"n":3}'
RELAYFLOWD_BIN=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd node packages/sdk/dist/cli.js run --local-agent --agent-capacity 1 --no-observer-link --data-dir /tmp/flows-561-live-one evidence/561/runtime-parallel-llm-repro.flow.ts --input '{"n":3}'
python3 evidence/561/check-live-journals.py
```

[Default capacity](live-default.txt), [capacity 1](live-one.txt), [journal assertions and outputs](live-journals.txt). Both CLI invocations exited 0. Journals live in the named `/tmp` directories in this environment; they are not committed. Reproduction needs authenticated Claude. `npm run build` in `packages/sdk` regenerates `dist` if the test runner has pruned it.

```sh
python3 - <<'PY'
from pathlib import Path
for p in ['examples/prompt-lab/jobs/shared.ts', 'examples/prompt-lab/jobs/new-agency.ts']:
    print(p + ': ' + ('present' if Path(p).exists() else 'absent'))
PY
```

[prompt-lab.txt](prompt-lab.txt) records why the example restoration remains open.

## Typecheck the new regression files

```sh
cd packages/sdk
npx tsc -p ../../evidence/561/tsconfig.tests.json
```

[regression-typecheck.txt](regression-typecheck.txt) captures output and exit status. This separate config includes the new tests without changing the repository's check configuration.
