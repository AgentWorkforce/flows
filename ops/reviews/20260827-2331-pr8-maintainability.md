# PR #8 — Maintainability Review

- **PR:** #8 — *WP-4 — flows check preflight (covenant 2)*
- **Branch:** `flow/drive-57e923c-08271542`
- **HEAD at review:** `072af23ea7ecd41dcde571e69a23f5a37c7f0324`
- **Lens:** Maintainability — could a stranger read this in six months and
  change it safely?
- **Reviewer:** maintainability agent (non-interactive)
- **Reviewed at:** 2026-08-27 23:31 UTC

## Read

- `AGENTS.md` (rules 1, 2, 4, 6, 7) and
  `docs/RFC-0001-everything-is-a-relayflow.md` (§1 covenants, §3 gate 1
  preflight clause, settled decisions #4/#10/#13).
- `docs/SURFACE.md` — the anonymous-resolution law, the preflightable-CLI
  contract, the WP-9 `command_unresolved` limitation, project-config
  discovery, and the `steps: []` narrowing note.
- `/tmp/pr-8.diff` (105 files, ~20k lines). Code-bearing surface is ~1.5k
  lines of TS + Rust; the remainder is `sdk/package-lock.json` and ~70
  `ops/reviews/pr8-*.md` files with a handful of `ops/DRIVE-LOG.md` entries.
- Current tree: `sdk/src/preflight.ts`, `sdk/src/cli.ts`,
  `sdk/src/failure-kinds.ts`, `sdk/src/spec.ts`, `sdk/src/compile.ts`,
  `sdk/src/validate.ts`, `sdk/src/index.ts`.
- `sdk/tests/preflight.test.ts`, `sdk/tests/cli.test.ts`,
  `sdk/tests/bin.test.ts`, `sdk/tests/validate.test.ts`,
  `sdk/tests/spec-parity.test.ts`.
- `kernel/relayflowd-core/src/spec.rs`, `kernel/…/src/spec/tests.rs`,
  `kernel/…/src/machine/tests.rs`.
- `testdata/preflight/*` fixtures (`cli-declared`, `cli-missing`,
  `cli-unauthenticated`, `cli-unresolved`, `cli-signal`, `empty-path`,
  `no-executor`, `shared-cli`, `warning`, `project-default/`, and the
  helper CLIs `authenticated-cli`, `unauthenticated-cli`, `counting-cli`,
  `signal-probe-cli`).
- Prior round `ops/reviews/20260827-2323-pr8-maintainability.md`, diffed
  against the current tree; code-bearing surface is unchanged since it was
  written (only ops artefacts have moved).

The stranger test: a competent TS + Rust engineer with the RFC in hand
opens `sdk/src/preflight.ts`, `sdk/src/cli.ts`, `kernel/…/src/spec.rs`,
and the paired tests cold. Can they add a `PreflightFailureKind`, extend
the auth probe, or grow the kernel's failure taxonomy without silently
breaking a diagnostic?

## Verdict

**Yes on the shape. The same short list of maintainability nits carried
across six prior rounds is still real in the tree; none of them blocks
merge.**

The preflight seam is a small pure module: `sdk/src/preflight.ts:1-6`
imports nothing from `node:*`; every fact enters through a three-method
`PreflightProbes` interface (`sdk/src/preflight.ts:41-46`) and every
failure is one of a closed enum
(`sdk/src/failure-kinds.ts:2-8, 29-33`). The reachability assertion at
`sdk/tests/preflight.test.ts:177-191` mechanically pins *declared →
emitted* for every refusal kind, and the in-test comment records that the
compiler pins the converse via `PreflightRefusal.kind:
PreflightFailureKind`. Warnings receive the same treatment at
`sdk/tests/preflight.test.ts:145-170`. Covenant 2's *refuse or warn,
never silence* is what those two pairs actually mechanize.

The RFC-shaped comments earn their space:
`sdk/src/preflight.ts:229-236` explains why deterministic commands warn
instead of refuse (routes to WP-9); `kernel/…/src/spec.rs:32-39` names
the new `cli`/`triggers` fields as inert and tells the stranger that
`run.start` does not run preflight in gate 1; `docs/SURFACE.md` discloses
the same asymmetry where the stranger is already reading, and points at
the WP-9 backlog item that will close it.

What remains is a handful of small load-bearing details where a future
edit is more likely to break something silently than the rest of the
diff. F1, F2, F5, F6, F8b, F9, and parts of F10 are prospective traps in
exactly the sense this lens exists to name: the *next* edit either
produces a false diagnostic or leaves a *"for every"* assertion iterating
over a stale hand-maintained list — under a still-green build. None
crosses a covenant. Cleared to merge; the same short list of one-line
fixes remains attractive to land before another PR touches this seam.

## Findings

Verified against the current tree at HEAD `072af23`; every file/line
below was opened during this review.

### F1 — `probeFailedMessage`'s fall-through will assert *"timed out"* about any new detail *(carried, still real)*

**Where:** `sdk/src/preflight.ts:187-198`.

```ts
if (detail === undefined) return `${prefix}.`;
if (detail === 'spawn_failed') return `${prefix}: the probe process could not be started.`;
if (detail.startsWith('signal:')) {
  return `${prefix}: the probe was terminated by signal "${detail.slice('signal:'.length)}".`;
}
return `${prefix}: the probe timed out after ${detail.slice('timeout:'.length)}.`;
```

The final `return` treats every `detail` that is not `undefined`,
`spawn_failed`, or `signal:*` as a timeout. `CliProbeFailureDetail`
(`sdk/src/preflight.ts:20-24`) is exactly where a maintainer adds the
fourth variant. `tsc` does not object — the fall-through has widened
`detail` to `string`. A future `'permission_denied'` variant renders
*"the probe timed out after on_denied."* — false, garbled, produced by a
green build. `probe_failed` exists (M3 fix, four rounds back) to name
*what actually happened*; a silent fall-through converts *"no
information"* into *"wrong information,"* which is worse than the state
M3 replaced.

**Fix shape:** branch on `detail.startsWith('timeout:')` explicitly, then
assign the fall-through to a `never`-typed local so the next variant is
a compile error rather than a lie. One line.

### F2 — Two probe timeouts are duplicated per call site; the classifier's type does not bind them to the spawn option *(carried, still real)*

**Where:** `sdk/src/cli.ts:187-198` (auth probe) and `sdk/src/cli.ts:200-214`
(`which` resolver); union
`CliProbeFailureDetail = … | 'timeout:5000ms' | 'timeout:10000ms' | …`
at `sdk/src/preflight.ts:20-24`.

```ts
const result = spawnSync(executable, ['auth', 'status'], { …, timeout: 10_000 });
const failure = classifySpawnFailure(result.error, result.signal, 10_000);
```

`10_000` is written twice with no link between the copies. Change the
`spawnSync` timeout to `30_000` and leave the classifier argument at
`10_000`: `tsc` stays happy, the tests stay green (see F3), and a probe
that hung for 30 seconds reports *"timed out after 10000ms."* Same
duplication for `5_000` in `resolveExecutable`. `docs/SURFACE.md` names
10s as part of the contract; the 5s figure is disclosed nowhere.

The parameter type `timeoutMs: 5_000 | 10_000` on `classifySpawnFailure`
constrains the *argument*, not its agreement with the spawn option — the
half that matters — and re-encodes the magic-number pair through the
detail union without a cross-reference from either side.

**Fix shape:** two named constants (`AUTH_PROBE_TIMEOUT_MS`,
`WHICH_TIMEOUT_MS`) declared once, referenced at both the spawn call and
the classifier, and used to build the literal detail
(`` `timeout:${AUTH_PROBE_TIMEOUT_MS}ms` ``). One-line note on *why* the
two timeouts differ.

### F3 — The `timeout:*` production path has no end-to-end coverage *(carried)*

**Where:** `sdk/tests/preflight.test.ts:107-121`; `sdk/tests/bin.test.ts`.

`preflight.test.ts` covers timeouts by *throwing* a
`new CliProbeError('timeout:10000ms')` directly at the seam — pins the
rendering, not the classifier that produces the string. The one line
that turns a hung probe into `timeout:` rather than `spawn_failed` is
`sdk/src/cli.ts:222-224`:

```ts
const detail = (error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
  ? `timeout:${timeoutMs}ms` as const
  : 'spawn_failed' as const;
```

Replace `'ETIMEDOUT'` with any string that never matches: every hung
probe is classified as `spawn_failed` and the whole suite stays green.

**Fix shape:** a direct unit test of `classifySpawnFailure` against a
synthetic `{ code: 'ETIMEDOUT' } as NodeJS.ErrnoException`. No wall
clock; pins the one branch. If F2 lands, the assertion uses those
constants and does not encode the numbers.

### F5 — `every_failed_run_terminates_with_declared_completion_reasons` iterates a hand-maintained list *(carried, still real)*

**Where:** `kernel/relayflowd-core/src/machine/tests.rs:66-75`.

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

Complete today; nothing holds it complete. Adding `EnvironmentLost` — a
variant RFC covenant 2 explicitly names in the closed failure set the
kernel is expected to grow into — compiles clean and the test's name
still says *"every."* The `SpecError` tests in the same subsystem
already pattern-match every variant; the pattern exists in-repo.
`strum::EnumIter`, or an exhaustive `match` in a small helper
(`fn is_failure(&reason) -> bool` with no `_` arm) makes the loop
load-bearing rather than aspirational. The RFC's failure taxonomy is
*the* thing this test claims to enforce; the name is the guarantee.

### F6 — `SpecError::InvalidTrigger` collapses two distinct faults into one message *(carried, still real)*

**Where:** `kernel/relayflowd-core/src/spec.rs:73-81`.

```rust
for trigger in &self.triggers {
    if trigger.id.trim().is_empty() || trigger.executor.trim().is_empty() {
        return Err(SpecError::InvalidTrigger(trigger.id.clone()));
    }
    …
}
```

Message: `"trigger {0} must declare a non-empty id and executor"`. When
`id` is empty and `executor` is present, `{0}` renders empty and the
operator sees *"trigger  must declare a non-empty id and executor"* —
two consecutive spaces and no signal about which field is at fault.
When `executor` is empty and `id` is `hourly`, the message reads as if
both fields are at fault when only one is. The rest of the taxonomy is
precise (`EmptyStepId`, `EmptyStepCli(id)`, `DuplicateTrigger(id)`);
this one collapses two. The unit test `preflight_data_is_fail_closed`
in `kernel/…/src/spec/tests.rs:244-254` even asserts
`Err(SpecError::InvalidTrigger("".to_owned()))` for the empty-id case —
which reads to a maintainer as *"the empty string is a valid trigger id
here,"* reinforcing the confusion.

**Fix shape:** split into `EmptyTriggerId { index: usize }` and
`EmptyTriggerExecutor(id)`. Two variants, two message strings; the
test then asserts distinct kinds and stops encoding the wrong invariant.

### F8b — `validateKernelRetry` names an authoring rule as if the kernel imposed it *(carried)*

**Where:** `sdk/src/compile.ts:240-251` and `kernel/…/src/spec.rs`.

`KERNEL_RETRY_DEFAULTS` is documented at `sdk/src/compile.ts:132-139`
as *"kernel defaults, materialized at compile time so the emitted spec
is byte-identical to the kernel's own serialization of it."* But
`validateKernelRetry` enforces the *reverse* — a kernel-dialect spec
offered to `flows check` is refused when its retry policy differs from
these defaults, even though the kernel itself accepts them
(`kernel/…/src/spec.rs` accepts any positive multiplier and non-negative
backoff). The error message *"retry.multiplier must equal the authoring
default 2"* (`sdk/tests/cli.test.ts:283`) names the authoring rule as if
the kernel did.

A stranger who hand-writes a kernel spec, or a different producer (a
future sage compiler, gate 9's self-authoring), is told the wrong thing
about which side owns the rule. It also means `flows check` is stricter
than the kernel on inputs the kernel already accepts, a coupling that
will bite when the kernel grows a non-default retry policy for a
specific step class.

**Fix shape:** either relax the check to accept anything the kernel
accepts (the honest fix), or rename the check and the error message to
name it honestly — *"`flows check` does not yet re-derive retry policy
from arbitrary kernel-dialect specs; produced specs must match the
SDK's authoring defaults."* Pick one.

### F9 — `probeTrigger` still catches every error with no classification *(carried)*

**Where:** `sdk/src/preflight.ts:200-217`.

`probeResolvedCli` (`sdk/src/preflight.ts:135-185`) uses `CliProbeError`
to preserve `detail`; `probeTrigger` uses a bare `catch { }` and emits
`probe_failed` with no `detail`, no cause. Today `probes.executor` is a
synchronous membership check that cannot realistically throw
(`sdk/src/cli.ts:182`), so this branch is closer to dead than to
unpinned. But `docs/SURFACE.md`'s WP-9 disclosure — *"gate 1 does not
yet contact a registry, broker, or RelayCron, and absence is
`no_executor`"* — is a promise this predicate will grow past. At that
point the bare catch silently classifies broker timeouts, signals, and
connection failures identically. When the same path exists twice in a
module with two different levels of care, six months later someone
models the sloppier one and files a bug about the tighter one.

**Fix shape:** either reuse `CliProbeError` for the trigger probe, or
add a sibling `TriggerProbeError` with the same discriminated detail.
Match `probeResolvedCli` so both surfaces evolve together.

### F10 — Small load-bearing details on the boundary that a reader will trip over *(carried, still real)*

- **`PreflightProbes.executor(trigger: TriggerSpec)`**
  (`sdk/src/preflight.ts:44`) receives the whole trigger struct while
  every implementation and call site reads only `trigger.executor`
  (`sdk/src/cli.ts:182`). A reader assumes `id` or something else is
  used. Narrow to `(executor: string)` or add a one-line note explaining
  why the full struct is passed. The diagnostic call site already has
  access to `trigger.id`, so the wide type is not load-bearing today.
- **`ProjectConfig.directory`** (`sdk/src/cli.ts:22`) means *"the
  config's directory"* when a config exists and *"the flow's
  directory"* when none does (`sdk/src/cli.ts:137-139`). Only the first
  case is read in `systemProbes` (`sdk/src/cli.ts:181`). The dual
  meaning is invisible from the type; either narrow it
  (`configDirectory?: string`) or comment it.
- **`warnOnUnprovableEffects`** re-tests `step.type === 'deterministic'`
  (`sdk/src/preflight.ts:242`) that its caller already tested one line
  earlier (`sdk/src/preflight.ts:87-88`). Either the guard is defensive
  against future callers (say so), or drop it and narrow the parameter
  to `DeterministicStepSpec`.
- **`readProjectConfig`** rejects every key outside `cli`/`executors`
  (`sdk/src/cli.ts:146-148`), so a `"$schema"` key (a convention every
  editor understands, cheap autocomplete) is a hard `config_invalid`.
  A stranger who adds it — legitimately — gets a refusal from
  `flows check`. Either allowlist `$schema` explicitly or say in the
  refusal message that this is a covenant-2 fail-closed choice.
- **The 5-second `which` timeout** is documented nowhere.
  `docs/SURFACE.md` names the 10s auth-probe timeout; the sibling 5s
  timeout can equally surface as `probe_failed` (see `'timeout:5000ms'`
  in the union), and the contract does not mention it.
- **Rust match returns `&None`** in `kernel/…/src/spec.rs`'s
  step-CLI check:

  ```rust
  let cli = match &step.kind {
      StepKind::Llm { cli, .. } | StepKind::Agent { cli, .. } => cli,
      StepKind::Deterministic { .. } => &None,
  };
  ```

  This compiles because Rust promotes `&None` to a static reference to
  `Option::<String>::None`, but the pattern is unusual enough to read as
  a bug. `let cli: Option<&String> = match &step.kind { … => cli.as_ref(),
  StepKind::Deterministic { .. } => None };` and
  `cli.is_some_and(|value| value.trim().is_empty())` is one line, no
  borrow-of-temporary, unambiguous.

### F11 — Six months of open findings live only in `ops/reviews/` *(carried; the pile grew again)*

**Where:** `ops/reviews/` — this PR adds ~11k lines of review artefacts
to a ~20k-line diff. The tree now holds ~70 `pr8-*.md` files with no
index. This is a maintainability concern about the *change*, not the
shipped code.

The last several rounds recorded the same open findings, and only
Codex P1 / `steps: []` / WP-7 F6 / the release pipeline made it into
`ops/BACKLOG.md`. Reconstructing the live open set for this review
meant reading the last review and diffing it against the current tree.
The cost is small this time and would be zero if F1 / F2 / F5 / F6 had
landed as one-line commits between rounds.

RFC §2 rule 5 makes pruning the norm — rules *"added when a review
surfaces a new failure class and pruned when they stop firing."* One
`ops/reviews/PR8-OPEN.md` carrying the live findings (superseded rounds
marked as such), or promoting F1–F10 into `ops/BACKLOG.md`, closes this.
Cost: one file.

## Positive notes — patterns worth keeping

- **Closed diagnostic taxonomy pinned by a reachability test in both
  directions.** `sdk/tests/preflight.test.ts:177-191` mechanically pins
  *declared → emitted*; the compiler pins the converse via
  `PreflightRefusal.kind: PreflightFailureKind`. The in-test comment
  even records the split so the guarantee is not read as coming from
  either half alone. Warnings get the same shape at
  `sdk/tests/preflight.test.ts:145-170`. Unusually good.
- **`ladderVariant` fixture pattern** (`sdk/tests/cli.test.ts:55-62`).
  Induces each fault on the *canonical ladder flows themselves* in a
  hermetic temp directory, with a control test that proves the refusals
  belong to the fault rather than the relocation
  (`sdk/tests/cli.test.ts:149-153`). *"Evidence is captured, not
  narrated"* (AGENTS.md) made flesh: the induced refusals actually
  happen on the RFC-named flows, not a stand-in.
- **Pure-predicate `preflight()`.** `sdk/src/preflight.ts` imports zero
  from `node:*`; all I/O is behind `PreflightProbes`, and the seam is
  three methods. AGENTS.md rule 2 as file layout.
- **`RunSpec.triggers` docstring** (`kernel/…/src/spec.rs:37-39`) names
  its own boundary — *"Inert gate-1 declarations. Matching and dispatch
  belong to gate 2."* A stranger reading `spec.rs` learns why the field
  does nothing, which is exactly the question they would otherwise file
  a bug about. Same for the `RunSpec.cli` comment naming that
  `run.start` does not invoke surface preflight in gate 1.
- **`kernelDialectMarker`** cleanly separates dialect detection from
  authoring parsing and names which specific key triggered the routing
  decision (`sdk/tests/cli.test.ts:77-100` pins this end-to-end,
  including that the offending mixed-dialect key is in the error).
- **`preflight_data_is_fail_closed`** exhaustively asserts each new
  `SpecError` variant and pins `deny_unknown_fields` on `TriggerSpec`
  with a guessed `worker` key — one edit and the whole variant surface
  is a compile error, not a silent regression.
- **`docs/SURFACE.md`** explicitly discloses the WP-9 asymmetry:
  `command_unresolved` is a warning (not a refusal) because a bare word
  may be a shell builtin / function / assignment under `/bin/sh -c`,
  and the narrower path-like check is tracked in `ops/BACKLOG.md`. The
  stranger's next question is answered where they are already reading.

## Tests that would not fail if behavior broke

- **Every hung probe silently reclassified as `spawn_failed`** if
  `sdk/src/cli.ts:222` diverges from Node's `'ETIMEDOUT'`: no test
  catches it (F3). The diagnostic-rendering tests all throw at the seam.
- **`failure_reasons` in `machine/tests.rs:66-75` misses a new
  `CompletionReason` variant**: the test name still says *"every"*;
  there is no compile-time check to force additions (F5).
- **The two probe timeouts drift**: the type-level constraint only
  ensures the classifier argument is one of `5_000 | 10_000`, not that
  it matches the spawn option (F2). A wrong pair type-checks.
- **`probeFailedMessage` calls a new detail a "timeout"** because no
  test or type binds the fall-through to the timeout variants only
  (F1).

## Comments that assert what the code does not do

- `sdk/src/compile.ts:132-139` says `KERNEL_RETRY_DEFAULTS` exists so
  *"the emitted spec is byte-identical to the kernel's own
  serialization,"* but `validateKernelRetry` uses the same constants to
  enforce equality on *incoming* kernel-dialect specs — a policy the
  comment does not describe and the kernel does not share (F8b).
- `SpecError::InvalidTrigger` renders as *"trigger  must declare a
  non-empty id and executor"* when `id` is the empty field, silently
  contradicting its own claim about *which* thing is wrong (F6).
- The machine test name
  *"every_failed_run_terminates_with_declared_completion_reasons"*
  asserts a universal quantifier over a hand-maintained list (F5).

## Summary

Same shape as the prior verdict: the preflight surface is well-shaped —
small, pure, closed taxonomy, tested against reachability in both
directions, and the RFC-shaped comments make the inert-field boundary
legible. The carried findings F1 / F2 / F5 / F6 / F8b are exactly what
this lens exists to name, and every one of them is a one-line fix to a
specific line already identified across multiple prior rounds. None
crosses a covenant; none blocks merge.

If forced to pick three to close *before merge* — F1 (a lying diagnostic
is worse than no diagnostic; this is exactly what M3 fixed and this PR
reintroduced through the path M3's fix created), F2 (the shape of
duplication that becomes wrong under a routine *"let's give the probe
more time"* edit), and F5 (the kernel test whose name will lie the
moment a covenant-2 failure kind is added — the very direction the RFC
says the kernel is going). But the shipped code is honest and the
taxonomy is mechanically closed. Cleared to merge.

REVIEW_PASSED
