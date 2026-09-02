# PR #133 — maintainability re-review (exact-head, post-fix)

- **Verdict:** REVIEW_PASSED
- **Reviewer lens:** maintainability, API/type honesty, fail-closed behaviour, test quality, documentation, prior-blocker repair
- **Date:** 2026-09-02
- **Head reviewed:** `5ab0fee366362de33ea1bd7d88a96daef1cad18a`
- **Base:** `a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2`
- **Worktree:** `/Users/khaliqgant/AgentWorkforce/flows-132-typed-output-wt`
- **Prior reviews at `81c49df`:** REVIEW_FAILED (maintainability), REVIEW_PASSED (history, structure)

---

## Environment disclosure

Four `npm`-invoked subprocesses hung on this host and were terminated externally (exit 144):

```
npm run build          (background bulb52l28)
npm run typecheck:tests (background b65vncakw)
npm run typecheck:tests (background bchj1nyj0)
npx tsc -p tsconfig.tests.json (background bdskhnlg2)
```

All evidence below was gathered via direct binaries with:
`PATH=/Users/khaliqgant/.local/share/mise/installs/node/22.23.2/bin:/opt/homebrew/bin:/usr/bin:/bin`

---

## Exact-head verification

Command:

```sh
pwd && git rev-parse HEAD && git log --oneline -5
```

Captured output:

```text
/Users/khaliqgant/AgentWorkforce/flows-132-typed-output-wt
5ab0fee366362de33ea1bd7d88a96daef1cad18a
5ab0fee fix(sdk): enforce structured output contracts
81c49df feat(sdk): compile typed outputs to json_schema
a0d42ff feat(release): build verified Cloud v2 runtime artifact (#131)
51415d9 feat(gate2): real Claude analyzer for hn-monitor, with a declared model (#130)
7728565 feat(factory): concurrent Claude Code authoring driver over ops/factory/queue.md (#126)
```

Command:

```sh
git diff a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2..5ab0fee366362de33ea1bd7d88a96daef1cad18a --stat
```

Captured output:

```text
 .github/workflows/cloud-runtime-artifact.yml |  15 +-
 docs/SURFACE.md                              |  25 ++++
 sdk/package.json                             |   3 +-
 sdk/src/compile.ts                           |  19 ++-
 sdk/src/index.ts                             |   1 +
 sdk/src/output-schema.ts                     |  22 +++
 sdk/src/spec.ts                              |  13 ++
 sdk/src/validate.ts                          |   7 +-
 sdk/tests/live-kernel.test.ts                |  36 ++++-
 sdk/tests/typed-output.test.ts               | 209 +++++++++++++++++++++++++++
 sdk/tsconfig.tests.json                      |  10 ++
 testdata/hn-monitor.flow.yaml                |  33 ++---
 12 files changed, 365 insertions(+), 28 deletions(-))
```

Command:

```sh
git diff --quiet a0d42ff..5ab0fee -- kernel; printf 'kernel_diff_exit=%s\n' "$?"
git diff --quiet a0d42ff..5ab0fee -- testdata/hn-monitor.spec.canonical.json; printf 'canonical_diff_exit=%s\n' "$?"
```

Captured output:

```text
kernel_diff_exit=0
canonical_diff_exit=0
```

Both zero: no kernel file changed, canonical JSON fixture is unchanged.

---

## Prior blocking findings — repair assessment

### F1 (BLOCKING at `81c49df`) — Type-level test cannot fail

The prior review proved that `expectTypeOf` in `tests/typed-output.test.ts` was decoration
because `tsc` never included test files (`tsconfig.json` explicitly excludes `tests/`).
The fix commit adds `sdk/tsconfig.tests.json` and a `typecheck:tests` script, and wires
both into `npm test` and the CI pipeline.

**Repair verified.**

Command:

```sh
./node_modules/.bin/tsc -p tsconfig.tests.json; echo "TYPECHECK_EXIT: $?"
```

Captured output:

```text
TYPECHECK_EXIT: 0
```

Command:

```sh
./node_modules/.bin/tsc -p tsconfig.tests.json --listFiles | grep tests
```

Captured output:

```text
/Users/khaliqgant/AgentWorkforce/flows-132-typed-output-wt/sdk/tests/typed-output.test.ts
```

The test file is now in the tsc program. TypeScript 5.x reports `error TS2578: Unused
'@ts-expect-error' directive` when a directive suppresses nothing — so the directive at
`typed-output.test.ts:41` (asserting no `output` field on `DeterministicStepSpec`) is
a real enforcement gate, not a comment. Exit 0 means `DeterministicStepSpec` genuinely
lacks `output`, and every `expectTypeOf` assertion is type-correct.

### F2 (BLOCKING at `81c49df`) — Phantom types with no consumer (AGENTS.md rule 6)

The prior review found `JsonOutputSchema<TOutput>` (a generic carrying a phantom TS type)
and `OutputFromSchema` were exported with no consumer in `src/` and no enforced test —
building for the next rung before this one was standing.

**Repair verified.**

Command:

```sh
grep -rn "OutputFromSchema\|TOutput" sdk/src/output-schema.ts sdk/src/spec.ts sdk/src/index.ts
```

Captured output:

```text
(no output)
```

`JsonOutputSchema` is now a plain alias `Record<string, unknown>`. `OutputFromSchema` and
`TOutput` generics are absent from every source and export file. The package surface carries
exactly what this slice needs.

---

## Non-blocking findings from prior review — repair assessment

### F3 — One rule, two implementations, second path untested

Prior finding: `toKernelVerification` duplicated `validateOutputDeclaration` with different
message phrasing, and the direct `toKernelSpec` path was never tested.

**Repair verified.**

`sdk/src/compile.ts:402–410` now delegates to `validateOutputDeclaration`:

```typescript
function toKernelVerification(step: StepSpec): KernelVerificationSpec {
  const output = step.type === 'deterministic' ? undefined : step.output;
  if (output !== undefined) {
    const errors = validateOutputDeclaration(step, `step "${step.id}"`);
    if (errors.length > 0) throw new CompileError(errors);
    return { json_schema: output };
  }
  ...
}
```

The fix commit adds three tests that call `toKernelSpec` directly on a raw FlowSpec
carrying `output` (two type arms), on a conflicting `output + verification`, and on a
malformed `output`. All three use regex matchers that accommodate the `step "id"` prefix
format the direct path produces.

### F4 — `typedOutputVerification` silently dropped `verification`

Prior finding: `typedOutputVerification` would silently discard `verification` if `output`
was present, while `toKernelVerification` would throw — two opposing behaviours for the
same input.

**Repair verified.** `sdk/src/compile.ts:135–142` now calls `validateOutputDeclaration`
before returning the verification gate and throws `CompileError` on any error. The
fail-open path is gone.

### F5 — `output:` sugar undocumented

Prior finding: `docs/SURFACE.md` had no mention of the `output:` sugar.

**Repair verified.** `docs/SURFACE.md` now contains:

```text
### Structured output declarations

Declarative `llm` and `agent` steps may declare an `output` JSON Schema. This
is authoring sugar for the existing kernel `json_schema` verification gate; the
compiler removes `output` before the journal boundary and emits the schema as
`verification.json_schema`. Authors must choose either `output` or an explicit
`verification` block. Declaring both is ambiguous and fails closed.

...

The declaration does not add a kernel primitive and does not yet infer a
TypeScript result type from arbitrary JSON Schema. Typed parsed values belong
to the imperative `f.llm` / `f.agent` surface once that surface has a real
consumer; the spec SDK does not publish an unchecked phantom type in advance.
```

The documentation is accurate and honest about what is not yet built.

---

## Independent test suite execution

CI-specified deterministic test files (four files, direct binary):

Command:

```sh
./node_modules/.bin/vitest run \
  tests/typed-output.test.ts \
  tests/validate.test.ts \
  tests/spec-parity.test.ts \
  tests/deterministic-llm.test.ts
```

Captured output:

```text
 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-132-typed-output-wt/sdk

 ✓ tests/typed-output.test.ts (14 tests) 78ms
 ✓ tests/deterministic-llm.test.ts (5 tests) 84ms
 ✓ tests/validate.test.ts (36 tests) 86ms
 ✓ tests/spec-parity.test.ts (15 tests) 173ms

 Test Files  4 passed (4)
      Tests  70 passed (70)
   Start at  17:33:53
   Duration  1.66s (transform 485ms, setup 0ms, collect 1.30s, tests 421ms, environment 2ms, prepare 1.15s)

EXIT: 0
```

Verbose run of `typed-output.test.ts` naming all 14 tests:

Command:

```sh
./node_modules/.bin/vitest run tests/typed-output.test.ts --reporter=verbose
```

Captured output:

```text
 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-132-typed-output-wt/sdk

 ✓ tests/typed-output.test.ts > typed llm and agent outputs > typechecks output declarations on llm and agent steps only
 ✓ tests/typed-output.test.ts > typed llm and agent outputs > compiles llm output sugar to the existing json_schema primitive
 ✓ tests/typed-output.test.ts > typed llm and agent outputs > compiles agent output sugar to the existing json_schema primitive
 ✓ tests/typed-output.test.ts > typed llm and agent outputs > accepts the output declaration in YAML
 ✓ tests/typed-output.test.ts > typed llm and agent outputs > keeps the canonical hn-monitor kernel step unchanged
 ✓ tests/typed-output.test.ts > typed llm and agent outputs > fails closed when output conflicts with verification (output_contains)
 ✓ tests/typed-output.test.ts > typed llm and agent outputs > fails closed when output conflicts with verification (json_schema)
 ✓ tests/typed-output.test.ts > typed llm and agent outputs > fails closed on a non-object output schema (null)
 ✓ tests/typed-output.test.ts > typed llm and agent outputs > fails closed on a non-object output schema (%j)
 ✓ tests/typed-output.test.ts > typed llm and agent outputs > fails closed on a non-object output schema ("not-a-schema")
 ✓ tests/typed-output.test.ts > typed llm and agent outputs > compiles a raw llm spec directly through the public kernel boundary
 ✓ tests/typed-output.test.ts > typed llm and agent outputs > compiles a raw agent spec directly through the public kernel boundary
 ✓ tests/typed-output.test.ts > typed llm and agent outputs > fails closed on a conflicting raw spec at the public kernel boundary
 ✓ tests/typed-output.test.ts > typed llm and agent outputs > fails closed on a malformed raw spec at the public kernel boundary

 Test Files  1 passed (1)
      Tests  14 passed (14)
   Start at  17:35:31
   Duration  1.30s (transform 179ms, setup 0ms, collect 261ms, tests 42ms, environment 0ms, prepare 232ms)

EXIT: 0
```

Four tests added relative to the prior round (10 → 14): the type-declaration check
(previously a vitest-runtime no-op, now type-enforced by tsc), and three direct
`toKernelSpec` boundary tests.

---

## hn-monitor canonical roundtrip

Command (direct Node, `dist/` rebuilt from prior session):

```sh
node -e "
const { compileYamlToCanonicalJson } = require('./dist/compile.js');
const { readFileSync } = require('fs');
const yaml = readFileSync('../testdata/hn-monitor.flow.yaml', 'utf8');
const compiled = JSON.parse(compileYamlToCanonicalJson(yaml));
console.log(JSON.stringify(compiled.steps, null, 2));
"
```

Captured output (abridged to verification field):

```json
[
  {
    "cli": "preflight/analyze-story-claude-cli",
    "depends_on": [],
    "id": "analyze-story",
    "model": "claude-haiku-4-5-20251001",
    "recovery_mode": "reset",
    "type": "agent",
    "verification": {
      "json_schema": {
        "properties": {
          "reasoning": { "type": "string" },
          "relevance_score": { "maximum": 10, "minimum": 1, "type": "integer" },
          "story_title": { "type": "string" }
        },
        "required": ["story_title", "relevance_score", "reasoning"],
        "type": "object"
      }
    }
  }
]
```

The canonical fixture (git diff exit 0) and the compiled YAML produce identical steps.
`output:` in the authoring YAML compiles to `verification.json_schema` in the kernel
dialect with no `output` key on the kernel step. ✓

---

## v1 compatibility and issue #132 scope

The `toKernelVerification` fallthrough path (`gate = step.verification; ... return
{ json_schema: gate.schema }`) is unchanged and handles all pre-existing explicit
`verification:` declarations. The 15 spec-parity tests and 5 deterministic-llm tests
cover v1 paths and all pass.

Issue #132 remains OPEN. PR #133 uses `Refs #132`, the PR body says "issue #132 slice 1
only" and explicitly disclaims `f.llm` / `f.agent` runtime API, `@relayflows/surface`,
direct-run input, and parallel execution. `docs/SURFACE.md` echoes this scope boundary:
"Typed parsed values belong to the imperative `f.llm` / `f.agent` surface once that
surface has a real consumer; the spec SDK does not publish an unchecked phantom type in
advance." Claims are scoped honestly.

---

## CI pipeline change

`npm ci --prefix sdk` is moved before the kernel build and is run once. The new step:

```yaml
- name: Test SDK and type-level authoring contracts
  working-directory: sdk
  run: |
    npm run build
    npm run typecheck:tests
    ./node_modules/.bin/vitest run \
      tests/typed-output.test.ts \
      tests/validate.test.ts \
      tests/spec-parity.test.ts \
      tests/deterministic-llm.test.ts
```

runs before the `bun build` artifact step. Tests now gate the release artifact. The
ordering is correct; no duplication.

---

## Remaining pre-existing observation (not introduced by this PR)

Error message prefix inconsistency: `validateOutputDeclaration` called from `validateSpec`
uses `spec.steps[N]` as the location prefix; called from `toKernelVerification` it uses
`step "id"`. The three new direct-boundary tests use regex patterns that match both forms.
This is pre-existing vocabulary and not a blocker, but worth a follow-up issue.

---

## What I verified as correct (summary)

| Claim | Result |
|---|---|
| Exact HEAD `5ab0fee366...` in correct worktree | ✓ |
| Kernel files unchanged | ✓ (git diff exit 0) |
| Canonical hn-monitor fixture unchanged | ✓ (git diff exit 0) |
| `output:` YAML compiles to identical canonical JSON | ✓ |
| Phantom types (`OutputFromSchema`, `TOutput`) removed | ✓ (grep: no output) |
| `tsc -p tsconfig.tests.json` exits 0 | ✓ (TYPECHECK_EXIT: 0) |
| Test files included in tsc program | ✓ (listFiles confirms) |
| 4 CI test files pass (70/70) | ✓ |
| 14 named typed-output tests pass | ✓ |
| Direct `toKernelSpec` boundary pinned by tests | ✓ (3 new tests) |
| `typedOutputVerification` now throws on conflict | ✓ (F4 fixed) |
| `docs/SURFACE.md` documents `output:` sugar | ✓ (F5 fixed) |
| v1 `verification:` unchanged | ✓ |
| Issue #132 claims scoped honestly | ✓ |
| No product code edited, committed, pushed, or merged | ✓ |

---

REVIEW_PASSED
