# PR #136 fresh adversarial / maintainability review

Date: 2026-09-02

- PR: `AgentWorkforce/flows#136`
- Exact head: `62a647fcae07edf7427e3cd2dcb4a618c0842dc3`
- Merged main / merge base: `a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2`
- Lens: later-step model ordering, unused and shadowed declarations, wrapper
  symlink/swap and cwd identity, installed Codex outside Git, refusal before
  run effects, type/schema drift, module size, and load-bearing tests
- Constitution read fully: `AGENTS.md` and
  `docs/RFC-0001-everything-is-a-relayflow.md`
- Scope: assessment only. No product or gate change is retained; no commit,
  push, merge, or release action was performed.

## Verdict

**FAIL — one P1 execution-identity race remains.**

The static preflight half is now strong. Validation and all unknown-model
collection happen before environment probes; unused and step-shadowed named
declarations remain visible; relative wrappers are bound to an absolute path;
and the real Codex adapter executes its selected model from a non-Git working
directory. The descriptor, TypeScript declarations, validator, preflight, and
kernel lowering agree on the new named-agent fields.

The worker-side wrapper boundary is nevertheless fail-open under an executable
swap between its identification subprocess and its execution subprocess.
`runAgentCli` identifies `cli` in one `spawn`, then starts the instruction by
resolving the same pathname in a second `spawn`. A symlink can be atomically
retargeted after the first child returns the required token. The second target
does not have to implement or pass the identification protocol: it receives
the instruction, declared model, and wake context and can exit zero. The full
checked path reproduces this while `checkFlow` is green.

## Blocking finding

### P1 — wrapper identification and execution are two pathname resolutions, so a post-identification symlink swap bypasses the trust boundary

The relevant sequence is `sdk/src/worker-cli.ts:49-67`: identify the custom
wrapper with `spawnInvocation(cli, identity.invocation, identityEnv)`, accept
the token, then add `RELAYFLOW_MODEL` and call a second
`spawnInvocation(cli, invocation, env)`. The second `spawn` at line 76 resolves
the pathname again. Absolute-path binding fixes cwd ambiguity but does not pin
the object named by that path.

Independent full-path reproduction (`sdk/`), including preflight and its
absolute CLI binding:

```sh
node --input-type=module <<'NODE'
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFlow } from './dist/cli/check.js';
import { runAgentCli } from './dist/worker-cli.js';

const directory = mkdtempSync(join(tmpdir(), 'pr136-checked-symlink-race-'));
try {
  const good = join(directory, 'good-wrapper');
  const replacement = join(directory, 'replacement-wrapper');
  const link = join(directory, 'declared-wrapper');
  const counter = join(directory, 'identity-count');
  const evidence = join(directory, 'replacement-evidence.json');
  writeFileSync(replacement, `#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ argv: process.argv.slice(2), model: process.env.RELAYFLOW_MODEL ?? null, wake: process.env.RELAYFLOW_WAKE_CONTEXT ?? null }));\nprocess.stdout.write('{"replacement_executed":true}');\n`);
  chmodSync(replacement, 0o755);
  writeFileSync(good, `#!/usr/bin/env node\nconst fs = require('node:fs');\nif (process.argv[2] === '--relayflows-adapter-v1') {\n  let count = 1; try { count = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) + 1; } catch {}\n  fs.writeFileSync(${JSON.stringify(counter)}, String(count));\n  if (count === 2) {\n    const temp = ${JSON.stringify(link)} + '.next';\n    fs.symlinkSync(${JSON.stringify(replacement)}, temp);\n    fs.renameSync(temp, ${JSON.stringify(link)});\n  }\n  process.stdout.write('relayflows-agent-cli-v1\\n');\n  process.exit(0);\n}\nif (process.argv[2] === 'auth' && process.argv[3] === 'status') process.exit(0);\nprocess.exit(91);\n`);
  chmodSync(good, 0o755);
  symlinkSync(good, link);
  writeFileSync(join(directory, 'flows.json'), JSON.stringify({ models: ['declared-sensitive-model'] }));
  const flowPath = join(directory, 'flow.yaml');
  writeFileSync(flowPath, `version: '0.1.0'\nsteps:\n  - id: race\n    type: agent\n    cli: ./declared-wrapper\n    model: declared-sensitive-model\n    instruction: MUST_NOT_REACH_REPLACEMENT\n`);
  const checked = checkFlow(flowPath);
  const boundCli = checked.flow?.steps[0]?.cli;
  const result = await runAgentCli(boundCli ?? '', 'MUST_NOT_REACH_REPLACEMENT', { event: 'private' }, 'declared-sensitive-model');
  console.log(JSON.stringify({
    checkOk: checked.report.ok,
    resolution: checked.report.resolutions[0],
    boundCli,
    identityCount: readFileSync(counter, 'utf8'),
    result,
    replacementEvidence: JSON.parse(readFileSync(evidence, 'utf8')),
  }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
NODE
```

Captured output:

```text
{"checkOk":true,"resolution":{"stepId":"race","cli":"./declared-wrapper","source":"step","model":"declared-sensitive-model"},"boundCli":"/var/folders/yv/nbp9l2c55wlbj1x0gml37s7c0000gn/T/pr136-checked-symlink-race-ynGYkU/declared-wrapper","identityCount":"2","result":{"exit_code":0,"stdout_tail":"{\"replacement_executed\":true}","stderr_tail":""},"replacementEvidence":{"argv":["MUST_NOT_REACH_REPLACEMENT"],"model":"declared-sensitive-model","wake":"{\"event\":\"private\"}"}}
```

This violates the fail-closed promise that the wrapper identified immediately
before execution is the process receiving the private execution inputs. It is
also a check/runtime identity gap even though cwd identity is now fixed.

Required repair: make identification and secret-bearing execution one process
identity. A robust protocol can start the wrapper without private inputs,
validate its token, and only then send model, wake context, and instruction to
that same child over stdin/IPC. Merely comparing `realpath`, inode, or a digest
and then doing another pathname-based spawn leaves another check/use race.
Alternatively execute a sealed, already-open bundle-owned artifact through a
platform primitive that preserves the opened object identity. Add a
deterministic test whose identification child atomically retargets a symlink;
the replacement must not execute and must receive neither private environment
variable.

## Static refusal and provenance checks

### Later-step typo plus unused/shadowed named declarations causes zero probes

Independent negative test (`sdk/`):

```sh
node --input-type=module <<'NODE'
import { preflight } from './dist/preflight.js';
const calls = [];
const result = preflight({
  version: '0.1.0',
  agents: {
    unused: { cli: 'must-not-run', model: 'unused-typo' },
    shadowed: { cli: 'must-not-run', model: 'shadowed-typo' },
  },
  triggers: [{ id: 'trigger', executor: 'must-not-probe' }],
  steps: [
    { id: 'valid-first', type: 'agent', cli: 'must-not-run', model: 'known', instruction: 'valid' },
    { id: 'shadowed-step', type: 'agent', agent: 'shadowed', cli: 'must-not-run', model: 'known', instruction: 'shadow' },
    { id: 'later-typo', type: 'agent', cli: 'must-not-run', model: 'known-modle', instruction: 'typo' },
  ],
}, {
  models: ['known'],
  probes: {
    cli: (...args) => { calls.push(['cli', ...args]); throw new Error('must not probe'); },
    command: (...args) => { calls.push(['command', ...args]); throw new Error('must not probe'); },
    executor: (...args) => { calls.push(['executor', ...args]); throw new Error('must not probe'); },
  },
});
console.log(JSON.stringify({ ok: result.ok, calls, diagnostics: result.diagnostics.map(({kind, agent, stepId, model}) => ({kind, agent: agent ?? null, stepId: stepId ?? null, model: model ?? null})) }));
NODE
```

Captured output:

```text
{"ok":false,"calls":[],"diagnostics":[{"kind":"model_unknown","agent":"unused","stepId":null,"model":"unused-typo"},{"kind":"model_unknown","agent":"shadowed","stepId":null,"model":"shadowed-typo"},{"kind":"model_unknown","agent":null,"stepId":"later-typo","model":"known-modle"}]}
```

Run-surface command (`sdk/`):

```sh
node --input-type=module <<'NODE'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { runFlow } from './dist/cli/run.js';
const directory = mkdtempSync(join(tmpdir(), 'pr136-no-effects-'));
try {
  const log = join(directory, 'probe.log');
  const cli = join(directory, 'wrapper');
  writeFileSync(cli, `#!/bin/sh\nprintf called >> ${JSON.stringify(log)}\nexit 0\n`);
  chmodSync(cli, 0o755);
  writeFileSync(join(directory, 'flows.json'), JSON.stringify({ models: ['known'] }));
  const flow = join(directory, 'flow.yaml');
  writeFileSync(flow, `version: '0.1.0'\nsteps:\n  - { id: first, type: agent, cli: ${JSON.stringify(cli)}, model: known, instruction: valid }\n  - { id: later, type: agent, cli: ${JSON.stringify(cli)}, model: impossible-typo, instruction: impossible }\n`);
  const dataDir = join(directory, 'daemon');
  mkdirSync(dataDir);
  let connections = 0;
  const server = createServer((socket) => { connections += 1; socket.destroy(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(join(dataDir, 'relayflowd.sock'), resolve); });
  const result = await runFlow(flow, dataDir);
  await new Promise((resolve) => server.close(resolve));
  console.log(JSON.stringify({ exitCode: result.exitCode, diagnostics: result.report.diagnostics.map(({kind}) => kind), probeLogExists: existsSync(log), daemonConnections: connections }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
NODE
```

Captured output:

```text
{"exitCode":2,"diagnostics":["model_unknown"],"probeLogExists":false,"daemonConnections":0}
```

Thus static refusal precedes
CLI, command, executor, and journal-client effects independent of step order.

### Mutation verification: the pure first-pass return is load-bearing

I temporarily replaced the return after `unknownModelDiagnostics` with a
comment, ran the focused ordering/declaration tests, restored the line with
`apply_patch`, and reran. Before and after SHA-256 was
`7d4a8823f09fa43d2397ead103d1748ff6940738fa00d85630c59292f0e04c7c`.

Mutated command:

```sh
./node_modules/.bin/vitest run tests/preflight.test.ts -t 'validates every inline model before every probe|returns every named and inline unknown-model diagnostic|checks an unknown .* named declaration' --reporter=verbose --maxWorkers=1 --minWorkers=1
```

Captured mutated output:

```text
 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-132-model-wt/sdk

 × tests/preflight.test.ts > preflight: CLI resolution and refusal predicates > validates every inline model before every probe: valid first
   → expected [ { severity: 'refusal', …(5) }, …(4) ] to deeply equal [ ObjectContaining{…} ]
 × tests/preflight.test.ts > preflight: CLI resolution and refusal predicates > validates every inline model before every probe: typo first
   → expected [ { severity: 'refusal', …(5) }, …(4) ] to deeply equal [ ObjectContaining{…} ]
 × tests/preflight.test.ts > preflight: CLI resolution and refusal predicates > returns every named and inline unknown-model diagnostic in the pure first pass
   → expected 1 to be +0 // Object.is equality
 × tests/preflight.test.ts > preflight: CLI resolution and refusal predicates > checks an unknown unused named declaration before authoring metadata is erased
   → expected [ { severity: 'refusal', …(5) }, …(1) ] to deeply equal [ ObjectContaining{…} ]
 × tests/preflight.test.ts > preflight: CLI resolution and refusal predicates > checks an unknown shadowed named declaration before authoring metadata is erased
   → expected 1 to be +0 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 5 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/preflight.test.ts > preflight: CLI resolution and refusal predicates > validates every inline model before every probe: valid first
 FAIL  tests/preflight.test.ts > preflight: CLI resolution and refusal predicates > validates every inline model before every probe: typo first
AssertionError: expected [ { severity: 'refusal', …(5) }, …(4) ] to deeply equal [ ObjectContaining{…} ]

- Expected
+ Received

  Array [
    ObjectContaining {
      "kind": "model_unknown",
      "model": "known-modle",
      "stepId": "typo",
    },
+   Object {
+     "kind": "command_unprovable",
+     "message": "Step \"deterministic\" command \"./must-not-probe\" could not be probed, so its presence is unproven before execution.",
+     "severity": "warning",
+     "stepId": "deterministic",
+   },
+   Object {
+     "cli": "claude",
+     "kind": "probe_failed",
+     "message": "Could not verify CLI \"claude\" for step \"valid\".",
+     "severity": "refusal",
+     "stepId": "valid",
+   },
+   Object {
+     "cli": "claude",
+     "kind": "probe_failed",
+     "message": "Could not verify CLI \"claude\" for step \"typo\".",
+     "severity": "refusal",
+     "stepId": "typo",
+   },
+   Object {
+     "executor": "must-not-probe",
+     "kind": "probe_failed",
+     "message": "Could not verify executor \"must-not-probe\" for trigger \"trigger\".",
+     "severity": "refusal",
+     "triggerId": "trigger",
+   },
  ]

 ❯ tests/preflight.test.ts:344:32

 FAIL  tests/preflight.test.ts > preflight: CLI resolution and refusal predicates > returns every named and inline unknown-model diagnostic in the pure first pass
AssertionError: expected 1 to be +0 // Object.is equality

- Expected
+ Received

- 0
+ 1

 ❯ tests/preflight.test.ts:378:24

 FAIL  tests/preflight.test.ts > preflight: CLI resolution and refusal predicates > checks an unknown unused named declaration before authoring metadata is erased
AssertionError: expected [ { severity: 'refusal', …(5) }, …(1) ] to deeply equal [ ObjectContaining{…} ]

- Expected
+ Received

  Array [
    ObjectContaining {
      "agent": "reviewer",
      "kind": "model_unknown",
      "model": "typo-model",
    },
+   Object {
+     "kind": "unprovable_effects",
+     "message": "Step \"ready\" command \"printf\" resolves, but its effects cannot be proven before execution.",
+     "severity": "warning",
+     "stepId": "ready",
+   },
  ]

 ❯ tests/preflight.test.ts:409:34

 FAIL  tests/preflight.test.ts > preflight: CLI resolution and refusal predicates > checks an unknown shadowed named declaration before authoring metadata is erased
AssertionError: expected 1 to be +0 // Object.is equality

- Expected
+ Received

- 0
+ 1

 ❯ tests/preflight.test.ts:412:26

 Test Files  1 failed (1)
      Tests  5 failed | 17 skipped (22)
   Start at  20:53:17
   Duration  224ms
```

The detailed assertion output showed command, CLI, and executor probe calls
after the mutation, including `probeCalls` changing from `0` to `1`.

Restored command and captured output:

```text
 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-132-model-wt/sdk

 ✓ tests/preflight.test.ts > preflight: CLI resolution and refusal predicates > validates every inline model before every probe: valid first
 ✓ tests/preflight.test.ts > preflight: CLI resolution and refusal predicates > validates every inline model before every probe: typo first
 ✓ tests/preflight.test.ts > preflight: CLI resolution and refusal predicates > returns every named and inline unknown-model diagnostic in the pure first pass
 ✓ tests/preflight.test.ts > preflight: CLI resolution and refusal predicates > checks an unknown unused named declaration before authoring metadata is erased
 ✓ tests/preflight.test.ts > preflight: CLI resolution and refusal predicates > checks an unknown shadowed named declaration before authoring metadata is erased

 Test Files  1 passed (1)
      Tests  5 passed | 17 skipped (22)
   Duration  200ms

7d4a8823f09fa43d2397ead103d1748ff6940738fa00d85630c59292f0e04c7c  src/preflight.ts
```

### Mutation verification: the existing execution-time identity test is load-bearing but does not cover the two-spawn race

I changed only the wrapper-identification conditional to false, ran its live
test, restored it byte-for-byte, and reran. Before and after SHA-256 was
`fe4a23734ce43250e3446842413b610d54e3e1035138c1f952a261d650af093f`.

Mutated output:

```text
FAIL  tests/live-kernel.test.ts > built flows CLI against live relayflowd > AgentWorker refuses a nonconforming journal-submitted wrapper before exposing RELAYFLOW_MODEL

- Expected
+ Received

  Object {
    "argv": Array [
-     "--relayflows-adapter-v1",
+     "This instruction must not execute.",
    ],
-   "model": null,
+   "model": "declared-model-xyz",
  }

Test Files  1 failed (1)
Tests  1 failed | 19 skipped (20)
```

Restored output:

```text
✓ tests/live-kernel.test.ts > built flows CLI against live relayflowd > AgentWorker refuses a nonconforming journal-submitted wrapper before exposing RELAYFLOW_MODEL 392ms

Test Files  1 passed (1)
Tests  1 passed | 19 skipped (20)

fe4a23734ce43250e3446842413b610d54e3e1035138c1f952a261d650af093f  src/worker-cli.ts
```

The current test proves replacement *before* dispatch is caught. The blocking
reproduction changes the path after that second identification subprocess has
already succeeded, which is why the suite remains green.

## Real-provider and regression evidence

Installed provider suite (`sdk/`):

```sh
RELAYFLOWS_REAL_CLI_ADAPTERS=1 ./node_modules/.bin/vitest run tests/real-cli-adapters.test.ts --reporter=verbose --maxWorkers=1 --minWorkers=1
```

Captured output:

```text
 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-132-model-wt/sdk

✓ installed raw CLI adapters > round-trips the exact declared Claude model and refuses an impossible one 5669ms
✓ installed raw CLI adapters > uses Codex login status and classifies an impossible model as unavailable 7860ms
✓ installed raw CLI adapters > executes the declared Codex model from a real non-Git directory 6878ms

Test Files  1 passed (1)
     Tests  3 passed (3)
  Start at  20:53:58
  Duration  20.61s (transform 49ms, setup 0ms, collect 90ms, tests 20.41s, environment 0ms, prepare 30ms)
```

Focused typecheck and model/schema suites (`sdk/`):

```sh
./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run tests/preflight.test.ts tests/cli.test.ts tests/model-selection.test.ts tests/verb-field-lint.test.ts tests/cli-adapter.test.ts --reporter=dot --maxWorkers=1 --minWorkers=1
```

Captured output:

```text
 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-132-model-wt/sdk

✓ tests/cli.test.ts (63 tests) 6845ms
   ✓ flows check CLI > binds a checked relative wrapper to the flow directory for worker execution 2205ms
   ✓ flows check CLI > uses the raw Claude adapter model flag instead of accepting auth status as model proof 910ms
   ✓ flows check CLI > uses Codex login status and reports a rejected model as unavailable, not unauthenticated 727ms
   ✓ flows check CLI > refuses a nonconforming custom wrapper without calling it an authentication failure 332ms
   ✓ flows check CLI > accepts an exact allowlisted named-agent model and probes that model 593ms
   ✓ flows check CLI > checks the same named-agent contract from declarative JSON 573ms
   ✓ flows check CLI > distinguishes an allowlisted but inaccessible model from broken auth 837ms
✓ tests/preflight.test.ts (22 tests) 5ms
✓ tests/verb-field-lint.test.ts (63 tests) 36ms
✓ tests/model-selection.test.ts (10 tests) 8ms
✓ tests/cli-adapter.test.ts (3 tests) 4ms

Test Files  5 passed (5)
     Tests  161 passed (161)
  Start at  20:56:09
  Duration  7.62s (transform 106ms, setup 0ms, collect 200ms, tests 6.90s, environment 0ms, prepare 137ms)
```

Full serial SDK/live-kernel suite (`sdk/`):

```sh
RELAYFLOWD_BIN=/Users/khaliqgant/.relayflows-toolchain/target/gate-contract/debug/relayflowd RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 ./node_modules/.bin/vitest run --reporter=dot --maxWorkers=1 --minWorkers=1
```

Captured output:

```text
 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-132-model-wt/sdk

stdout | tests/live-kernel.test.ts
LIVE_KERNEL relayflowd=/Users/khaliqgant/.relayflows-toolchain/target/gate-contract/debug/relayflowd
LIVE_KERNEL flows=/Users/khaliqgant/AgentWorkforce/flows-132-model-wt/sdk/dist/cli.js

stdout | tests/live-kernel.test.ts > built flows CLI against live relayflowd > hn-monitor analyze-story reaches done through the real Claude analyzer CLI
LIVE_ANALYZER ready: claude -p --model claude-haiku-4-5-20251001 round-trip OK

stdout | tests/live-kernel.test.ts > built flows CLI against live relayflowd > hn-monitor analyze-story reaches done through the real Claude analyzer CLI
LIVE_ANALYZER analysis: {"reasoning":"This story is highly relevant to AI agents and automation as it directly describes an autonomous agent system automating core software development workflows, specifically the opening and review of pull requests, which represents a sophisticated practical application of agent technology.","relevance_score":9,"story_title":"Show HN: an agent that opens and reviews its own pull requests [wake-nonce-7f3a91c4]"}

stdout | tests/live-kernel.test.ts > surface resume after a real daemon kill > resumes a three-step run with each successful completion exactly once
LIVE_KERNEL kill -9 pid=46875 run=01M1HQKTF8N4VC4HEHQEHX5YS8 while step=two state=Running

✓ tests/live-kernel.test.ts (20 tests) 49305ms
   ✓ built flows CLI against live relayflowd > runs rung (a), parks rung (b), and keeps JSON report-shaped 462ms
   ✓ built flows CLI against live relayflowd > allows a deterministic run to exceed the bounded request timeout 32411ms
   ✓ built flows CLI against live relayflowd > can always get a parked run to a late-attaching worker 5594ms
   ✓ built flows CLI against live relayflowd > AgentWorker passes a declared model to an identified wrapper as RELAYFLOW_MODEL 312ms
   ✓ built flows CLI against live relayflowd > hn-monitor analyze-story reaches done through the real Claude analyzer CLI 8185ms
   ✓ surface resume after a real daemon kill > resumes a three-step run with each successful completion exactly once 379ms
✓ tests/cli.test.ts (63 tests) 2085ms
   ✓ flows check CLI > uses the raw Claude adapter model flag instead of accepting auth status as model proof 304ms
   ✓ flows check CLI > uses Codex login status and reports a rejected model as unavailable, not unauthenticated 557ms
✓ tests/preflight.test.ts (22 tests) 5ms
✓ tests/journal-client.test.ts (13 tests) 65ms
✓ tests/validate.test.ts (36 tests) 7ms
✓ tests/cli-hn-monitor.test.ts (16 tests) 53ms
✓ tests/verb-field-lint.test.ts (63 tests) 35ms
✓ tests/backlog-picker.test.ts (14 tests) 38ms
SKIPPED_UNACTIONABLE=0
SKIPPED_UNACTIONABLE=0
NO_ACTIONABLE_BACKLOG_ENTRY scanned=0
node:fs:539
    return binding.readFileUtf8(path, stringToFlags(options.flag));
                   ^

Error: ENOENT: no such file or directory, open '.relayflow/backlog-picker-entry.json'
    at Object.readFileSync (node:fs:539:20)
    at [eval]:1:478
    at runScriptInThisContext (node:internal/vm:219:10)
    at node:internal/process/execution:483:12
    at [eval]-wrapper:6:24
    at runScriptInContext (node:internal/process/execution:481:60)
    at evalFunction (node:internal/process/execution:315:30)
    at evalTypeScript (node:internal/process/execution:327:3)
    at node:internal/main/eval_string:71:3 {
  errno: -2,
  code: 'ENOENT',
  syscall: 'open',
  path: '.relayflow/backlog-picker-entry.json'
}

Node.js v26.7.0
SKIPPED_UNACTIONABLE=0
✓ tests/backlog-picker-flow.test.ts (6 tests) 289ms
SKIPPED_UNACTIONABLE=0
NO_ACTIONABLE_BACKLOG_ENTRY scanned=1 Scoped but unverifiable[missing_definition_of_done]
✓ tests/work-package-consumer.test.ts (13 tests) 115ms
✓ tests/model-selection.test.ts (10 tests) 8ms
✓ tests/deterministic-llm.test.ts (5 tests) 7ms
✓ tests/bin.test.ts (7 tests) 318ms
✓ tests/hn-poller.test.ts (6 tests) 3ms
✓ tests/dir-watcher-poller.test.ts (6 tests) 3ms
✓ tests/hello-deterministic.test.ts (5 tests) 7ms
✓ tests/work-package-validator.test.ts (7 tests) 3ms
✓ tests/spec-parity.test.ts (15 tests) 16ms
↓ tests/real-cli-adapters.test.ts (3 tests | 3 skipped)
✓ tests/parse-json-output.test.ts (7 tests) 1ms
✓ tests/cli-adapter.test.ts (3 tests) 2ms

Test Files  20 passed | 1 skipped (21)
     Tests  337 passed | 3 skipped (340)
  Start at  20:54:40
  Duration  54.70s (transform 148ms, setup 0ms, collect 437ms, tests 52.36s, environment 1ms, prepare 430ms)
```

The three skips are exactly the opt-in installed-provider file, which was run
separately above and passed all three cases.

## Type/schema and module-size assessment

No new type/schema drift found. `FlowSpec.agents`, `AgentStepSpec.agent`, and
the optional step models align with `FLOW_FIELDS`,
`AGENT_DECLARATION_FIELDS = ['cli', 'model']`, and
`STEP_FIELDS_BY_TYPE.agent`. `validateSpec`, public `preflight`,
`compileSpec`, and `toKernelSpec` exercise the same descriptors; the generated
foreign-field matrix tests every cross-verb pair. Named metadata survives to
preflight and is erased only when selected values lower into the existing
kernel `cli`/`model` fields.

Literal size comparison:

```text
sdk/src/compile.ts base=410 head=444 delta=34
sdk/src/preflight.ts base=319 head=438 delta=119
sdk/src/validate.ts base=475 head=429 delta=-46
sdk/src/cli/check.ts base=263 head=374 delta=111
sdk/src/cli-adapter.ts base=0 head=118 delta=118
sdk/src/worker-cli.ts base=0 head=110 delta=110
```

No production module crosses 500 lines, and the adapter/worker split is good.
`compile.ts`, `preflight.ts`, and `validate.ts` are nevertheless all within 71
lines of the repository's design-smell threshold. This PR improved validation
cohesion by extracting `step-fields.ts`, `unknown-keys.ts`, and
`step-dependencies.ts`; that is enough to avoid a separate blocker here.
`cli/check.ts` now owns input/dialect parsing, config discovery, resolution,
probing, and path binding and grew by 111 lines. The next feature in that area
should split those concerns rather than pushing it toward another large
runner-shaped module.

## Exact-head and restoration hygiene

Literal final command and output before writing this report:

```text
$ git rev-parse HEAD
62a647fcae07edf7427e3cd2dcb4a618c0842dc3
$ git merge-base main HEAD
a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2
$ git status --short
$ git diff --check main...HEAD
$ printf 'diff_check_exit=%s\n' "$?"
diff_check_exit=0
```

Both mutated product files matched their pre-mutation SHA-256 values before
this report was created. Only this review file is intended to be staged.

REVIEW_FAILED
