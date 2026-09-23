# Parallel LLM lease fix: commands and captured output

Implementation commit: 78f7012.
The base commit is f6ece41d31e1908649c0b4540bfc53d189caaf7e.
The historical diagnosis is in ../parallel-llm-lease. Those old numbers are
not post-fix results. All links below are literal captured output, including
failures. Commands run from the repository root unless a different cwd is stated.

## Kernel and SDK checks

From packages/sdk:

| Literal command | Captured output |
| --- | --- |
| `npm run test:prep` | [prep.txt](prep.txt) |
| `npm run typecheck` | [typecheck-final.txt](typecheck-final.txt) |
| `npm run typecheck:tests` | [test-types-final.txt](test-types-final.txt) |
| `npm run build` | [build.txt](build.txt) |
| `npx vitest run tests/authored-parallel-llm.test.ts` | [regression-pass.txt](regression-pass.txt) |
| `npx vitest run tests/cli-probe.test.ts tests/authored-preflight.test.ts tests/communication-preflight.test.ts tests/bundle-preflight.test.ts tests/preflight.test.ts tests/cli.test.ts tests/authored-parallel-agents.test.ts tests/authored-parallel-llm.test.ts` | [final-focused.txt](final-focused.txt) |
| `npm test` | [sdk-suite.txt](sdk-suite.txt) |

The kernel build is a fixture prerequisite; no kernel code changed.
The complete SDK suite was attempted, not declared green. It includes environment
and fixture failures. To check one failing group on the unchanged base:

```sh
git worktree add --detach /tmp/flows-lease-baseline f6ece41d31e1908649c0b4540bfc53d189caaf7e
ln -s /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk/node_modules /tmp/flows-lease-baseline/packages/sdk/node_modules
cd /tmp/flows-lease-baseline/packages/sdk
npx vitest run tests/hosted-extension-isolation.test.ts
```

Output: [baseline-hosted.txt](baseline-hosted.txt). This reproduces 15 failures:
missing bubblewrap and missing local Surface build files. This comparison does
not establish the cause of every failure in the complete suite.

## Mutation verification

```sh
python evidence/parallel-llm-fix/mutate.py cache
python evidence/parallel-llm-fix/mutate.py async
```

[mutate.py](mutate.py) saves the selected source file as bytes, replaces exactly
the chosen implementation, captures the test failure, restores the saved bytes,
asserts equality, and reruns the same command. The commands and both complete
outputs are pasted in [mutations.md](mutations.md).

- Cache mutation: construct a fresh authored preflight for each call instead of
  sharing it. Both capacities run nine probes instead of one.
- Async mutation: route the async probe entry through the synchronous driver.
  Two 45-second cold models starve the durable root lease; the test fails with
  `lease_conflict: attempt has no active worker lease`.
- These protections overlap. With async probing retained, removing the cache
  does **not** expire child leases; the slow test fails its probe-count assertion.
  It would be false to claim cache-only removal causes expiry after Phase 2.

For the original child-lease failure, the new test was also copied to the
unchanged base worktree, with the existing kernel explicitly selected:

```sh
cp packages/sdk/tests/authored-parallel-llm.test.ts /tmp/flows-lease-baseline/packages/sdk/tests/authored-parallel-llm.test.ts
cd /tmp/flows-lease-baseline/packages/sdk
RELAYFLOWD_BIN=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd npx vitest run tests/authored-parallel-llm.test.ts -t 'parallel llm capacity 1.*completes nine'
```

Output: [baseline-child-lease.txt](baseline-child-lease.txt).

## Original diagnosis harness, rerun after the fix

```sh
cp evidence/parallel-llm-lease/diagnosis-harness.test.ts packages/sdk/tests/zz-scratch-repro.test.ts
cd packages/sdk
SCRATCH_PROBE_MS=4000 SCRATCH_CAP=1 npx vitest run tests/zz-scratch-repro.test.ts
rm tests/zz-scratch-repro.test.ts
```

Output: [diagnosis-post-fix.txt](diagnosis-post-fix.txt). Its identification
count includes the nine actual wrapper sessions; only one identify/auth round
is preflight. This scratch harness is historical instrumentation, not the
regression assertion; the committed tests discover every run journal from disk.

## Provider repro

```sh
git fetch origin feat/examples-prompt-lab
git worktree add --detach /tmp/flows-prompt-lab origin/feat/examples-prompt-lab
git -C /tmp/flows-prompt-lab merge --no-edit relayflow/flows-software-garden-860ae350
```

The fetched branch was 735f2e0. Merge refused unrelated histories:
[worktree-merge.txt](worktree-merge.txt). Instead the isolated example worktree
used this checkout's built CLI and dependencies:

```sh
ln -s /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk/node_modules /tmp/flows-prompt-lab/examples/prompt-lab/node_modules
cd /tmp/flows-prompt-lab/examples/prompt-lab
RELAYFLOWD_BIN=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd node /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk/dist/cli.js run evidence/runtime-findings/runtime-parallel-llm-repro.flow.ts --local-agent --agent-capacity 1 --input '{"n":1}' --data-dir /tmp/flows-verified-capacity1
RELAYFLOWD_BIN=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd node /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk/dist/cli.js run evidence/runtime-findings/runtime-parallel-llm-repro.flow.ts --local-agent --agent-capacity 4 --input '{"n":1}' --data-dir /tmp/flows-verified-capacity4
```

Outputs: [capacity 1](repro-final-capacity1.txt), [capacity 4](repro-final-capacity4.txt).
Earlier runs are also retained as repro-capacity1.txt and repro-capacity4.txt.

```sh
python evidence/parallel-llm-fix/scan-journals.py /tmp/flows-verified-capacity1 /tmp/flows-verified-capacity4
```

Output: [repro-final-journals.txt](repro-final-journals.txt). Every SQLite journal
is inspected, including the root and deterministic children.

## prompt-lab Promise.all restoration

[prompt-lab-parallel.patch](prompt-lab-parallel.patch) restores parallel calls
in runEngine and both previously serialized loops in new-agency. It is a
downstream verification patch, not a change to the example branch's history.

The example's existing proof script was copied to prove-fixed.sh with
`npx flows` replaced by this checkout's absolute `node .../dist/cli.js`
command. That exact script is preserved here. Run it from the example directory:

```sh
RELAYFLOWD_BIN=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd FLOWS_DATA_DIR=/tmp/flows-prompt-lab-data bash prove-fixed.sh /tmp/flows-prompt-lab-proof
```

Output: [prompt-lab.txt](prompt-lab.txt); full commands, model-step progress,
reviewer edit and resume failure: [prompt-lab-run/](prompt-lab-run/).
The parallel run produced a nine-row grid and reached both human gates, but
the final resume failed with `unawaited_step`. Therefore acceptance box 3
is **not fully verified**. No fix to that lifecycle failure is claimed here.

```sh
python evidence/parallel-llm-fix/scan-journals.py /tmp/flows-prompt-lab-data
```

Output: [prompt-lab-journals.txt](prompt-lab-journals.txt).

## Standalone packaging

```sh
node scripts/build-standalone-cli.mjs bun-linux-x64 /tmp/flows-parallel-fixed
```

Output: [standalone-build-final.txt](standalone-build-final.txt). The same build
command in the base worktree, with outfile /tmp/flows-parallel-base, is captured
in [standalone-baseline-build.txt](standalone-baseline-build.txt).

From the example directory, smoke commands:

```sh
RELAYFLOWD_BIN=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd /tmp/flows-parallel-fixed run evidence/runtime-findings/runtime-parallel-llm-repro.flow.ts --local-agent --agent-capacity 4 --input '{"n":1}' --data-dir /tmp/flows-final-repro-capacity4
RELAYFLOWD_BIN=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd /tmp/flows-parallel-base run evidence/runtime-findings/runtime-parallel-llm-repro.flow.ts --local-agent --agent-capacity 4 --input '{"n":1}' --data-dir /tmp/flows-base-standalone-data
```

Both refuse importing the authored flow: [changed](standalone-smoke.txt),
[base](standalone-baseline-smoke.txt). Build success is not a claim of standalone
runtime success. The Node CLI provider repro above is separate.

## Intermediate checks retained for transparency

regression.txt has the initial test's wrong journal-count expectation (it omitted
the deterministic f.done child). related.txt records the initial async signal
classification failure, fixed before related-pass.txt. Their commands were,
respectively, the regression command above and:

```sh
npx vitest run tests/cli-probe.test.ts tests/preflight.test.ts tests/cli.test.ts tests/authored-parallel-agents.test.ts tests/communication-environment-preflight.test.ts
```

static-refusals.txt used:

```sh
npx vitest run tests/authored-preflight.test.ts tests/cli-probe.test.ts tests/preflight.test.ts
```

Authentication material is not included. claude-auth.txt contains only the
output of:

```sh
claude auth status | python -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({k:d.get(k) for k in ("loggedIn","authMethod")}))'
```

Captured stdout/stderr and patch files retain tool-generated whitespace verbatim.
