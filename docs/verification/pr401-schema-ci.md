# PR 401 schema CI repair

The schema generator failed on the existing `FlowSpec.workspace` and
`FlowSpec.tools.fs` readonly-array declarations. Readonly affects TypeScript
mutation, not the JSON array shape. The generator now unwraps that modifier
only for arrays; existing unsupported operators still fail.

Regeneration synchronizes existing `cwd`, `transport`, `workspace`, and `tools`
fields. No CI workflow, review gate, or existing test was changed.

The independent review found no actionable issues. The separate review-swarm
failure occurred before code review: Cloud returned HTTP 500 during its
credential check ([failed job](https://github.com/AgentWorkforce/flows/actions/runs/34895043418/job/104146816895)). No credentials were changed or bypassed.

## Original generator failure

Working directory: `repository root`.

```sh
node scripts/generate-json-schema.mjs /tmp/pr401-schema-before.json
```

```text
file:///Users/will/Projects/AgentWorkforce/flows/scripts/generate-json-schema.mjs:181
  throw new Error(`Unsupported type ${node.getText()}`);
        ^

Error: Unsupported type readonly string[]
    at type (file:///Users/will/Projects/AgentWorkforce/flows/scripts/generate-json-schema.mjs:181:9)
    at Array.map (<anonymous>)
    at type (file:///Users/will/Projects/AgentWorkforce/flows/scripts/generate-json-schema.mjs:82:33)
    at object (file:///Users/will/Projects/AgentWorkforce/flows/scripts/generate-json-schema.mjs:39:33)
    at definition (file:///Users/will/Projects/AgentWorkforce/flows/scripts/generate-json-schema.mjs:66:14)
    at file:///Users/will/Projects/AgentWorkforce/flows/scripts/generate-json-schema.mjs:184:41
    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)

Node.js v22.22.2
```

Exit code: 1.

## Byte stability and committed schema

Working directory: `repository root`.

```sh
node scripts/generate-json-schema.mjs /tmp/pr401-schema-first.json && cmp packages/schema/flows.schema.json /tmp/pr401-schema-first.json && node scripts/generate-json-schema.mjs /tmp/pr401-schema-second.json && cmp /tmp/pr401-schema-first.json /tmp/pr401-schema-second.json
```

```text
Generated packages/schema/flows.schema.json (70 definitions)
Generated packages/schema/flows.schema.json (70 definitions)
```

Exit code: 0.

## Full schema suite with CI tool versions

Working directory: `packages/schema`.

```sh
PATH="/tmp/flows-ci-toolchain/node_modules/@oven/bun-darwin-aarch64/bin:/tmp/flows-ci-toolchain/node_modules/.bin:$PATH" /tmp/flows-ci-toolchain/node_modules/@oven/bun-darwin-aarch64/bin/bun run test
```

```text
$ bun test tests
bun test v1.4.0 (34cbb9a40)

tests/smoke.test.ts:
(pass) all exported spec type nodes have documented definitions [11.54ms]
(pass) regeneration is byte-stable and committed schema has not drifted [335.78ms]
(pass) npm tarball contains only data and documentation with no runtime dependencies [646.70ms]

tests/parity.test.ts:
(pass) flows check fixture parity: backlog-picker.flow.yaml [20.95ms]
(pass) flows check fixture parity: budget-guarded.flow.yaml [4.84ms]
(pass) flows check fixture parity: dir-watcher.flow.yaml [227.04ms]
(pass) flows check fixture parity: hello-agent.flow.yaml [15.00ms]
(pass) flows check fixture parity: hello-deterministic.flow.yaml [5.15ms]
(pass) flows check fixture parity: hello-ladder.flow.yaml [33.64ms]
(pass) flows check fixture parity: hello-llm.flow.yaml [24.34ms]
(pass) flows check fixture parity: hn-monitor.flow.yaml [176.45ms]
(pass) flows check fixture parity: json-schema-invalid.flow.yaml [6.53ms]
(pass) flows check fixture parity: step-memory.flow.yaml [150.83ms]
(pass) flows check fixture parity: step-placement.flow.yaml [2.94ms]
(pass) flows check fixture parity: tick-heartbeat.flow.yaml [33.11ms]
(pass) structural parity: unknown root key [0.77ms]
(pass) structural parity: unsupported version [0.09ms]
(pass) structural parity: no steps [0.10ms]
(pass) structural parity: step typo [0.18ms]
(pass) structural parity: empty command [0.04ms]
(pass) structural parity: positive timeout [0.05ms]
(pass) structural parity: fractional retry [0.05ms]
(pass) structural parity: wrong step field [0.09ms]
(pass) structural parity: nonzero exit gate [0.18ms]
(pass) structural parity: legacy zero exit gate [0.08ms]
(pass) structural parity: boolean schema [0.78ms]
(pass) structural parity: nested invalid schema [4.84ms]
(pass) structural parity: bad memory budget [0.12ms]
(pass) structural parity: unsafe memory budget [0.05ms]
(pass) structural parity: empty memory query [0.04ms]
(pass) structural parity: unsafe duration [0.07ms]
(pass) structural parity: bad money [0.05ms]
(pass) structural parity: bad input index [0.12ms]
(pass) structural parity: blank input name [0.10ms]
(pass) structural parity: trigger silence budget [0.04ms]
(pass) structural parity: llm: output object [12.99ms]
(pass) structural parity: llm: boolean output [0.16ms]
(pass) structural parity: llm: output and verification [5.08ms]
(pass) structural parity: llm: exit gate [0.17ms]
(pass) structural parity: llm: trimmed model [0.05ms]
(pass) structural parity: llm: control in model [0.04ms]
(pass) structural parity: agent: output object [8.81ms]
(pass) structural parity: agent: boolean output [0.12ms]
(pass) structural parity: agent: output and verification [6.69ms]
(pass) structural parity: agent: exit gate [0.19ms]
(pass) structural parity: agent: trimmed model [0.10ms]
(pass) structural parity: agent: control in model [0.04ms]
(pass) step examples compile and validate [0.32ms]
(pass) generated schema satisfies the existing bounded-reference rule [3.58ms]
(pass) semantic checks remain explicit runtime responsibilities [0.41ms]
(pass) embedded dialect http://json-schema.org/draft-04/schema# [6.62ms]
(pass) embedded dialect http://json-schema.org/draft-06/schema# [5.99ms]
(pass) embedded dialect http://json-schema.org/draft-07/schema# [5.84ms]
(pass) embedded dialect https://json-schema.org/draft/2019-09/schema [14.40ms]
(pass) embedded dialect https://json-schema.org/draft/2020-12/schema [10.55ms]
(pass) header hint is warning-only, first-line aware, and never edits input [15.26ms]
(pass) canonical surface parity: "repo" [0.16ms]
(pass) canonical surface parity: "/repo/src" [0.05ms]
(pass) canonical surface parity: "pr://github/example" [0.04ms]
(pass) canonical surface parity: "/" [0.02ms]
(pass) canonical surface parity: "pr://" [0.02ms]
(pass) canonical surface parity: "" [0.04ms]
(pass) canonical surface parity: " repo" [0.03ms]
(pass) canonical surface parity: "repo " [0.02ms]
(pass) canonical surface parity: "repo//src" [0.02ms]
(pass) canonical surface parity: "repo/../src" [0.02ms]
(pass) canonical surface parity: "repo/." [0.02ms]
(pass) canonical surface parity: ":/bad//path" [0.02ms]
(pass) named declarations and selected input paths use authoring shapes [27.53ms]

tests/generation.test.ts:
(pass) generates readonly scope arrays as strict JSON arrays without schema drift [215.99ms]

 70 pass
 0 fail
 3884 expect() calls
Ran 70 tests across 3 files. [2.54s]
```

Exit code: 0.

## Initial local-tool attempt

Working directory: `packages/schema`.

```sh
bun run test
```

```text
$ bun test tests
bun test v1.3.4 (5eb2145b)

tests/smoke.test.ts:
(pass) all exported spec type nodes have documented definitions [18.57ms]
(pass) regeneration is byte-stable and committed schema has not drifted [317.83ms]
57 |   expect(Object.keys(pkg.optionalDependencies ?? {})).toEqual([]);
58 |   expect(Object.keys(pkg.peerDependencies ?? {})).toEqual([]);
59 |   expect(pkg.main).toBe('./flows.schema.json');
60 |   expect(pkg.exports['.']).toBe('./flows.schema.json');
61 |   const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: packageDirectory, encoding: 'utf8' }));
62 |   expect(packed[0].files.map((file: any) => file.path).sort()).toEqual(['LICENSE', 'README.md', 'THIRD_PARTY_LICENSES', 'flows.schema.json', 'package.json'].sort());
                     ^
TypeError: undefined is not an object (evaluating 'packed[0].files')
      at <anonymous> (/Users/will/Projects/AgentWorkforce/flows/packages/schema/tests/smoke.test.ts:62:17)
(fail) npm tarball contains only data and documentation with no runtime dependencies [431.23ms]

tests/parity.test.ts:
(pass) flows check fixture parity: backlog-picker.flow.yaml [22.77ms]
(pass) flows check fixture parity: budget-guarded.flow.yaml [4.91ms]
(pass) flows check fixture parity: dir-watcher.flow.yaml [441.19ms]
(pass) flows check fixture parity: hello-agent.flow.yaml [16.71ms]
(pass) flows check fixture parity: hello-deterministic.flow.yaml [4.84ms]
(pass) flows check fixture parity: hello-ladder.flow.yaml [31.85ms]
(pass) flows check fixture parity: hello-llm.flow.yaml [27.49ms]
(pass) flows check fixture parity: hn-monitor.flow.yaml [169.35ms]
(pass) flows check fixture parity: json-schema-invalid.flow.yaml [8.21ms]
32 | for (const name of fixtures) test(`flows check fixture parity: ${name}`, () => {
33 |   const source = readFileSync(new URL(`../../../testdata/${name}`, import.meta.url), 'utf8');
34 |   const accepted = validate(parse(source));
35 |   const errors = structuredClone(validate.errors);
36 |   const report = checkSource(name, source);
37 |   expect(accepted, JSON.stringify({ errors, report })).toBe(report.ok);
                                                            ^
error: {"errors":null,"report":{"ok":false,"path":"/var/folders/9x/52nbxvs12sx8qf_zcw752c8h0000gn/T/relayflows-schema-OZ6wFU/step-memory.flow.yaml","projectConfigPath":"/var/folders/9x/52nbxvs12sx8qf_zcw752c8h0000gn/T/relayflows-schema-OZ6wFU/flows.json","gates":[{"stepId":"script","kind":"data","checks":["exit_code"],"evaluator":"kernel","preflightable":true,"replayable":true},{"stepId":"reason","kind":"data","checks":["completion"],"evaluator":"kernel","preflightable":true,"replayable":true},{"stepId":"agent","kind":"data","checks":["completion"],"evaluator":"kernel","preflightable":true,"replayable":true}],"resolutions":[{"stepId":"reason","cli":"claude","source":"step"},{"stepId":"agent","cli":"claude","source":"step"}],"diagnostics":[{"severity":"warning","kind":"unprovable_effects","stepId":"script","message":"Step \"script\" command \"echo\" resolves, but its effects cannot be proven before execution."},{"severity":"refusal","kind":"cli_unauthenticated","stepId":"reason","cli":"claude","message":"Step \"reason\" declares CLI \"claude\", but \"claude auth status\" exited non-zero; authenticate it or repair that adapter's authentication probe."},{"severity":"refusal","kind":"cli_unauthenticated","stepId":"agent","cli":"claude","message":"Step \"agent\" declares CLI \"claude\", but \"claude auth status\" exited non-zero; authenticate it or repair that adapter's authentication probe."},{"severity":"warning","kind":"editor_schema_missing","message":"For editor validation, add this first line: # yaml-language-server: $schema=https://schema.relayflows.dev/v0.1/flows.schema.json"}]}}

Expected: false
Received: true

      at <anonymous> (/Users/will/Projects/AgentWorkforce/flows/packages/schema/tests/parity.test.ts:37:56)
(fail) flows check fixture parity: step-memory.flow.yaml [2611.13ms]
(pass) flows check fixture parity: step-placement.flow.yaml [3.93ms]
(pass) flows check fixture parity: tick-heartbeat.flow.yaml [35.55ms]
(pass) structural parity: unknown root key [0.81ms]
(pass) structural parity: unsupported version [0.06ms]
(pass) structural parity: no steps [0.01ms]
(pass) structural parity: step typo [0.19ms]
(pass) structural parity: empty command [0.11ms]
(pass) structural parity: positive timeout [0.15ms]
(pass) structural parity: fractional retry [0.10ms]
(pass) structural parity: wrong step field [0.09ms]
(pass) structural parity: nonzero exit gate [0.28ms]
(pass) structural parity: legacy zero exit gate [0.09ms]
(pass) structural parity: boolean schema [0.67ms]
(pass) structural parity: nested invalid schema [5.16ms]
(pass) structural parity: bad memory budget [0.20ms]
(pass) structural parity: unsafe memory budget [0.07ms]
(pass) structural parity: empty memory query [0.05ms]
(pass) structural parity: unsafe duration [0.12ms]
(pass) structural parity: bad money [0.14ms]
(pass) structural parity: bad input index [0.17ms]
(pass) structural parity: blank input name [0.13ms]
(pass) structural parity: trigger silence budget [0.06ms]
(pass) structural parity: llm: output object [8.76ms]
(pass) structural parity: llm: boolean output [0.12ms]
(pass) structural parity: llm: output and verification [3.99ms]
(pass) structural parity: llm: exit gate [0.11ms]
(pass) structural parity: llm: trimmed model [0.05ms]
(pass) structural parity: llm: control in model [0.04ms]
(pass) structural parity: agent: output object [12.46ms]
(pass) structural parity: agent: boolean output [0.17ms]
(pass) structural parity: agent: output and verification [4.33ms]
(pass) structural parity: agent: exit gate [0.24ms]
(pass) structural parity: agent: trimmed model [0.05ms]
(pass) structural parity: agent: control in model [0.04ms]
(pass) step examples compile and validate [0.80ms]
(pass) generated schema satisfies the existing bounded-reference rule [3.90ms]
(pass) semantic checks remain explicit runtime responsibilities [0.63ms]
(pass) embedded dialect http://json-schema.org/draft-04/schema# [6.53ms]
(pass) embedded dialect http://json-schema.org/draft-06/schema# [6.60ms]
(pass) embedded dialect http://json-schema.org/draft-07/schema# [5.59ms]
(pass) embedded dialect https://json-schema.org/draft/2019-09/schema [15.35ms]
(pass) embedded dialect https://json-schema.org/draft/2020-12/schema [10.44ms]
(pass) header hint is warning-only, first-line aware, and never edits input [15.22ms]
(pass) canonical surface parity: "repo" [0.21ms]
(pass) canonical surface parity: "/repo/src" [0.05ms]
(pass) canonical surface parity: "pr://github/example" [0.04ms]
(pass) canonical surface parity: "/" [0.04ms]
(pass) canonical surface parity: "pr://" [0.09ms]
(pass) canonical surface parity: "" [0.07ms]
(pass) canonical surface parity: " repo" [0.05ms]
(pass) canonical surface parity: "repo " [0.03ms]
(pass) canonical surface parity: "repo//src" [0.02ms]
(pass) canonical surface parity: "repo/../src" [0.02ms]
(pass) canonical surface parity: "repo/." [0.10ms]
(pass) canonical surface parity: ":/bad//path" [0.11ms]
(pass) named declarations and selected input paths use authoring shapes [25.57ms]

tests/generation.test.ts:
(pass) generates readonly scope arrays as strict JSON arrays without schema drift [208.01ms]

2 tests failed:
(fail) npm tarball contains only data and documentation with no runtime dependencies [431.23ms]
(fail) flows check fixture parity: step-memory.flow.yaml [2611.13ms]

 68 pass
 2 fail
 3883 expect() calls
Ran 70 tests across 3 files. [5.14s]
error: script "test" exited with code 1
```

Exit code: 1.

The initial local-tool attempt used Bun 1.3.4 and npm 12.0.1. Its package-report
and fixture failures are preserved above. The successful run used Bun 1.4.0
and npm 10.9.4 installed under `/tmp/flows-ci-toolchain`, with local process
access. The test files and production validation were unchanged between those
attempts. The new regression covers real generation and rejects non-string
array elements for both workspace and tool scopes.

