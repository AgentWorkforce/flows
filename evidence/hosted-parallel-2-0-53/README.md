# Hosted parallel `f.run` repair (2026-10-18)

## Cause

The 2.0.52 standalone CLI is compiled with Bun. Bun reformats the authored
body's `Function.prototype.toString()` result: it changes whitespace and quote
style and can combine adjacent `const` declarations. Parallel admission
compared that string byte-for-byte with the original `.flow.ts` body, so a
source-faithful hosted flow was pinned to `executionMode: serial`. The npm
Node CLI kept the original function text and admitted the same flow as parallel.

After source admission was repaired, the standalone result verifier exposed a
second blocker. It required the numeric suffixes of all child IDs to be a
single `1..N` sequence. Parallel IDs use an ordinal **per causal predecessor**,
so three valid dependent runs can all end in `-1`. The verifier rejected their
durable success as `authored runtime result has no matching durable completion`.

## Repair and safety checks

- Bun admits parallel only from a closed, parsed, hash-pinned source module.
  Its in-memory body never executes: the embedded Node runner loads the pinned
  source. The Node CLI retains exact function/source identity comparison.
- Before any parallel child starts, the Node runner independently verifies the
  pinned source hash, closed module grammar, and Node-loaded body grammar.
  The executor still checks Promise and Array intrinsics before execution.
- For a parallel result, the standalone verifier compares every claimed child
  against the root's durable `authored-steps` index, requires no unclaimed or
  unfinished child, and then reads every child journal and completion marker.
  Serial roots retain their global ordinal check.
- Set `FLOWS_PARALLEL_DEBUG=1` on the CLI to log why a new root selected serial
  mode (`source_graph`, `extensions`, `shared_budget`, `runtime_intrinsics`, or
  `source_certificate`). The reason is deliberately not stored in root
  metadata: changing a 2.0.52 root's admission spec hash could disrupt an
  in-flight resume after upgrade.

## Source reproduction

The exact hosted-reported shape is [hosted-repro.flow.ts](hosted-repro.flow.ts).
These commands ran from `/tmp/hv52`, which contained that source and the
published 2.0.52 Surface package:

```sh
bun -e "import handle from './par.flow.ts'; import {getFlowDefinition} from '@relayflows/surface/runtime'; console.log(Function.prototype.toString.call(getFlowDefinition(handle).body));"
node --experimental-strip-types --input-type=module -e "import handle from './par.flow.ts'; import {getFlowDefinition} from '@relayflows/surface/runtime'; console.log(Function.prototype.toString.call(getFlowDefinition(handle).body));"
```

Captured complete outputs: [Bun](logs/bun-function-source.txt),
[Node](logs/node-function-source.txt), and their [literal diff](logs/function-source-diff.txt).
The old byte-for-byte body comparison fails on that diff; the parser unit test
also asserts that the Node path still refuses a mismatched in-memory body.

## Final-build checks

Commands ran from `packages/sdk` at the final source tree. Each link is the
complete captured stdout/stderr for the adjacent literal command (all exited 0):

| Command | Captured output |
| --- | --- |
| `npm run typecheck` | [typecheck.txt](logs/typecheck.txt) |
| `npm run build` | [build.txt](logs/build.txt) |
| `npm run typecheck:tests` | [typecheck-tests.txt](logs/typecheck-tests.txt) |
| `./node_modules/.bin/vitest run tests/authored-root.test.ts tests/authored-parallel-body.test.ts tests/authored-parallel-eligibility.test.ts tests/authored-node-result.test.ts --pool=forks --maxWorkers=2 --minWorkers=1` | [focused-tests.txt](logs/focused-tests.txt) |
| `PATH=/tmp/ms-flows-parallel-node22/node_modules/node-bin-darwin-arm64/bin:$PATH RELAYFLOWD_BIN=/tmp/hv52/node_modules/@relayflows/runtime-darwin-arm64/bin/relayflowd /tmp/ms-flows-parallel-node22/node_modules/node-bin-darwin-arm64/bin/node ./node_modules/vitest/vitest.mjs run tests/authored-node-runtime.test.ts -t 'runs a certified Promise.all group' --pool=forks --maxWorkers=1 --minWorkers=1` | [standalone-parallel.txt](logs/standalone-parallel.txt) |
| `PATH=/tmp/ms-flows-parallel-node22/node_modules/node-bin-darwin-arm64/bin:$PATH RELAYFLOWD_BIN=/tmp/hv52/node_modules/@relayflows/runtime-darwin-arm64/bin/relayflowd /tmp/ms-flows-parallel-node22/node_modules/node-bin-darwin-arm64/bin/node ./node_modules/vitest/vitest.mjs run tests/authored-node-runtime.test.ts -t 'awaits agent plus three run steps' --pool=forks --maxWorkers=1 --minWorkers=1` | [standalone-serial.txt](logs/standalone-serial.txt) |

The parallel live test builds the standalone CLI, checks parallel root metadata,
proves all three route starts precede the first route end, and checks the
dependents and join. The serial case includes a completed-root resume with no
repeated effects. The verifier unit test accepts repeated causal `-1` suffixes
and refuses mismatched or extra root-index records.

## Manual standalone journal

The final standalone binary was built with this command from the repo root;
its complete output is [standalone-build.txt](logs/standalone-build.txt):

```sh
node scripts/build-standalone-cli.mjs bun-darwin-arm64 /tmp/ms-flows-parallel-hosted/flows
```

The CLI commands below ran from a fixture with the published 2.0.52 Surface
package, the copied [source](hosted-repro.flow.ts), published 2.0.52 daemon,
and Node 22.16.0 embedded runner. The inspector commands ran from the repo root:

```sh
FLOWS_AUTHORED_NODE=/tmp/ms-flows-parallel-node22/node_modules/node-bin-darwin-arm64/bin/node RELAYFLOWD_BIN=/tmp/hv52/node_modules/@relayflows/runtime-darwin-arm64/bin/relayflowd /tmp/ms-flows-parallel-hosted/flows run par.flow.ts --data-dir /tmp/ms-flows-parallel-hosted/data6 --json --no-observer-link --input '{}'
python3 evidence/hosted-parallel-2-0-53/inspect-journal.py /tmp/ms-flows-parallel-hosted/data6 01M57SMB30E9AD784XVP5T2X9S
FLOWS_AUTHORED_NODE=/tmp/ms-flows-parallel-node22/node_modules/node-bin-darwin-arm64/bin/node RELAYFLOWD_BIN=/tmp/hv52/node_modules/@relayflows/runtime-darwin-arm64/bin/relayflowd /tmp/ms-flows-parallel-hosted/flows resume 01M57SMB30E9AD784XVP5T2X9S --data-dir /tmp/ms-flows-parallel-hosted/data6 --json --no-observer-link
python3 evidence/hosted-parallel-2-0-53/inspect-journal.py /tmp/ms-flows-parallel-hosted/data6 01M57SMB30E9AD784XVP5T2X9S
```

Captured outputs: [run](logs/manual-run.txt),
[journal](logs/manual-journal.txt), [resume](logs/manual-resume.txt), and
[journal after resume](logs/manual-journal-after-resume.txt). The two journal
outputs are identical:

```text
root executionMode: parallel
run-1: started=1792336867426 ended=1792336869451
run-2: started=1792336867424 ended=1792336869450
run-3: started=1792336867422 ended=1792336869450
route start spread ms: 4
all routes overlapped: True
run journals: 9 attempt starts: 9
```
