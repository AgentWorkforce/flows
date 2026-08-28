# PR #8 — maintainability review

**Lens:** could a stranger read this in six months and change it safely?
**Scope:** code + preflight docs shipped in PR #8 (docs/SURFACE.md, sdk/src/*,
sdk/tests/*, kernel/relayflowd-core/src/spec.rs, spec/tests.rs, machine/tests.rs,
testdata/preflight/*, ops/BACKLOG.md). Non-code ops files (DRIVE-LOG,
NEXT, SCOREBOARD, prior review markdown) are outside the code lens.

## Summary

The code is unusually legible for a first-cut boundary. Failure kinds are
closed unions on both sides (`PREFLIGHT_FAILURE_KINDS`,
`PREFLIGHT_WARNING_KINDS` in `sdk/src/failure-kinds.ts`; `CompletionReason` in
`kernel/relayflowd-core/src/entry.rs:159`), naming is direct, the
authoring/kernel dialect split has one owner (`toKernelSpec` /
`kernelToAuthoring` in `sdk/src/compile.ts`), and preflight I/O is factored
behind an injected `PreflightProbes` interface so the pure logic is
testable without side effects. Comments explain *why*, not *what*, in most
places. A six-month reader can reasonably orient.

The findings below are the surfaces that will bite a future contributor —
implicit contracts, comment claims a stranger cannot verify from the code
alone, and tests that pass under mutations they should catch.

## Findings

### M1 — Fail-closed claim on `CompletionReason` is not enforced by the closed-enum test (maintainability, medium)

`kernel/relayflowd-core/src/machine/tests.rs:65-105` (new in this PR) iterates
a **hard-coded array** of eight `CompletionReason` variants and asserts each
terminates the run with `RunCompletionReason::StepFailed`:

```rust
let failure_reasons = [
    CompletionReason::VerificationFailed,
    CompletionReason::RetriesExhausted,
    CompletionReason::LeaseExpired,
    CompletionReason::Crashed,
    CompletionReason::Timeout,
    CompletionReason::WorkerError,
    CompletionReason::BudgetExceeded,
    CompletionReason::Canceled,
];
```

`CompletionReason` at `kernel/relayflowd-core/src/entry.rs:159` is a closed
Rust enum. If a future contributor adds a variant (e.g. `NeedsHuman`,
`EnvironmentLost` — both named in RFC-0001 §1 covenant 2), the compiler will
not force this test to grow, and the test title
(`every_failed_run_terminates_with_declared_completion_reasons`) will start
lying: it will pass with the new variant untested. That is exactly the
"tests that would not fail if the behavior broke" shape.

Contrast the sibling TypeScript test at
`sdk/tests/preflight.test.ts:177` — it iterates
`PREFLIGHT_FAILURE_KINDS` from the source and asserts
`new Set(refusalKinds) === new Set(PREFLIGHT_FAILURE_KINDS)`, which *does*
force an update when a new kind is declared. The Rust side should do the
same — a `match reason { … }` inside the test body (or a
`CompletionReason::ALL` slice / `strum::EnumIter`) makes the closed-set
claim compiler-checked. Without it, "the failure taxonomy is closed"
(RFC-0001 §3, gate 1) has a soft edge exactly where the RFC says it should
not.

**Fix sketch:** replace the array literal with a `match` over
`CompletionReason::Success | CompletionReason::VerificationFailed | …` that
partitions success/failure, so a new variant produces a compile error until
the test is extended. Alternatively, expose an
`impl CompletionReason { const FAILURE: &[Self] = &[…]; }` next to the enum
definition, and iterate it from the test — one place to update, no way to
forget.

### M2 — `kernelDialectMarker` duplicates the kernel field list with no single-source guard (maintainability, medium)

`sdk/src/cli.ts:262-284` classifies a spec as kernel-dialect vs. authoring
by looking for any of a hand-maintained snake_case key list:

```ts
const kernelStepKeys = ['depends_on', 'max_iterations', 'retry',
                        'timeout_ms', 'recovery_mode'];
const kernelBudgetKeys = ['max_tokens_in', 'max_tokens_out', 'max_dollars'];
const kernelVerificationKeys = ['output_contains', 'json_schema'];
const kernelPermissionKeys = ['file_globs', 'network_allowlist',
                              'access_preset'];
```

The comment names the constraint ("Compiler-emitted kernel specs always
carry `retry`; the additional shapes cover other producers that omit
default fields"), which is honest — but there is no cross-check with
`KernelStepSpec` / `KernelBudgetSpec` in `sdk/src/spec.ts`, so a kernel
field added to `spec.rs` (e.g. a future `stream_pins` on agent steps, an
extra `budget.max_seconds`) can silently break dialect detection. Failure
mode: an author's YAML would be validated as authoring input, `unknown key`
errors would fire against the wrong dialect, and the "read as compiled
kernel spec because …" branch (`cli.ts:128-131`) would never activate for
that field. The mixed-dialect error message that the CLI test at
`sdk/tests/cli.test.ts:96-99` relies on would degrade silently.

The RFC's stated escape hatch is that "the composable unit is the spec"
(settled decision #5). That places the burden of keeping this list current
on the SDK, but nothing in the repo binds them. Options, ordered by cost:
(a) derive the list from the exported `KernelStepSpec` / `KernelBudgetSpec`
key sets in a small helper next to `spec.ts`; (b) add a parity test that
introspects the type definitions (harder in TS) or the canonical fixture
(`testdata/hello-ladder.spec.canonical.json`) and asserts every snake_case
key in a canonical kernel spec is discoverable by this heuristic;
(c) failing both, add a comment above the list stating "kept in sync with
KernelStepSpec / KernelBudgetSpec / KernelVerificationSpec /
KernelPermissionsSpec in spec.ts — updating one requires updating this
list" and a matching pointer near those types.

### M3 — "The journal client's direct `run.start` path does not invoke surface preflight" is an implicit contract with no in-code marker (maintainability, medium)

`docs/SURFACE.md` (new copy) says:
> Gate 1 does not make this guarantee for callers that bypass
> `flows check`: the journal client's direct `run.start` path does not
> invoke surface preflight.

This is load-bearing — it draws the boundary between the SDK's covenant-2
guarantees and what the kernel accepts. But nothing on the code side flags
the split: `JournalClient` (exported from `sdk/src/index.ts:114`) does not
mention preflight in its type or a `TODO` comment, and `RunSpec::parse` in
`kernel/relayflowd-core/src/spec.rs:53-62` doesn't note that its callers
skip preflight. A stranger writing a new caller of `JournalClient` or a
new entry point on the kernel side would not learn this from the code.

The RFC discipline in AGENTS.md rule 3 ("the journal protocol is the
boundary") makes this asymmetry deliberate, but discoverable-in-code is
the whole point of six-month maintainability. Add a one-line comment at
the `RunSpec::parse` docstring or on `JournalClient.runStart` (whichever
exists) that names the gap and points at SURFACE.md, so the invariant is
readable where the code lives.

### M4 — `readProjectConfig` silently masks an unreadable-but-present `flows.json` (maintainability + failure handling, low–medium)

`sdk/src/cli.ts:163-177`:

```ts
function findConfig(start: string): string | undefined {
  let directory = start;
  while (true) {
    const candidate = join(directory, 'flows.json');
    try {
      accessSync(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Continue toward the filesystem root.
    }
    ...
  }
}
```

Every failure from `accessSync` — `ENOENT` (does not exist) and `EACCES`
(exists but not readable) — is coerced to "keep walking." Consequences:

- If a `flows.json` in an intermediate directory is unreadable due to
  permissions, walk continues, an outer (grandparent) `flows.json` is
  found, and its `cli`/`executors` are silently used. RFC-0001 §5
  (`docs/SURFACE.md`) makes the *nearest* config a hard boundary
  ("prevents accidental inheritance of outer credentials or executors").
  The current behavior violates that boundary under a subtle failure mode.
- If no readable config exists at all, the CLI reports "no CLI at step,
  flow, or project level" (`preflight.ts:115-122`) even though an
  unreadable-but-present config was the actual cause.

A stranger will not read this comment (`Continue toward the filesystem
root`) as covering EACCES — the comment describes intent, not the failure
class it silently absorbs.

**Fix:** narrow the `catch` to `ENOENT`, and let other codes escalate as a
`config_invalid` refusal (or a new dedicated kind). The failure kind is
already `CheckFailureKind`-typed; adding a case is cheap.

### M5 — `firstCommandWord` regex silently misclassifies leading env-var assignments (maintainability, low)

`sdk/src/preflight.ts:280-283`:

```ts
function firstCommandWord(command: string): string | undefined {
  const match = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}
```

The block comment at `preflight.ts:229-236` correctly acknowledges that
`/bin/sh -c` may host builtins, functions, **or assignments**. But the
regex still extracts the first whitespace-delimited token. For a command
like `FOO=bar cmd baz`, `firstCommandWord` returns `FOO=bar`, which will
not resolve as an executable, so `warnOnUnprovableEffects` emits
`command_unresolved` — misleading, because the *actual* command is `cmd`.
The doc claims "warns rather than refuses because … an unresolved first
word may still be a shell builtin, function, or assignment," but the code
does not detect the assignment case; the warning kind and message are
wrong. A stranger debugging why a valid flow emits `command_unresolved`
will chase the wrong tail.

Either (a) detect `^[A-Za-z_][A-Za-z0-9_]*=` and emit `command_unprovable`
(honest: "we can't tell what your assignment-prefixed command runs"), or
(b) shorten the comment to match what the code actually does. The current
combination is a comment that overstates the code.

### M6 — `probeCli` cache key uses `JSON.stringify([cli, source])` for what is a two-tuple — cheap correctness footgun (maintainability, low)

`sdk/src/preflight.ts:144`:

```ts
const cacheKey = JSON.stringify([resolution.cli, resolution.source]);
```

A stranger reading this line has to reason about JSON.stringify collisions
across arbitrary CLI strings that might contain `","`. `JSON.stringify` is
lossless for two strings, so it's correct today — but the intent is "key
by (cli, source)", not "produce a canonical serialization." A
`` `${resolution.cli} ${resolution.source}` `` or a nested `Map<string,
Map<string, CliProbeOutcome>>` communicates the intent directly. Minor,
but the file's other comments are careful about "source is load-bearing"
(`preflight.ts:141-143`); the cache-key line does not match that care.

### M7 — `LADDER_FAULTS` cli_unresolved mutator is an empty function whose entire meaning is a comment (maintainability, low)

`sdk/tests/cli.test.ts:64-74`:

```ts
const LADDER_FAULTS = [
  ['cli_missing', (flow) => { flow['cli'] = join(PREFLIGHT, 'absent-cli'); }],
  ['cli_unauthenticated', (flow) => { flow['cli'] = join(PREFLIGHT, 'unauthenticated-cli'); }],
  // Relocation into ladderVariant's empty flows.json is the fault: it removes
  // the project CLI fallback, while the ladder YAML itself has no cli field.
  ['cli_unresolved', () => {}],
  ...
];
```

The comment is accurate, but the noop lambda invites future tidying —
"why is this empty?" A reader might rewrite the array to only carry
mutators that mutate. If they do, the `cli_unresolved` matrix cell will
silently start passing (no fault induced ≡ no refusal), and the parametric
`.each` will still be green because the ladder YAMLs *without* a flow-level
cli continue to refuse `cli_unresolved` via the empty `flows.json`. So the
test would look correct, but the guarantee would drift: the assertion
"every ladder flow refuses cli_unresolved when relocated to an empty
project" would no longer be forced by the LADDER_FAULTS array — it would
be forced by a side effect of `ladderVariant`.

Suggest either (a) folding this case into its own explicit `it` block
whose name states the invariant ("refuses cli_unresolved when relocated
to an empty flows.json project"), or (b) making the mutator do something
observable like `delete flow['cli']` (a no-op if not present, but reads
as "we deliberately ensure no flow-level cli"). The current shape leans
on a comment nobody has to preserve.

### M8 — `resolveExecutable` hard-codes Unix `which` with no cross-platform note (maintainability, low)

`sdk/src/cli.ts:210` invokes `spawnSync('which', [command], …)` to resolve
a bare CLI name against `PATH`. On Windows this binary does not exist by
default (`where.exe` is the analogue). The whole preflight probe layer
also assumes `/bin/sh -c` semantics (see `docs/SURFACE.md` and the block
comment at `preflight.ts:229-236`). A future contributor porting this
past macOS/Linux will hit this in `resolveExecutable` first — and the
error surface will be `probe_failed / spawn_failed`, obscuring the real
cause.

Not a bug for gate 1 (target platforms are Unix-like), but the file has
no comment saying so. Add one line: `// Unix-only: relies on 'which' and
/bin/sh -c semantics. Windows support is deferred; see …`. A stranger
who reads the classifier and sees `spawn_failed` on Windows should be
able to trace the cause to a single documented spot, not to
`spawnSync('which', …)` archaeology.

### M9 — `emitReport` interleaves ok-report stdout with failure diagnostics on stderr; no test pins the ordering contract (maintainability, low)

`sdk/src/cli.ts:245-260` writes diagnostics to stderr first, then in
non-JSON mode writes `RESOLVED …` lines to stdout, and finally
`CHECK PASSED` when `ok`. Scripting on this output shape is a plausible
future ask (CI parsers, sage's compile step). No test asserts the
stream/order contract; the diagnostics-to-stderr behavior in
`sdk/tests/cli.test.ts:88-92` etc. only checks *containment*, not
ordering or which stream carries what. If a future refactor moves
`RESOLVED` to stderr for "grouping," downstream parsers break silently.

Small fix: one test asserts that on a passing report `stdout` contains
`RESOLVED` and `CHECK PASSED` in that order and `stderr` may only contain
`WARNING`; on a refused report, `stderr` contains `REFUSED` before the
report, and `stdout` contains no `CHECK PASSED`.

### M10 — `validateSpec`'s `ROOT_KEYS`/`STEP_TYPE_KEYS` and the kernel's `STEP_*_FIELDS` are parallel truths with no single source (maintainability, medium)

Two independent key lists must agree by convention:

- `sdk/src/validate.ts:44-51` `ROOT_KEYS`, `STEP_COMMON_KEYS`,
  `STEP_TYPE_KEYS` for authoring input.
- `kernel/relayflowd-core/src/spec.rs:136-152` `STEP_COMMON_FIELDS`,
  `STEP_DETERMINISTIC_FIELDS`, `STEP_LLM_FIELDS`, `STEP_AGENT_FIELDS` for
  the kernel dialect.

Parity between the SDK and the kernel is pinned by
`sdk/tests/spec-parity.test.ts` and the kernel's `tests/spec_parity.rs`
via a canonical fixture — but that fixture is one flow. It exercises the
happy path of "known keys marshal identically." It does not force parity
on rejection: if the SDK adds a new authoring field that the compiler
strips before boundary emission (e.g. an authoring-only `stage` field),
and the kernel simultaneously adds a matching snake_case field
(`stage_of_run`), nothing in this repo notices divergence unless a human
walks all four lists.

The reader-safety impact: a stranger asked to add a field faces four
touchpoints (`spec.ts`, `validate.ts`, `compile.ts`, kernel `spec.rs`) and
one hidden coupling (`cli.ts` `kernelDialectMarker`, see M2). None of them
lists the others in-code. The RFC calls the spec "the boundary" — the
code would land closer to that intent with a comment at each of the four
sites pointing to "the boundary is `KernelRunSpec` — update this in
lockstep with the marker in cli.ts and the Rust `STEP_*_FIELDS`."

## Non-findings (worth naming so they aren't re-raised)

- **`isDirectInvocation` swallowing `realpathSync` errors** at
  `sdk/src/cli.ts:298-307` — the comment justifies the choice
  (missing/deleted argv[1] → treat as import) and it does not affect the
  refusal path. Fine.
- **`checkKeys` reporting only the nearest key** — the `nearestKey` +
  `levenshtein` combo (`validate.ts:408-436`) is small enough, tested
  against `depends_on → dependsOn`, and its "one suggestion, plus fallback"
  behavior is legible. Fine.
- **The `steps: []` authoring/kernel asymmetry** noted in
  `ops/BACKLOG.md:70-81` and in `docs/SURFACE.md` — the comment names both
  sides of the asymmetry explicitly and the RFC decision is documented.
  Acceptable as-is for gate 1.
- **`isDirectInvocation` and the shebang line** — the `#!/usr/bin/env
  node` header combined with `if (isDirectInvocation(…))` is redundant on
  the CLI path (Node loads the module either way), but each half has an
  independent purpose (executable via `flows check …` from a shell;
  importable in tests). Fine.

## Verdict

The PR is materially maintainable. The findings above are shaping notes,
not gate-blockers — the tests pass, the failure taxonomy holds by types
where TypeScript can force it, and the one place where Rust can't force
it (M1) is a low-cost fix. The parallel-key-lists concern (M2, M10) is
the highest six-month-drift risk, worth an explicit "kept in sync with"
comment at each site even without introducing a shared source.

REVIEW_PASSED
