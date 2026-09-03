# SIGNOFF A — SDK/kernel structure and parity, PR #138

- **Exact head:** `0c859270801e058bd59b76a72848b6480a740de6`
- **Merge base:** `a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2`
- **Scope:** assessment only. No product code, gate, push, or merge was changed.
- **Constitution:** `AGENTS.md` and `docs/RFC-0001-everything-is-a-relayflow.md` read in full.

## VERDICT

COMPREHENSIVELY_SATISFIED

**Rationale.** The head keeps `timeoutMs` on the deterministic authoring and
kernel variants only; all public validation, compilation, lowering, compiled-
dialect conversion, and `flows check` reject it on `llm`/`agent` before a
probe. The SDK and core kernel both use iterative dependency walking, accept a
10,000-node reverse-order DAG, and report a typed cycle failure without a
stack abort. The type-test program is part of both package `typecheck` and
`npm test`; the focused package type tests ran. The new kernel helper is a
small pure `std::collections` module, and `relayflowd-core` retains no provider
dependency or tenant/product concern. The v0.1.0 three-rung ladder remains
accepted by the core suite.

**Evidence.** Literal commands and output are captured below.

**Risk.** No product finding. The host's `/opt/homebrew/bin/npm` hangs even for
`npm --version`, so I could not execute the literal top-level `npm test`
command here. I instead used an isolated temporary SDK copy linked to the
already-installed dependency set, ran the package's exact `typecheck` script,
built it, and ran the focused tests. This is a test-host limitation, not a
claim that the full package suite passed.

## Review boundary

Literal command:

```sh
git status --short && git rev-parse HEAD && git show -s --format='%H%n%P%n%s' HEAD && git branch --show-current && git log --oneline --decorate -12 && git merge-base HEAD origin/main
```

Captured output:

```text
0c859270801e058bd59b76a72848b6480a740de6
0c859270801e058bd59b76a72848b6480a740de6
1c6f8a4aa46adf48a648c4ab5d25c36df2f5fbb4
fix(kernel): validate deep dependency graphs iteratively
review/pr138-signoff-a
0c85927 (HEAD -> review/pr138-signoff-a, origin/feat/v2-field-lint, review/pr138-signoff-b, feat/v2-field-lint) fix(kernel): validate deep dependency graphs iteratively
1c6f8a4 fix(sdk): close timeout and dependency boundaries
22c7d31 (review/pr138) fix(sdk): harden malformed step validation
39d535c fix(sdk): refuse fields outside step verb schemas
a0d42ff (origin/main, origin/HEAD, main, flow/lead-0902-reconcile) feat(release): build verified Cloud v2 runtime artifact (#131)
51415d9 feat(gate2): real Claude analyzer for hn-monitor, with a declared model (#130)
7728565 (flow/lead-0902-reconcile-wt) feat(factory): concurrent Claude Code authoring driver over ops/factory/queue.md (#126)
7b115bd feat(sdk): expose wake_context to agent CLIs via RELAYFLOW_WAKE_CONTEXT (#125)
3855099 feat(sdk): AgentWorker promotes CLI JSON output for json_schema verification (#124)
c3ee4eb feat(preswarm): 3-lens pre-swarm check as a relayflow (#123)
a774d88 feat(kernel): trigger-plane liveness sweep — RFC-0001 gate 2 done-when (#122)
5835cba docs(state): gate 2 evidence citation — iter 5 (all-runs survey + narrowed scope) (#121)
a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2
```

Literal command:

```sh
git diff --stat a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2..0c859270801e058bd59b76a72848b6480a740de6 && git diff --name-status a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2..0c859270801e058bd59b76a72848b6480a740de6
```

Captured output:

```text
 kernel/relayflowd-core/src/spec.rs              |  30 +-
 kernel/relayflowd-core/src/spec/dependencies.rs |  54 ++++
 kernel/relayflowd-core/src/spec/tests.rs        |  41 ++-
 sdk/package.json                                |   4 +-
 sdk/src/compile.ts                              |  21 +-
 sdk/src/failure-kinds.ts                        |  16 +-
 sdk/src/index.ts                                |   2 +
 sdk/src/preflight.ts                            |  16 ++
 sdk/src/spec.ts                                 |   3 +-
 sdk/src/step-dependencies.ts                    |  79 ++++++
 sdk/src/step-fields.ts                          |  21 ++
 sdk/src/validate.ts                             |  62 +---
 sdk/tests/dependency-validation.test.ts         |  67 +++++
 sdk/tests/preflight.test.ts                     |   4 +
 sdk/tests/validate.test.ts                      |   2 +-
 sdk/tests/verb-field-lint.test.ts               | 360 ++++++++++++++++++++++++
 sdk/tsconfig.type-tests.json                    |   9 +
 sdk/type-tests/step-fields.ts                   |  40 +++
 18 files changed, 730 insertions(+), 101 deletions(-)
M	kernel/relayflowd-core/src/spec.rs
A	kernel/relayflowd-core/src/spec/dependencies.rs
M	kernel/relayflowd-core/src/spec/tests.rs
M	sdk/package.json
M	sdk/src/compile.ts
M	sdk/src/failure-kinds.ts
M	sdk/src/index.ts
M	sdk/src/preflight.ts
M	sdk/src/spec.ts
A	sdk/src/step-dependencies.ts
A	sdk/src/step-fields.ts
M	sdk/src/validate.ts
A	sdk/tests/dependency-validation.test.ts
M	sdk/tests/preflight.test.ts
M	sdk/tests/validate.test.ts
A	sdk/tests/verb-field-lint.test.ts
A	sdk/tsconfig.type-tests.json
A	sdk/type-tests/step-fields.ts
```

## timeoutMs is closed at every relevant boundary

`BaseStepSpec` has no timeout, the deterministic variant declares it, and the
single authoring descriptor admits it only for `deterministic`. The lowerer
emits `timeout_ms` only in that branch. The CLI recognizes snake-case
`timeout_ms` as a compiled-dialect marker, then sends it through the
type-specific compiled-dialect conversion rather than treating it as authoring
data. The Rust boundary uses matching closed key sets and its
`StepKind::Deterministic` owns the field.

Literal command:

```sh
nl -ba sdk/package.json | sed -n '18,33p'
nl -ba sdk/src/spec.ts | sed -n '96,120p'
nl -ba sdk/src/step-fields.ts | sed -n '1,24p'
nl -ba sdk/src/compile.ts | sed -n '145,166p;336,370p'
nl -ba sdk/src/cli/check.ts | sed -n '230,257p'
nl -ba kernel/relayflowd-core/src/spec.rs | sed -n '154,188p;240,262p;490,510p'
```

Captured output:

```text
    25    "typecheck": "tsc --noEmit && tsc -p tsconfig.type-tests.json",
    27    "test": "npm run test:prep && npm run typecheck && npm run build && vitest run",
   103    maxIterations?: number;
   104  }
   111  export interface DeterministicStepSpec extends BaseStepSpec {
   112    type: 'deterministic';
   113    command: string;
   115    timeoutMs?: number;
   116  }
    17  export const STEP_FIELDS_BY_TYPE = {
    18    deterministic: ['command', 'timeoutMs'],
    19    llm: ['prompt', 'model', 'cli'],
    20    agent: ['instruction', 'cli', 'model', 'surfaces', 'recoveryMode', 'permissions'],
    21  } as const satisfies Record<StepType, readonly string[]>;
   152  export function toKernelSpec(flow: FlowSpec): KernelRunSpec {
   153    const validation = validateSpec(flow);
   154    if (!validation.ok) throw new CompileError(validation.errors);
   344    switch (step.type) {
   345      case 'deterministic':
   350          ...(step.timeoutMs !== undefined ? { timeout_ms: step.timeoutMs } : {}),
   352      case 'llm': {
   361      case 'agent': {
   235    const kernelStepKeys = ['depends_on', 'max_iterations', 'retry', 'timeout_ms', 'recovery_mode'];
   180  const STEP_DETERMINISTIC_FIELDS: &[&str] = &["command", "timeout_ms"];
   181  const STEP_LLM_FIELDS: &[&str] = &["prompt", "model", "cli"];
   182  const STEP_AGENT_FIELDS: &[&str] = &[
   249  pub enum StepKind {
   250      Deterministic {
   251          command: CommandSpec,
   253          timeout_ms: Option<u64>,
   255      Llm {
```

Literal direct-boundary probe (the `cli` probe intentionally throws, proving
that invalid input is refused before preflight I/O):

```sh
node --input-type=module <<'NODE'
import { validateSpec, compileSpec, toKernelSpec, preflight, kernelToAuthoring } from '/tmp/pr138-sdk-review.xM2uyV/sdk/dist/index.js';
const bad = { version: '0.1.0', steps: [{ id: 'x', type: 'llm', prompt: 'x', timeoutMs: 1 }] };
const probes = { cli: () => { throw new Error('must not probe'); }, executor: () => true, command: () => true };
const result = { validation: validateSpec(bad).errors[0], compile: null, lower: null, preflight: preflight(bad, { probes }).diagnostics[0]?.kind, compiledKernel: null };
try { compileSpec(bad); } catch (error) { result.compile = error.constructor.name; }
try { toKernelSpec(bad); } catch (error) { result.lower = error.constructor.name; }
try { kernelToAuthoring({ version: '0.1.0', steps: [{ id: 'x', type: 'llm', prompt: 'x', timeout_ms: 1 }] }); } catch (error) { result.compiledKernel = error.constructor.name; }
console.log(JSON.stringify(result));
NODE
```

Captured output:

```text
{"validation":"spec.steps[0]: unknown key \"timeoutMs\" (expected one of id | type | dependsOn | verification | maxIterations | prompt | model | cli)","compile":"CompileError","lower":"CompileError","preflight":"invalid_spec","compiledKernel":"CompileError"}
```

Literal CLI probe:

```sh
node /tmp/pr138-sdk-review.xM2uyV/sdk/dist/cli.js check /tmp/pr138-sdk-review.xM2uyV/timeout-llm.json > /tmp/pr138-sdk-review.xM2uyV/timeout.stdout 2> /tmp/pr138-sdk-review.xM2uyV/timeout.stderr
code=$?
printf 'EXIT=%s\n' "$code"
head -1 /tmp/pr138-sdk-review.xM2uyV/timeout.stderr
```

Captured output:

```text
EXIT=2
REFUSED [invalid_spec] spec.steps[0]: unknown key "timeoutMs" (expected one of id | type | dependsOn | verification | maxIterations | prompt | model | cli)
```

## Type-test wiring and SDK graph behavior

The isolated copy preserves the exact package scripts and uses only a symlink
to pre-existing `node_modules`; the reviewed worktree was not modified. The
first command is the package `typecheck` script, which includes the canonical
`tsconfig.type-tests.json`; the focused Vitest run includes the generated
per-verb-field cases and 10,000-node direct-boundary cases.

Literal command:

```sh
review_tmp=$(mktemp -d /tmp/pr138-sdk-review.XXXXXX)
printf 'TEMP=%s\n' "$review_tmp"
cp -R sdk "$review_tmp/sdk"
ln -s /Users/khaliqgant/AgentWorkforce/relay-v2-selector-wt/node_modules "$review_tmp/sdk/node_modules"
cd "$review_tmp/sdk"
bun run typecheck
bun ./node_modules/vitest/vitest.mjs run tests/dependency-validation.test.ts tests/verb-field-lint.test.ts
```

Captured output:

```text
TEMP=/tmp/pr138-sdk-review.xM2uyV
$ tsc --noEmit && tsc -p tsconfig.type-tests.json

 RUN  v4.1.8 /private/tmp/pr138-sdk-review.xM2uyV/sdk


 Test Files  2 passed (2)
      Tests  65 passed (65)
   Start at  21:41:32
   Duration  2.08s (transform 971ms, setup 0ms, import 1.61s, tests 1.06s, environment 1ms)
```

Literal build command:

```sh
cd /tmp/pr138-sdk-review.xM2uyV/sdk && bun run build
```

Captured output:

```text
$ tsc && node scripts/make-cli-executable.mjs
```

## Kernel graph behavior and purity

The core validates the existing unknown-dependency/duplicate checks before it
passes the graph to the new helper. The helper has an explicit frame stack and
returns `SpecError::DependencyCycle`; it has no I/O, provider, or tenant
dependency. The core manifest contains only serialization, hashing, schema,
error, and ID dependencies.

Literal command:

```sh
PATH=/Users/khaliqgant/.rustup/toolchains/stable-aarch64-apple-darwin/bin:/opt/homebrew/bin:/usr/bin:/bin cargo test -p relayflowd-core spec::tests
```

Captured output:

```text
    Finished `test` profile [unoptimized + debuginfo] target(s) in 3.74s
     Running unittests src/lib.rs (target/debug/deps/relayflowd_core-2074686c292a4dcb)

running 10 tests
test spec::tests::a_misspelled_step_level_key_is_a_parse_error ... ok
test spec::tests::spec_version_is_semver_and_gated ... ok
test spec::tests::unknown_root_and_nested_fields_are_rejected ... ok
test spec::tests::a_misspelled_verification_gate_key_is_a_parse_error_not_a_dropped_gate ... ok
test spec::tests::zero_agent_flow_is_valid ... ok
test spec::tests::cycles_are_rejected ... ok
test spec::tests::the_full_ladder_parses_in_the_one_dialect ... ok
test spec::tests::preflight_data_is_fail_closed ... ok
test spec::tests::sdk_boundary_rejects_a_10_000_step_cycle_with_a_typed_error ... ok
test spec::tests::sdk_boundary_accepts_a_valid_10_000_step_reverse_chain ... ok

test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 18 filtered out; finished in 7.25s

     Running tests/spec_parity.rs (target/debug/deps/spec_parity-8c2b7fd12acdd648)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 5 filtered out; finished in 0.00s
```

Literal purity command:

```sh
nl -ba kernel/relayflowd-core/src/spec/dependencies.rs | sed -n '1,62p'
nl -ba kernel/relayflowd-core/Cargo.toml | sed -n '1,20p'
```

Captured output:

```text
     1  use std::collections::{BTreeMap, BTreeSet};
     3  use super::SpecError;
     5  /// Reject dependency cycles without consuming call-stack depth from the spec.
     6  pub(super) fn validate_dependency_cycles<'a>(
    10      struct Frame<'a> {
    15      let mut visiting = BTreeSet::new();
    16      let mut visited = BTreeSet::new();
    25          let mut frames = vec![Frame {
    30          while let Some(frame) = frames.last_mut() {
    44              if !visiting.insert(dependency) {
    45                  return Err(SpecError::DependencyCycle(dependency.to_owned()));
     7  [dependencies]
     8  jsonschema.workspace = true
     9  serde.workspace = true
    10  serde_json.workspace = true
    11  sha2.workspace = true
    12  thiserror.workspace = true
    13  ulid.workspace = true
```

The full Rust result above includes the existing v0.1.0 ladder test and both
new 10,000-node SDK-boundary cases. It establishes valid reverse ordering,
typed cycle refusal, and non-recursive execution at the kernel boundary.

## Test-host limitation (non-finding)

Literal commands:

```sh
gtimeout 15s npm run typecheck
gtimeout 15s npm test
```

Captured output for each command:

```text
exit_code=124
(no stdout or stderr before timeout)
```

The package manifest shows that `npm test` invokes `npm run typecheck`; the
isolated package `bun run typecheck` execution above proves the canonical
type-test configuration itself compiles. I make no claim that the complete
`npm test` command passed on this host.
