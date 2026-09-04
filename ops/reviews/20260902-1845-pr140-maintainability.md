# PR #140 maintainability / adversarial-test review

- Review time: 2026-09-02 18:45 CEST assignment, executed 2026-09-02
- Submitted head: `2a98a3779e86df53fef6632d2adec59893b8f753`
- Submitted stacked base: PR #134 / `7266c5134c01151c28c7cc412380b2c0ee6b3dfe`
- Current remote base branch: `5092b76decca1530aaf6be0f81897945f9143ce5`
- Lens: maintainability, API/type honesty, fail-closed behavior, load-bearing tests
- Verdict: **FAIL**

The happy path is real: a direct-input flow reaches a real `relayflowd`, its
deterministic step and run completion are journaled, and both carry
`completionReason: success`. Missing, malformed, empty, unreadable, and
non-regular input is refused before daemon contact; the packed surface contains
the generic input declarations; and the focused 55-test slice passes.

The PR is nevertheless not mergeable. Its compile-by-executing-author-code
design permits unjournaled effects before the daemon is contacted and silently
chooses output-dependent branches that it claims to reject. Unknown header
fields are dropped before the compiler can reject them, and `f.done` is not
required. The feature tests do not cover these paths and are not invoked by
either exact-head GitHub check. Finally, the stacked base has advanced to a new
journal-backed executor and the submitted head now conflicts with that base;
the direct-input path must be reconciled with that executor, not mechanically
rebased as a parallel execution architecture.

## Findings

### F1 — P1 — authored code can make unjournaled effects before daemon contact

`compileAuthoredFlow()` imports the module and then calls
`definition.body(recorder.context, input)` at
`sdk/src/authored-flow-compiler.ts:31-67`. Only calls made through the fake
`Ctx` are recorded. Ordinary JavaScript in the module or body is executed in
the CLI process before `executeCheckedFlow()` creates/connects the
`JournalClient` (`sdk/src/cli/run.ts:84-96`). That lets a valid-input invocation
mutate the filesystem even when no daemon exists and no run/journal is ever
created. It contradicts RFC-0001's journal boundary and effect attribution
contract.

Probe source:

```text
$ sed -n '1,120p' /tmp/pr140-maint-review.Hjcc9v/side-effect.flow.mjs
import { writeFileSync } from 'node:fs';
import { flow } from 'file:///Users/khaliqgant/AgentWorkforce/flows-132-direct-input-wt/surface/dist/index.js';

export default flow('side-effect-before-journal', {}, async (f, input) => {
  writeFileSync(input.marker, 'UNJOURNALED_SIDE_EFFECT');
  await f.run('printf journaled-step');
  f.done('success');
});
```

Literal pre-daemon control:

```text
$ review_tmp=/tmp/pr140-maint-review.Hjcc9v
$ marker_path=$review_tmp/marker-fresh.txt
$ if test -e "$marker_path"; then printf 'MARKER_BEFORE=yes\n'; else printf 'MARKER_BEFORE=no\n'; fi
$ node sdk/dist/cli.js run "$review_tmp/side-effect.flow.mjs" --input "{\"marker\":\"$marker_path\"}" --data-dir "$review_tmp/fresh-absent-daemon"
$ cli_status=$?
$ printf 'CLI_EXIT=%s\n' "$cli_status"
$ if test -f "$marker_path"; then printf 'MARKER_AFTER=yes\nMARKER_CONTENT='; sed -n '1p' "$marker_path"; else printf 'MARKER_AFTER=no\n'; fi
MARKER_BEFORE=no
WARNING [unprovable_effects] Step "run-1" command "printf" resolves, but its effects cannot be proven before execution.
REFUSED [daemon_unreachable] No compatible relayflowd is listening at "/tmp/pr140-maint-review.Hjcc9v/fresh-absent-daemon/relayflowd.sock". Start it with: relayflowd --data-dir "/tmp/pr140-maint-review.Hjcc9v/fresh-absent-daemon" serve
CLI_EXIT=2
MARKER_AFTER=yes
MARKER_CONTENT=UNJOURNALED_SIDE_EFFECT
```

Required repair: direct input must run through the base's real
`executeAuthoredFlow`/journal-backed context (or an equivalent journal-owned
execution seam). Do not invoke an arbitrary authored body as a speculative
compiler pass.

### F2 — P1 — output-dependent control flow fails open

The implementation promises that output-dependent control flow is refused.
The placeholder proxy can trap property access and coercion, but JavaScript
truthiness and strict identity comparison are not proxy traps. A step result is
an object placeholder, so `if (output)` silently compiles the true branch even
though the real runtime value is not known. The resulting spec is semantically
different from the authored program.

```text
$ sed -n '1,120p' /tmp/pr140-maint-review.Hjcc9v/truthy-output.flow.mjs
import { flow } from 'file:///Users/khaliqgant/AgentWorkforce/flows-132-direct-input-wt/surface/dist/index.js';

export default flow('truthy-output', {}, async (f) => {
  const output = await f.run('printf runtime-output');
  if (output) {
    await f.run('printf true-branch');
  } else {
    await f.run('printf false-branch');
  }
  f.done('success');
});

$ node --input-type=module -e "import { compileAuthoredFlow } from './sdk/dist/authored-flow-compiler.js'; const spec = await compileAuthoredFlow('/tmp/pr140-maint-review.Hjcc9v/truthy-output.flow.mjs', {}); console.log(JSON.stringify(spec.steps.map(({id, command, dependsOn}) => ({id, command, dependsOn})), null, 2));"
[
  {
    "id": "run-1",
    "command": "printf runtime-output",
    "dependsOn": []
  },
  {
    "id": "run-2",
    "command": "printf true-branch",
    "dependsOn": [
      "run-1"
    ]
  }
]
EXIT 0
```

The existing negative test only interpolates the placeholder, which invokes
`Symbol.toPrimitive`; it does not cover truthiness or strict comparison.
Because this failure cannot be fixed completely with a proxy, the speculative
recording architecture should be removed rather than extended with more traps.

### F3 — P1 — the submitted stack is conflicting and targets the superseded execution seam

PR #134 advanced after this head was cut. The current base adds
`sdk/src/authored-flow-executor.ts` and `executeAuthoredFlow`; PR #140 instead
adds a sibling `authored-flow-compiler.ts` and routes the CLI through it. There
are content conflicts in the public surface and tests, and GitHub reports the
PR as `DIRTY` / `CONFLICTING`. This is architectural reconciliation work, not a
safe conflict-only rebase.

```text
$ git rev-parse HEAD origin/feat/v2-direct-input origin/feat/v2-surface-package
$ git merge-base HEAD origin/feat/v2-surface-package
$ git merge-tree --write-tree HEAD origin/feat/v2-surface-package
2a98a3779e86df53fef6632d2adec59893b8f753
2a98a3779e86df53fef6632d2adec59893b8f753
5092b76decca1530aaf6be0f81897945f9143ce5
7266c5134c01151c28c7cc412380b2c0ee6b3dfe
7420dbffec3bc3eb0e81013128ad6c771c9d13c5
100644 cf3f5cb0e4d243eab7c37b71af373e4f80205ea5 1 sdk/tests/authored-flow.test.ts
100644 ef20b6845aaacca7f02b479e8d2c5994204b0da7 2 sdk/tests/authored-flow.test.ts
100644 b197ebed08df4535ced7311fcf2828d9675b2889 3 sdk/tests/authored-flow.test.ts
100644 a3018f92d750d8ff4e4e19c20fb97de21a091184 1 surface/README.md
100644 be5701b0e84623c572a79fd604bcff13be5142c0 2 surface/README.md
100644 f56bda555709cb48c3ef3db0691e0c6a35c01cb1 3 surface/README.md
100644 560117268eff548a471ef3d2c6d034ecab630f8a 1 surface/src/flow.ts
100644 4b199341d2479e62b1c277df8f3b90a14fe07389 2 surface/src/flow.ts
100644 d809e87e8b816799e6ef2fae26475283093f507e 3 surface/src/flow.ts

Auto-merging docs/SURFACE.md
Auto-merging sdk/tests/authored-flow.test.ts
CONFLICT (content): Merge conflict in sdk/tests/authored-flow.test.ts
Auto-merging surface/README.md
CONFLICT (content): Merge conflict in surface/README.md
Auto-merging surface/src/flow.ts
CONFLICT (content): Merge conflict in surface/src/flow.ts
Auto-merging surface/tests/flow.test.ts
EXIT 1
```

```text
$ git ls-tree -r --name-only HEAD sdk/src | rg 'authored-flow-(compiler|executor)\.ts'
sdk/src/authored-flow-compiler.ts
$ git ls-tree -r --name-only origin/feat/v2-surface-package sdk/src | rg 'authored-flow-(compiler|executor)\.ts'
sdk/src/authored-flow-executor.ts
$ git grep -n 'compileAuthoredFlow\|executeAuthoredFlow' HEAD -- sdk/src
HEAD:sdk/src/authored-flow-compiler.ts:23:export async function compileAuthoredFlow(path: string, input: unknown): Promise<FlowSpec> {
HEAD:sdk/src/cli/run.ts:2:import { compileAuthoredFlow, AuthoredFlowCompileError } from '../authored-flow-compiler.js';
HEAD:sdk/src/cli/run.ts:89:    const flow = await compileAuthoredFlow(path, input);
$ git grep -n 'compileAuthoredFlow\|executeAuthoredFlow' origin/feat/v2-surface-package -- sdk/src
origin/feat/v2-surface-package:sdk/src/authored-flow-executor.ts:75:export async function executeAuthoredFlow(
origin/feat/v2-surface-package:sdk/src/authored-flow.ts:11: * flow. `executeAuthoredFlow` owns the initial journal-backed context; callers
origin/feat/v2-surface-package:sdk/src/index.ts:58:  executeAuthoredFlow,
```

### F4 — P2 — fail-closed header and completion claims are not true

The surface's `freezeHeader()` reconstructs only known fields. Consequently a
JavaScript/`as any` typo such as `identitty` is removed before
`compileAuthoredFlow()` calls `Object.keys(definition.header)`, so direct run
continues to daemon connection instead of returning the promised unsupported
header refusal.

```text
$ sed -n '1,120p' /tmp/pr140-maint-review.Hjcc9v/unknown-header.flow.mjs
import { flow } from 'file:///Users/khaliqgant/AgentWorkforce/flows-132-direct-input-wt/surface/dist/index.js';

export default flow('unknown-header', { identitty: 'typo' }, async (f) => {
  await f.run('printf header-accepted');
  f.done('success');
});
$ node sdk/dist/cli.js run /tmp/pr140-maint-review.Hjcc9v/unknown-header.flow.mjs --input '{}' --data-dir /tmp/pr140-maint-review.Hjcc9v/header-absent-daemon
WARNING [unprovable_effects] Step "run-1" command "printf" resolves, but its effects cannot be proven before execution.
REFUSED [daemon_unreachable] No compatible relayflowd is listening at "/tmp/pr140-maint-review.Hjcc9v/header-absent-daemon/relayflowd.sock". Start it with: relayflowd --data-dir "/tmp/pr140-maint-review.Hjcc9v/header-absent-daemon" serve
CLI_EXIT=2
```

The compiler also tracks whether `done()` was called only to reject later
steps; it never requires terminal completion. A flow with no `f.done(...)`
compiles successfully. The advanced base's executor explicitly has a
`missing_completion` failure, so this must be preserved when input is rebased.

```text
$ sed -n '1,120p' /tmp/pr140-maint-review.Hjcc9v/no-done.flow.mjs
import { flow } from 'file:///Users/khaliqgant/AgentWorkforce/flows-132-direct-input-wt/surface/dist/index.js';

export default flow('no-done', {}, async (f) => {
  await f.run('printf no-done');
});
$ node --input-type=module -e "import { compileAuthoredFlow } from './sdk/dist/authored-flow-compiler.js'; const spec = await compileAuthoredFlow('/tmp/pr140-maint-review.Hjcc9v/no-done.flow.mjs', {}); console.log(JSON.stringify(spec));"
{"version":"0.1.0","name":"no-done","steps":[{"id":"run-1","type":"deterministic","dependsOn":[],"maxIterations":1,"command":"printf no-done","verification":{"type":"exit_code"}}]}
EXIT 0
```

### F5 — P2 — feature tests are green but are not load-bearing in CI

The focused tests pass, but neither exact-head workflow invokes
`authored-flow-compiler.test.ts` or `direct-input.test.ts`. The cloud artifact
workflow builds the CLI and smoke-checks a YAML flow; the packed-consumer gate
runs only `sdk/tests/authored-flow.test.ts`. Therefore both P1 behaviors above
can land behind green `linux-x64-artifact` and `packed-consumer` checks.

```text
$ rg -n 'direct-input|authored-flow-compiler' .github/workflows scripts || true
$ rg -n 'vitest|tsc|typecheck' .github/workflows/cloud-runtime-artifact.yml .github/workflows/surface-package.yml scripts/surface-package-gate.sh
scripts/surface-package-gate.sh:13:bun run typecheck:regressions
scripts/surface-package-gate.sh:86:cat > tsconfig.consumer.json <<'JSON'
scripts/surface-package-gate.sh:101:"$repo_root/surface/node_modules/.bin/tsc" -p tsconfig.consumer.json
scripts/surface-package-gate.sh:109:surface/node_modules/.bin/vitest run sdk/tests/authored-flow.test.ts --root "$repo_root"
```

```text
$ ./node_modules/.bin/vitest run tests/authored-flow-compiler.test.ts tests/direct-input.test.ts tests/cli.test.ts

 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-132-direct-input-wt/sdk

 ✓ tests/authored-flow-compiler.test.ts (3 tests) 471ms
 ✓ tests/cli.test.ts (50 tests) 3073ms
 ✓ tests/direct-input.test.ts (2 tests) 4749ms
   ✓ direct .flow.ts input through the built CLI and live runtime > executes inline and file JSON input through relayflowd 2827ms
   ✓ direct .flow.ts input through the built CLI and live runtime > refuses missing and malformed input before contacting relayflowd 1919ms

 Test Files  3 passed (3)
      Tests  55 passed (55)
   Start at  19:12:40
   Duration  6.76s (transform 1.77s, setup 0ms, collect 3.15s, tests 8.29s, environment 4ms, prepare 1.38s)

EXIT 0
```

The broad SDK suite is not green at this head. Its single failed suite is an
inherited base defect (`statSync` is used but not imported); PR #140 does not
touch that file, so it is disclosed rather than attributed to this diff.

```text
$ RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 ./node_modules/.bin/vitest run --reporter=dot --maxWorkers=1 --minWorkers=1
 FAIL  tests/live-kernel.test.ts [ tests/live-kernel.test.ts ]
ReferenceError: statSync is not defined
 ❯ tests/live-kernel.test.ts:55:37
     53|         .map((entry) => join(TOOLCHAIN_TARGET, entry, 'debug', 'relayf…
     54|         .filter((candidate) => existsSync(candidate))
     55|         .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
       |                                     ^

 Test Files  1 failed | 19 passed (20)
      Tests  226 passed (226)
   Start at  19:16:53
   Duration  199.33s (transform 7.89s, setup 0ms, collect 15.04s, tests 73.66s, environment 90ms, prepare 26.94s)
EXIT 1

$ git diff --quiet 7266c5134c01151c28c7cc412380b2c0ee6b3dfe..2a98a3779e86df53fef6632d2adec59893b8f753 -- sdk/tests/live-kernel.test.ts; printf 'PR_DIFF_TOUCHES_LIVE_KERNEL=%s\n' "$?"
PR_DIFF_TOUCHES_LIVE_KERNEL=0
```

### F6 — P2 — file input is synchronously and unboundedly materialized

`parseDirectInput()` uses `readFileSync(..., 'utf8')` followed by `JSON.parse`
with no size gate. A 33,554,443-byte file was accepted and fully parsed before
daemon refusal. This is acceptable for the happy-path proof but is an
unbounded memory/latency surface for a CLI intended to fail closed. Add and test
an explicit supported maximum, preferably before allocating the string.

```text
$ node -e "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({blob:'x'.repeat(32*1024*1024)}))" /tmp/pr140-maint-review.Hjcc9v/large.json
$ wc -c /tmp/pr140-maint-review.Hjcc9v/large.json
$ /usr/bin/time -p node sdk/dist/cli.js run /tmp/pr140-maint-review.Hjcc9v/simple.flow.mjs --input /tmp/pr140-maint-review.Hjcc9v/large.json --data-dir /tmp/pr140-maint-review.Hjcc9v/large-no-daemon
 33554443 /tmp/pr140-maint-review.Hjcc9v/large.json
WARNING [unprovable_effects] Step "run-1" command "printf" resolves, but its effects cannot be proven before execution.
REFUSED [daemon_unreachable] No compatible relayflowd is listening at "/tmp/pr140-maint-review.Hjcc9v/large-no-daemon/relayflowd.sock". Start it with: relayflowd --data-dir "/tmp/pr140-maint-review.Hjcc9v/large-no-daemon" serve
real 0.77
user 0.27
sys 0.12
CLI_EXIT=2
```

## Passing evidence

### Real `relayflowd`, journal entries, and completion reason — PASS

```text
$ /Users/khaliqgant/.relayflows-toolchain/target/gate-contract/debug/relayflowd --data-dir /tmp/pr140-maint-review.Hjcc9v/live-data serve &
$ node sdk/dist/cli.js run sdk/tests/fixtures/direct-input.flow.ts --input '{"output":"/tmp/pr140-maint-review.Hjcc9v/live-output.txt","value":"real daemon value"}' --data-dir /tmp/pr140-maint-review.Hjcc9v/live-data
SOCKET_READY=yes
WARNING [unprovable_effects] Step "run-1" command "printf" resolves, but its effects cannot be proven before execution.
RUN 01M1HHTYH90YARKEC9FZ9X1FPK completed (1 steps) completionReason: success
CLI_EXIT=0
OUTPUT_FILE=real daemon value
DAEMON_EXIT=143
DATA_FILES
/tmp/pr140-maint-review.Hjcc9v/live-data/relayflowd.sqlite3
/tmp/pr140-maint-review.Hjcc9v/live-data/runs/01M1HHTYH90YARKEC9FZ9X1FPK.sqlite3
```

```text
$ sqlite3 -header -column /tmp/pr140-maint-review.Hjcc9v/live-data/runs/01M1HHTYH90YARKEC9FZ9X1FPK.sqlite3 'select * from entries order by rowid;'
seq  segment_id  entry_type            step_id  attempt  at_ms          payload
1    1           run.spawned                             1788369271337  {"created_by":"protocol-v0","journal_version":1,"parent_run_id":null,"spec":{"name":"direct-input-fixture","steps":[{"command":"printf %s 'real daemon value' > '/tmp/pr140-maint-review.Hjcc9v/live-output.txt'","depends_on":[],"id":"run-1","max_iterations":1,"retry":{"initial_backoff_ms":100,"jitter_percent":20,"max_backoff_ms":60000,"multiplier":2},"type":"deterministic","verification":{}}],"version":"0.1.0"},"spec_hash":"2af31da0ab3c35dad1774f881e98ac703b387313f62038136bdbbcfcca9fe508"}
2    1           step.attempt.started  run-1    1        1788369271356  {"executor":"kernel","idempotency_key":"74c5f3c0a55048ab33a5a41f66edff274d5ff1d8911d32d738650240e800d320","lease_deadline_ms":1788369301356,"lease_id":"01M1HHTYHWMT3ZHXGP6AGD87TD","max_iterations":1,"pins":{"streams":[],"workspace":[]},"recovery_mode":null,"step_type":"deterministic"}
3    1           step.completed        run-1    1        1788369271372  {"budget":{"dollars":"0","tokens_in":0,"tokens_out":0},"completed_by":"kernel","completionReason":"success","disposition":"step_done","effects":[],"end_pins":null,"next_attempt_at_ms":null,"output":{"exit_code":0,"stderr_tail":"","stdout_tail":""},"verification":{"detail":"all gates passed","gate":"exit_code","verdict":"pass"}}
4    1           run.completed                           1788369271375  {"budget_total":{"dollars":"0","tokens_in":0,"tokens_out":0},"completionReason":"success","failed_step_id":null}
```

### Missing/malformed/file edge cases before daemon contact — PASS

```text
$ for input_case in MISSING_ARG MALFORMED_INLINE INVALID_FILE DIRECTORY EMPTY_FILE MISSING_FILE; do ...; done

CASE=MISSING_ARG
REFUSED [input_missing] A directly run .flow.ts requires --input <inline-json-or-file>.
EXIT=2

CASE=MALFORMED_INLINE
REFUSED [input_invalid] Inline input is not valid JSON.
EXIT=2

CASE=INVALID_FILE
REFUSED [input_invalid] Input file "/tmp/pr140-maint-review.Hjcc9v/invalid.json" is not valid JSON.
EXIT=2

CASE=DIRECTORY
REFUSED [input_unreadable] Input file "/tmp/pr140-maint-review.Hjcc9v" is not a regular file.
EXIT=2

CASE=EMPTY_FILE
REFUSED [input_invalid] Input file "/tmp/pr140-maint-review.Hjcc9v/empty.json" is not valid JSON.
EXIT=2

CASE=MISSING_FILE
REFUSED [input_invalid] Inline input is not valid JSON.
EXIT=2
```

The missing-file result follows the documented existing-file-first rule: a
nonexistent path-shaped argument is treated as malformed inline JSON.

```text
$ chmod 000 /tmp/pr140-maint-review.Hjcc9v/unreadable.json
$ node sdk/dist/cli.js run /tmp/pr140-maint-review.Hjcc9v/simple.flow.mjs --input /tmp/pr140-maint-review.Hjcc9v/unreadable.json --data-dir /tmp/pr140-maint-review.Hjcc9v/no-daemon
REFUSED [input_unreadable] Input file "/tmp/pr140-maint-review.Hjcc9v/unreadable.json" is not readable.
CLI_EXIT=2
```

### v1/YAML non-regression — PASS for the exercised boundary

```text
$ node sdk/dist/cli.js check --json testdata/hello-deterministic.flow.yaml
WARNING [unprovable_effects] Step "greet" command "echo" resolves, but its effects cannot be proven before execution.
WARNING [unprovable_effects] Step "shout" command "echo" resolves, but its effects cannot be proven before execution.
{"ok":true,"path":"testdata/hello-deterministic.flow.yaml","projectConfigPath":"/Users/khaliqgant/AgentWorkforce/flows-132-direct-input-wt/testdata/flows.json","resolutions":[],"diagnostics":[{"severity":"warning","kind":"unprovable_effects","stepId":"greet","message":"Step \"greet\" command \"echo\" resolves, but its effects cannot be proven before execution."},{"severity":"warning","kind":"unprovable_effects","stepId":"shout","message":"Step \"shout\" command \"echo\" resolves, but its effects cannot be proven before execution."}]}
CHECK_EXIT=0
$ node sdk/dist/cli.js run testdata/hello-deterministic.flow.yaml --input '{}'
REFUSED [invalid_invocation] Usage: flows check [--json] <flow.yaml|spec.json> flows run [--json] [--data-dir <dir>] <flow.yaml|spec.json> flows run [--json] [--data-dir <dir>] <flow.ts> --input <inline-json-or-file> flows resume [--json] [--data-dir <dir>] <run-id> flows hn-monitor start [--data-dir <dir>] [--poll-interval-ms <n>] <spec.json>
YAML_INPUT_EXIT=2
```

### Typecheck and packed public type boundary — PASS

```text
$ cd sdk && ./node_modules/.bin/tsc --noEmit
EXIT 0
$ cd surface && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run tests/flow.test.ts

 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-132-direct-input-wt/surface

 ✓ tests/flow.test.ts (5 tests) 25ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  19:12:32
   Duration  2.23s (transform 161ms, setup 0ms, collect 140ms, tests 25ms, environment 0ms, prepare 670ms)
EXIT 0
```

```text
$ tar -tzf /tmp/pr140-maint-review.Hjcc9v/pack/relayflows-surface-0.1.0.tgz | rg '^package/dist/(index|flow)\.(d\.ts|js)$'
$ tar -xOf /tmp/pr140-maint-review.Hjcc9v/pack/relayflows-surface-0.1.0.tgz package/dist/flow.d.ts | rg 'FlowBody|AuthoredFlowDefinition|declare function flow'
package/dist/flow.d.ts
package/dist/flow.js
package/dist/index.d.ts
package/dist/index.js
export type FlowBody<Input = unknown> = (f: Ctx, input: Input) => Promise<void>;
export interface AuthoredFlowDefinition<Input = unknown> {
    readonly body: FlowBody<Input>;
export declare function flow<Input = unknown>(name: string, body: FlowBody<Input>): FlowHandle;
export declare function flow<Input = unknown>(name: string, header: FlowHeader, body: FlowBody<Input>): FlowHandle;
export declare function getFlowDefinition<Input = unknown>(handle: FlowHandle): AuthoredFlowDefinition<Input>;
```

### Exact current GitHub state — checks PASS, mergeability FAIL

```text
$ gh pr view 140 --json number,title,state,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,mergeStateStatus,mergeable,url,statusCheckRollup --jq '{number,title,state,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,mergeStateStatus,mergeable,url,checks:[.statusCheckRollup[]|{name:(.name // .context),status,conclusion,detailsUrl:(.detailsUrl // .targetUrl)}]}'
{"baseRefName":"feat/v2-surface-package","baseRefOid":"7266c5134c01151c28c7cc412380b2c0ee6b3dfe","checks":[{"conclusion":"SUCCESS","detailsUrl":"https://github.com/AgentWorkforce/flows/actions/runs/33655869115/job/100334138356","name":"linux-x64-artifact","status":"COMPLETED"},{"conclusion":"SUCCESS","detailsUrl":"https://github.com/AgentWorkforce/flows/actions/runs/33655869169/job/100334138444","name":"packed-consumer","status":"COMPLETED"},{"conclusion":null,"detailsUrl":"","name":"CodeRabbit","status":null}],"headRefName":"feat/v2-direct-input","headRefOid":"2a98a3779e86df53fef6632d2adec59893b8f753","isDraft":false,"mergeStateStatus":"DIRTY","mergeable":"CONFLICTING","number":140,"state":"OPEN","title":"feat(cli): run authored flows with direct input","url":"https://github.com/AgentWorkforce/flows/pull/140"}

$ gh pr checks 140
CodeRabbit pass 0  Review skipped: reviews are disabled for this base branch
linux-x64-artifact pass 3m1s https://github.com/AgentWorkforce/flows/actions/runs/33655869115/job/100334138356
packed-consumer pass 19s https://github.com/AgentWorkforce/flows/actions/runs/33655869169/job/100334138444
EXIT 0
```

## Required next gate

Rebase/rebuild the direct-input slice on exact current PR #134 head, pass input
into its single journal-backed executor, preserve `missing_completion`, reject
unknown headers before normalization, add bounded file input, and add
adversarial tests for pre-journal side effects plus truthy/strict output
branches. Those tests must be invoked by an exact-head GitHub workflow. Then
rerun the real daemon/journal proof and all SDK tests from the new exact head.

REVIEW_FAILED
