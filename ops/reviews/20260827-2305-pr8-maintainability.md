# PR #8 — maintainability review

**Lens:** could a stranger read this in six months and change it safely?
**Reviewed head:** `385763a53a7b8f06c6f46fa6c3b64ad22f4638fa`
**Base:** `main`
**Scope in scope:** `docs/SURFACE.md`, `sdk/src/{cli,compile,failure-kinds,index,preflight,spec,validate}.ts`, `sdk/tests/{bin,cli,preflight,spec-parity,validate}.test.ts`, `kernel/relayflowd-core/src/{spec.rs,spec/tests.rs,machine/tests.rs}`, `testdata/preflight/*`, `ops/BACKLOG.md`. `ops/DRIVE-LOG.md`, `ops/NEXT.md`, `ops/SCOREBOARD.md`, and the prior review markdown are out of scope for the code lens.

## Summary

The code holds up on a first read. Naming is direct, the failure taxonomy is a closed union on both sides (`PREFLIGHT_FAILURE_KINDS` / `PREFLIGHT_WARNING_KINDS` in `sdk/src/failure-kinds.ts`, `CompletionReason` in `kernel/relayflowd-core/src/entry.rs`), preflight I/O is injected through `PreflightProbes` so `preflight()` itself is pure, and the authoring/kernel dialect boundary has a single named owner (`toKernelSpec` / `kernelToAuthoring` in `sdk/src/compile.ts`). Most comments explain *why* — the block comment above `warnOnUnprovableEffects` (`sdk/src/preflight.ts:229-236`) explicitly points at `kernel/relayflowd/src/exec_det.rs`'s `sh -c` shape as the reason warn-not-refuse is correct.

The findings below are the surfaces where a future contributor is likely to break something without the code noticing.

## Findings

### M1 — The closed-`CompletionReason` claim is not enforced by the enumeration test (medium)

`kernel/relayflowd-core/src/machine/tests.rs:65-80` (new in this PR) iterates a hard-coded array of eight `CompletionReason` variants and asserts each terminates the run in `RunCompletionReason::StepFailed`:

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

`CompletionReason` is a closed Rust enum. Add a variant tomorrow (`NeedsHuman`, `EnvironmentLost` — both named in RFC-0001 §1 covenant 2) and the compiler will not force this test to grow. The test's own name — `every_failed_run_terminates_with_declared_completion_reasons` — begins to lie: it passes with the new variant untested. This is exactly the "tests that would not fail if the behavior broke" shape called out in the review prompt.

The sibling TS test at `sdk/tests/preflight.test.ts:177` gets this right — it iterates `PREFLIGHT_FAILURE_KINDS` from the source and asserts set equality on refusal kinds, forcing an update when a new kind is declared. The Rust side should do the same. A `match reason { CompletionReason::Success => …, CompletionReason::VerificationFailed | … => … }` inside the test body (or `impl CompletionReason { const FAILURES: &[Self] = &[…]; }` next to the enum, iterated by the test) makes the closed-set claim compiler-checked. Small fix; worth having before the next reason lands.

### M2 — `kernelDialectMarker` duplicates the kernel field list with no cross-check (medium)

`sdk/src/cli.ts:238-254` classifies a spec as kernel-dialect vs. authoring by scanning for any of four hand-maintained snake_case key lists (`kernelStepKeys`, `kernelBudgetKeys`, `kernelVerificationKeys`, `kernelPermissionKeys`). The comment above the block is honest — it names the "compiler always emits `retry`" invariant and admits the extra keys cover other producers — but nothing binds the list to `KernelStepSpec` / `KernelBudgetSpec` / `KernelPermissionsSpec` in `sdk/src/spec.ts`, or to the Rust `RunSpec` fields.

Failure mode: a kernel field added to `spec.rs` (e.g. a future `stream_pins` on agent steps) is not discovered here; a JSON with only that new field is misclassified as authoring input, `checkKeys` rejects it with a wrong-dialect error, and the operator sees a message that hides the real story. The mixed-dialect suggestion path (`cli.ts:117-122`) also degrades silently — the branch that names "read as a compiled kernel spec because …" never fires for the new field.

Options, cheapest first: (a) derive the marker sets from `KernelStepSpec` / `KernelBudgetSpec` / `KernelPermissionsSpec` keys via a small helper next to `spec.ts`; (b) add a parity test that walks `testdata/hello-ladder.spec.canonical.json` and asserts every snake_case key it contains is discoverable by `kernelDialectMarker`; (c) failing both, a `// KEEP IN SYNC WITH KernelStepSpec / KernelBudgetSpec / KernelVerificationSpec / KernelPermissionsSpec in spec.ts` header on this block, with a matching pointer above each of those interfaces. The RFC says "the composable unit is the spec" (settled decision #5); that discipline holds better if the SDK marks the coupling explicitly.

### M3 — The `run.start` preflight-bypass invariant lives only in prose (medium)

`docs/SURFACE.md` (new copy) draws the covenant-2 boundary explicitly:

> Gate 1 does not make this guarantee for callers that bypass `flows check`: the journal client's direct `run.start` path does not invoke surface preflight.

This is load-bearing — it says the SDK-side CLI holds covenant 2 but the kernel does not. Nothing on the code side signals the split. `JournalClient.runStart` (re-exported from `sdk/src/index.ts`) has no comment naming preflight; `RunSpec::parse` in `kernel/relayflowd-core/src/spec.rs:53-62` doesn't say its callers skip surface preflight either. A stranger writing a new caller of `JournalClient`, or a new server entry point on the kernel side, learns nothing about the asymmetry from the code.

AGENTS.md rule 3 ("the journal protocol is the boundary") makes the bypass deliberate, but "readable in the code" is what six-month maintainability buys. A one-line comment on `RunSpec::parse` and on `JournalClient.runStart` naming the gap and pointing at `docs/SURFACE.md` closes this cheaply. Without that, the invariant erodes at the first "let me just add preflight into the client" refactor.

### M4 — `readProjectConfig`'s walk absorbs both ENOENT and EACCES (low–medium, failure handling)

`sdk/src/cli.ts:133-147`:

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

Every failure from `accessSync` is coerced to "keep walking." Two consequences:

1. An intermediate `flows.json` that exists but is unreadable (EACCES, wrong mode bit) is silently skipped; the walk finds an outer grandparent config and silently uses its `cli` / `executors`. `docs/SURFACE.md` promises the **nearest** config is a hard boundary ("prevents accidental inheritance of outer credentials or executors"). Under this failure mode that promise breaks quietly.
2. If no readable config exists at all, the CLI reports "no CLI at step, flow, or project level" (`preflight.ts:113-118`), when the actual cause was an unreadable-but-present config. The operator debugs the wrong problem.

The `// Continue toward the filesystem root.` comment describes intent, not the failure class it absorbs. Narrow the `catch` to `ENOENT` (via `err.code`) and let other codes escalate as a `config_invalid` refusal — the failure kind already exists.

### M5 — `firstCommandWord` doesn't detect the assignment case its own comment invokes (low)

`sdk/src/preflight.ts:280-283`:

```ts
function firstCommandWord(command: string): string | undefined {
  const match = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}
```

The block comment at `preflight.ts:229-236` justifies warn-not-refuse by pointing at `sh -c` semantics: an unresolved first word "may still be a shell builtin, function, **or assignment**." Correct — but `firstCommandWord` extracts the first whitespace-delimited token, so `FOO=bar cmd baz` yields `FOO=bar`, which does not resolve, so `warnOnUnprovableEffects` emits `command_unresolved` with a message about `FOO=bar`. The comment says the code handles the assignment case; the code does not. A stranger debugging why `command_unresolved` fires against `FOO=bar cmd baz` will chase the wrong tail.

Either (a) detect `^[A-Za-z_][A-Za-z0-9_]*=` and emit `command_unprovable` with an honest message ("assignment prefix present, command not extractable"), or (b) shorten the comment to match what the code actually classifies. The current combination is a comment overstating the code — the class of drift AGENTS.md's "Evidence is captured, not narrated" section warns against, at a smaller scale.

### M6 — `probeCli` cache key uses `JSON.stringify` where a delimiter would state intent (low)

`sdk/src/preflight.ts:144`:

```ts
const cacheKey = JSON.stringify([resolution.cli, resolution.source]);
```

A reader has to reason about JSON.stringify's collision behavior for arbitrary CLI strings. It's correct today — two strings serialize losslessly — but the intent is "key by `(cli, source)`", not "produce a canonical serialization." `` `${resolution.cli}\0${resolution.source}` `` (or a nested `Map<string, Map<CliResolutionSource, CliProbeOutcome>>`) reads directly. The file's other comments are careful about "source is load-bearing" (`preflight.ts:141-143`); this cache-key line doesn't match that care.

### M7 — `LADDER_FAULTS`' `cli_unresolved` mutator is a noop whose entire meaning is a comment (low)

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

The comment is accurate, but an empty lambda invites tidying ("why is this here?"). If a future contributor deletes the row or replaces it with a cleaner test, the `cli_unresolved` guarantee migrates from "asserted by the LADDER_FAULTS matrix" to "an emergent property of `ladderVariant`'s empty `flows.json`" — same green bar, weaker guarantee. Fold the case into an explicit `it` block ("refuses `cli_unresolved` when relocated to an empty flows.json") whose name states the invariant, or make the mutator do something observable like `delete flow['cli']`. The current shape leans on a comment nobody has to preserve.

### M8 — `resolveExecutable` hard-codes Unix `which` with no cross-platform note (low)

`sdk/src/cli.ts:180-184` shells out to `spawnSync('which', [command], …)` to resolve a bare CLI name. On Windows the binary does not exist by default (`where.exe` is the analogue). The whole preflight probe layer also assumes `/bin/sh -c` semantics (see `docs/SURFACE.md` and the block comment at `preflight.ts:229-236`). A future contributor porting past macOS/Linux hits this in `resolveExecutable` first, and the error surface is `probe_failed / spawn_failed` — no signal about the real cause.

Not a bug for gate 1 (target platforms are Unix-like), but the file has no comment saying so. One line: `// Unix-only: relies on 'which' and /bin/sh -c semantics. Windows support is deferred.` A stranger who sees `spawn_failed` on Windows should be able to trace the cause to a single documented spot.

### M9 — No test pins the stdout/stderr contract of `emitReport` (low)

`sdk/src/cli.ts:215-230` writes diagnostics to stderr first, then in non-JSON mode writes `RESOLVED …` lines and finally `CHECK PASSED` to stdout. This is a plausible scripting target (CI parsers, sage's compile step). Tests in `sdk/tests/cli.test.ts` and `sdk/tests/bin.test.ts` check *containment* on either stream but not ordering or stream partition. A refactor that moves `RESOLVED` to stderr for "grouping," or reorders diagnostics after resolutions, breaks downstream parsers silently. One assertion — `stdout` contains `RESOLVED` then `CHECK PASSED` in that order on a pass; `stderr` carries the `REFUSED` line on a refusal and `stdout` contains no `CHECK PASSED` — pins the contract.

### M10 — Four independent key-set truths must agree by convention (medium)

Parallel truths:

- `sdk/src/validate.ts:40-55` — `ROOT_KEYS`, `STEP_COMMON_KEYS`, `STEP_TYPE_KEYS`, `TRIGGER_KEYS`, etc., for authoring input.
- `kernel/relayflowd-core/src/spec.rs:139-152` — `STEP_COMMON_FIELDS`, `STEP_DETERMINISTIC_FIELDS`, `STEP_LLM_FIELDS`, `STEP_AGENT_FIELDS` for the kernel dialect (the untagged serde union of `StepKind` cannot use `#[serde(deny_unknown_fields)]`, so this hand-maintained list is what enforces the invariant).
- `sdk/src/cli.ts:238-254` — `kernelDialectMarker`'s per-shape key arrays (see M2).
- `sdk/src/compile.ts:266-289` — `unionKeys` inside `kernelStepToAuthoring`.

The parity test at `sdk/tests/spec-parity.test.ts` and its Rust sibling pin one canonical fixture; they force parity on the happy path of "known keys marshal identically," not on rejection paths. If the SDK adds a new authoring field the compiler strips at the boundary while the kernel adds a matching snake_case field, nothing in this repo notices the divergence until a user hits it.

A stranger asked to add a spec field faces at least four touch sites, none of which lists the others in-code. A `// The spec boundary is KernelRunSpec; if you add a field here, also update <lists>` comment at each site is a low-cost brake on the drift; a derived shared source (either a code generator or a runtime `Object.keys(KernelStepSpec)` helper for the TS side) would remove the coupling entirely. Both worth considering before the next boundary field lands.

## Non-findings (worth naming so they aren't re-raised)

- **`isDirectInvocation` swallowing `realpathSync` errors** (`sdk/src/cli.ts:268-277`) — the comment justifies the choice (missing/deleted argv[1] → treat as import), the refusal path is unaffected. Fine.
- **The `#!/usr/bin/env node` shebang + `isDirectInvocation(process.argv[1])` guard** — each half has an independent purpose (executable from a shell; importable in tests). Fine.
- **`SPEC_SCHEMA_VERSION` binding rejects non-exact versions** — this is a deliberate narrowing over the old semver-regex check; RFC-0001 §7 leaves versioning open. Acceptable at gate 1; will need a supported-set when the next spec version lands.
- **The `steps: []` authoring-refuses / kernel-accepts asymmetry** — named in `ops/BACKLOG.md`, in `docs/SURFACE.md` ("This is a chosen authoring-time narrowing, not a kernel guarantee"), and in the round-2 errata. Deliberate for gate 1, deferred honestly.
- **`checkKeys`' nearest-key suggestion (Levenshtein)** — small, tested against the `depends_on → dependsOn` case, legible. Fine.

## Verdict

The PR is materially maintainable. Every finding above is a shaping note, not a gate-blocker — the tests pass, the closed-taxonomy claim holds by types where TypeScript can force it, the one place Rust cannot force it (M1) is a small, cheap fix, and the parallel-key-lists risk (M2, M10) is the highest six-month drift surface. None of it changes the shape of what shipped.

REVIEW_PASSED
