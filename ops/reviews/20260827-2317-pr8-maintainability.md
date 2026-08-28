# PR #8 — Maintainability Review

- **PR:** #8 — *WP-4 — flows check preflight (covenant 2)*
- **Branch:** `flow/drive-57e923c-08271542`
- **HEAD:** `2b117ae` (code-bearing surface last touched at `2701aef`/`6fab45a`;
  everything since is docs corrections in `SURFACE.md`, ops entries, and review
  artefacts).
- **Lens:** Maintainability — could a stranger read this in six months and
  change it safely?
- **Reviewer:** maintainability agent (non-interactive)
- **Reviewed at:** 2026-08-27 23:17 UTC

## Read

- `AGENTS.md`; `docs/RFC-0001-everything-is-a-relayflow.md` (§1 covenants,
  §3 gate 1 preflight clause); `docs/SURFACE.md` (WP-4 + WP-9 additions).
- Whole diff at `/tmp/pr-8.diff` (~18.7k lines). The code-bearing surface is
  ~1.5k TS + ~200 Rust; the rest is `sdk/package-lock.json` and `ops/`
  artefacts (>60 `pr8-*.md` review files now live in the tree).
- Current tree of the code that ships the behaviour:
  `sdk/src/preflight.ts`, `sdk/src/cli.ts`, `sdk/src/failure-kinds.ts`,
  `sdk/src/compile.ts`, `sdk/src/validate.ts`, `sdk/src/spec.ts`,
  `sdk/src/index.ts`.
- `sdk/tests/preflight.test.ts`, `sdk/tests/cli.test.ts`,
  `sdk/tests/bin.test.ts`.
- `kernel/relayflowd-core/src/spec.rs`, `kernel/…/src/spec/tests.rs`,
  `kernel/…/src/machine/tests.rs`.
- `testdata/preflight/*` fixtures and the prior round
  (`ops/reviews/20260827-2244-pr8-maintainability.md`), diffed against the
  current tree to keep the live-open set honest.

The stranger test: a competent TS/Rust engineer, RFC in hand, opens this diff
cold. Can they change the preflight, the diagnostic surface, or the kernel's
inert `RunSpec.cli`/`triggers` fields safely?

## Verdict

**Yes on the shape; the same handful of carried maintainability nits from the
prior round is still real in the tree; none of them blocks merge.**

The preflight seam is small, pure, and closed. `sdk/src/preflight.ts` imports
nothing from `node:*`; every real-world fact enters through `PreflightProbes`
(three methods). The refusal taxonomy is closed in
`sdk/src/failure-kinds.ts`, and the reachability pair in
`sdk/tests/preflight.test.ts:157-191` covers *"declared → emitted"* under a
`PreflightRefusal.kind: PreflightFailureKind` type, so the compiler enforces
the converse. Covenant 2's *refuse or warn, never silence* is asserted per
deterministic branch in `sdk/tests/preflight.test.ts:145-155`. `probe_failed`
carries a structured `detail` where an operator has to distinguish causes.
Kernel additions (`RunSpec.cli`, `triggers`) are marked inert in-docstring
and validated fail-closed with per-cause `SpecError` variants.

What remains is a set of small load-bearing details where a future edit is
more likely to break something silently than the rest of the diff. F1, F2,
F5, F6, F8b, F9, and parts of F10 are prospective traps in exactly the sense
this lens exists to name: the *next* edit renders a false diagnostic under a
still-green build. None crosses a covenant.

## Findings

Verified against the current tree at HEAD `2b117ae`; still present exactly as
the prior round described unless noted.

### F1 — `probeFailedMessage`'s fall-through will assert "timed out" about any new detail *(carried; still real)*

**Where:** `sdk/src/preflight.ts:187-198`.

```ts
if (detail === undefined) return `${prefix}.`;
if (detail === 'spawn_failed') return `${prefix}: the probe process could not be started.`;
if (detail.startsWith('signal:')) {
  return `${prefix}: the probe was terminated by signal "${detail.slice('signal:'.length)}".`;
}
return `${prefix}: the probe timed out after ${detail.slice('timeout:'.length)}.`;
```

The final `return` classifies any `detail` that is not `undefined`,
`spawn_failed`, or `signal:*` as a timeout string. `CliProbeFailureDetail`
(`sdk/src/preflight.ts:20-24`) is the canonical place a maintainer adds a
fourth variant. `tsc` will not object: the fall-through has `detail: string`.
If the next variant is `'permission_denied'`, the CLI renders *"the probe
timed out after on_denied."* — a message that is both false and visibly
garbled, produced by a green build.

M3's whole point (four rounds back) was that `probe_failed` must tell the
operator what actually happened. A silent fall-through converts *"no
information"* into *"wrong information,"* which is worse than the state M3
replaced. This has been called out for at least four rounds.

**Fix shape:** match `detail.startsWith('timeout:')` explicitly and assign
the fall-through to a `never`-typed local. The next variant becomes a compile
error instead of a lie. One line.

### F2 — Two probe timeouts are duplicated per call site; the classifier's type does not bind them *(carried; still real)*

**Where:** `sdk/src/cli.ts:187-198` (auth probe) and `sdk/src/cli.ts:200-214`
(`which` resolver); union `CliProbeFailureDetail = … | 'timeout:5000ms' |
'timeout:10000ms' | …` in `sdk/src/preflight.ts:22-24`.

```ts
const result = spawnSync(executable, ['auth', 'status'], { …, timeout: 10_000 });
const failure = classifySpawnFailure(result.error, result.signal, 10_000);
```

`10_000` is written twice with no link between the copies. Change the
`spawnSync` timeout to `30_000` and leave the classifier argument at
`10_000`: `tsc` is happy, tests stay green (see F3), and a probe that hung
for 30 seconds reports *"timed out after 10000ms."* Same duplication for
`5_000` in `resolveExecutable`. `SURFACE.md` names the 10s figure as part of
the contract; the 5s figure is not disclosed anywhere in the RFC/SURFACE
surface.

The parameter type `timeoutMs: 5_000 | 10_000` on `classifySpawnFailure`
constrains the *argument*, not its agreement with the spawn option — which
is the half that matters. It also propagates the magic-number pair through
the detail union with no cross-reference from either side.

**Fix shape:** two named constants (`AUTH_PROBE_TIMEOUT_MS`,
`WHICH_TIMEOUT_MS`) declared once, referenced at both the spawn call and
the classifier, used to build the literal detail
(`` `timeout:${AUTH_PROBE_TIMEOUT_MS}ms` ``). Changing one number then
propagates or breaks the build. One-line note on why the two timeouts
differ; today no comment says.

### F3 — The `timeout:*` production path has no end-to-end coverage *(carried)*

**Where:** `sdk/tests/preflight.test.ts:107-121`; `sdk/tests/bin.test.ts`.

`preflight.test.ts` covers the timeout path by *throwing* a
`new CliProbeError('timeout:10000ms')` directly at the seam — that pins the
diagnostic rendering, not the classifier that produces the string. The one
line that turns a hung probe into `timeout:` rather than `spawn_failed` is
`sdk/src/cli.ts:222`:

```ts
const detail = (error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
  ? `timeout:${timeoutMs}ms` as const
  : 'spawn_failed' as const;
```

Replace `'ETIMEDOUT'` with any string that never matches: every hung probe
is classified as `spawn_failed` and the whole suite stays green.

**Fix shape:** a direct unit test of `classifySpawnFailure` against a
synthetic `{ code: 'ETIMEDOUT' } as NodeJS.ErrnoException`. No wall clock;
pins the one branch. If F2 lands (named constants), the assertion uses those
constants and the tests do not encode the numbers.

### F5 — `every_failed_run_terminates_with_declared_completion_reasons` iterates a hand-maintained list *(carried; still real)*

**Where:** `kernel/relayflowd-core/src/machine/tests.rs:66-75`.

```rust
let failure_reasons = [
    CompletionReason::VerificationFailed,
    CompletionReason::RetriesExhausted,
    …
    CompletionReason::Canceled,
];
```

The array is complete today, but nothing holds it complete. Adding
`CompletionReason::EnvironmentLost` — a variant RFC covenant 2 explicitly
names in the closed failure set the kernel is expected to grow into —
compiles clean and the test's name still says *"every."*

The `SpecError` tests in the same subsystem already assert exhaustively
against each variant; the pattern exists in-repo. `strum::EnumIter` or an
exhaustive `match` in a small helper (`is_failure(&reason) -> bool` with no
`_` arm) makes the loop's coverage load-bearing rather than aspirational.
The RFC's failure taxonomy is *the* thing this test claims to enforce; the
name is the guarantee.

### F6 — `SpecError::InvalidTrigger` collapses two distinct faults into one message *(carried; still real)*

**Where:** `kernel/relayflowd-core/src/spec.rs` around the new trigger
validation and the `SpecError::InvalidTrigger` variant.

```rust
if trigger.id.trim().is_empty() || trigger.executor.trim().is_empty() {
    return Err(SpecError::InvalidTrigger(trigger.id.clone()));
}
```

Error: `"trigger {0} must declare a non-empty id and executor"`. When `id`
is empty and `executor` is present, `{0}` renders empty and the operator
sees *"trigger  must declare a non-empty id and executor"* — two consecutive
spaces and no signal about which field is at fault. When `executor` is
empty and `id` is `hourly`, the message reads as if both fields are at fault
when only one is. The rest of the taxonomy is precise (`EmptyStepId`,
`EmptyStepCli(id)`, `DuplicateTrigger(id)`); this one collapses two faults.

The unit test `preflight_data_is_fail_closed`
(`kernel/…/src/spec/tests.rs` around line 244–254) asserts
`Err(SpecError::InvalidTrigger("".to_owned()))` for the empty-id case —
which reads to a maintainer as *"the empty string is a valid trigger id
here,"* reinforcing the confusion.

**Fix shape:** split into `EmptyTriggerId` and `EmptyTriggerExecutor(id)`.
Two variants, two message strings. The test then asserts distinct kinds
and stops encoding the wrong invariant.

### F8b — `validateKernelRetry` names an authoring rule as if the kernel imposed it *(carried)*

**Where:** `sdk/src/compile.ts:240-251` and the kernel-dialect entry in
`kernel/relayflowd-core/src/spec.rs`.

`KERNEL_RETRY_DEFAULTS` is documented at `sdk/src/compile.ts:132-139` as
*"kernel defaults, materialized at compile time so the emitted spec is
byte-identical to the kernel's own serialization of it."* But
`validateKernelRetry` enforces the *reverse* — a kernel-dialect spec offered
to `flows check` is refused if its retry policy differs from these defaults,
even though the kernel itself accepts them (`kernel/…/src/spec.rs` accepts
any positive multiplier and non-negative backoff). The error message
*"retry.multiplier must equal the authoring default 2"* is enforced at
`sdk/tests/cli.test.ts:283` and names the authoring rule as if the kernel
did.

A stranger who hand-writes a kernel spec, or a different producer (a future
sage compiler, gate 9's self-authoring), is told the wrong thing about which
side owns the rule. It also means `flows check` is stricter than the kernel
on inputs the kernel already accepts, a coupling that will bite when the
kernel grows a non-default retry policy for a specific step class.

**Fix shape:** either relax the check to accept anything the kernel accepts
(the honest fix), or rename the check and the error message to name it
honestly — *"`flows check` does not yet re-derive retry policy from
arbitrary kernel-dialect specs; produced specs must match the SDK's
authoring defaults."* Pick one.

### F9 — `probeTrigger` still catches every error with no classification *(carried)*

**Where:** `sdk/src/preflight.ts:200-217`.

`probeResolvedCli` uses `CliProbeError` to preserve `detail`; `probeTrigger`
uses a bare `catch { }` and emits `probe_failed` with no `detail`, no cause.
Today `probes.executor` is a synchronous membership check that cannot
realistically throw (`sdk/src/cli.ts:182`), so this branch is closer to dead
than to unpinned. But `docs/SURFACE.md`'s WP-9 disclosure — *"gate 1 does
not yet contact a registry, broker, or RelayCron, and absence is
`no_executor`"* — is a promise this predicate will grow past. At that point
the bare catch silently classifies broker timeouts, signals, and connection
failures identically. When the same path exists twice in a module with two
different levels of care, six months later someone models the sloppier one
and files a bug about the tighter one.

**Fix shape:** either reuse `CliProbeError` for the trigger probe, or add a
sibling `TriggerProbeError` with the same discriminated detail. Match
`probeResolvedCli` so both surfaces evolve together.

### F10 — Small load-bearing details on the boundary that a reader will trip over *(carried, still real)*

- **`PreflightProbes.executor(trigger: TriggerSpec)`**
  (`sdk/src/preflight.ts:44`) receives the whole trigger struct while every
  implementation and call site reads only `trigger.executor`
  (`sdk/src/cli.ts:182`). A reader assumes `id` or something else is used.
  Narrow to `(executor: string)` or add a one-line note explaining why the
  full struct is passed. Rendering the diagnostic already has access to
  `trigger.id` at the call site, so the wide type is not load-bearing today.
- **`ProjectConfig.directory`** (`sdk/src/cli.ts:22`) means *"the config's
  directory"* when a config exists and *"the flow's directory"* when none
  does (`sdk/src/cli.ts:137-139`). Only the first case is read in
  `systemProbes` (`sdk/src/cli.ts:181`). The dual meaning is invisible from
  the type; either narrow it (`configDirectory?: string`) or comment it.
- **`warnOnUnprovableEffects`** re-tests `step.type === 'deterministic'`
  (`sdk/src/preflight.ts:242`) that its caller already tested one line
  earlier (`sdk/src/preflight.ts:87-88`). Either the guard is defensive
  against future callers (say so), or drop it and narrow the parameter to
  `DeterministicStepSpec`.
- **`readProjectConfig`** rejects every key outside `cli`/`executors`
  (`sdk/src/cli.ts:146-148`), so a `"$schema"` key (a convention every
  editor understands, cheap autocomplete) is a hard `config_invalid`. A
  stranger who adds it — legitimately — gets a refusal from `flows check`.
  Either allowlist `$schema` explicitly or explain in the message that this
  is a covenant-2 fail-closed choice.
- **The 5-second `which` timeout** is documented nowhere. `SURFACE.md`
  names the 10s auth-probe timeout; the sibling 5s timeout can equally
  surface as `probe_failed` (see `'timeout:5000ms'` in the union), and the
  contract does not mention it.

### F11 — Six months of open findings live only in `ops/reviews/` *(carried; the pile grew again)*

**Where:** `ops/reviews/` — this PR adds ~10.7k lines of review artefacts to
a ~18.7k-line diff. The tree now holds >60 `pr8-*.md` files with no index.
This is a maintainability concern about the change itself, not about the
shipped code.

The last several rounds recorded the same open findings, none of which made
it into `ops/BACKLOG.md` (which does keep four other deferred items well —
Codex P1, the `steps: []` asymmetry, WP-7 F6, the release pipeline).
Reconstructing the live open set for this review meant reading the last
review and diffing it against the current tree. The cost is small this time
and would be zero if F1/F2/F5/F6 had landed as one-line commits between
rounds.

RFC §2 rule 5 makes pruning the norm — rules are *"added when a review
surfaces a new failure class and pruned when they stop firing."* One
`ops/reviews/PR8-OPEN.md` carrying the live findings (superseded rounds
marked as such), or promoting F1–F10 into `ops/BACKLOG.md`, closes this.
Cost: one file.

## Positive notes — patterns worth keeping

- **Closed diagnostic taxonomy pinned by a reachability test.**
  `sdk/tests/preflight.test.ts:177-191` pins *"declared → emitted"*
  mechanically; the compiler pins the converse via the
  `PreflightRefusal.kind` type. Two assertions cover the whole covenant-2
  refusal taxonomy in both directions. Same shape for warnings at
  `sdk/tests/preflight.test.ts:157-170`. Unusually good.
- **`ladderVariant` fixture pattern** (`sdk/tests/cli.test.ts:55-62`).
  Induces each fault on the *canonical ladder flows themselves* in a
  hermetic temp directory, with a control test that proves the refusals
  belong to the fault rather than the relocation
  (`sdk/tests/cli.test.ts:149-153`). AGENTS.md's *"evidence is captured,
  not narrated"* made flesh.
- **Pure-predicate `preflight()`.** `sdk/src/preflight.ts` imports zero
  from `node:*`; all I/O is behind `PreflightProbes`, and the seam is
  three methods. AGENTS.md rule 2 as file layout.
- **`RunSpec.triggers`' docstring** (`kernel/…/src/spec.rs` above the
  field) names its own boundary — *"Inert gate-1 declarations. Matching and
  dispatch belong to gate 2."* A stranger reading `spec.rs` learns why the
  field does nothing, which is the question they would otherwise file a bug
  about. Same for the `RunSpec.cli` comment naming that `run.start` does
  not invoke surface preflight in gate 1.
- **`kernelDialectMarker`** cleanly separates dialect detection from
  authoring parsing and tells the operator which specific key triggered the
  routing decision (`sdk/tests/cli.test.ts:77-100` pins this end-to-end).
- **`preflight_data_is_fail_closed`** exhaustively asserts each new
  `SpecError` variant and pins `deny_unknown_fields` on `TriggerSpec` with
  a guessed `worker` key.
- **`docs/SURFACE.md`** now explicitly discloses the WP-9 asymmetry:
  `command_unresolved` is a warning (not a refusal) because a bare word may
  be a shell builtin/function/assignment under `/bin/sh -c`, and the
  narrower path-like check is tracked in `ops/BACKLOG.md`. The stranger's
  next question is answered where they are already reading.

## Tests that would not fail if behaviour broke

- **Every hung probe silently reclassified as `spawn_failed`** if
  `sdk/src/cli.ts:222` diverges from Node's `'ETIMEDOUT'`: no test catches
  it (F3). The diagnostic-rendering tests all throw at the seam.
- **`failure_reasons` in `machine/tests.rs:66-75` misses a new
  `CompletionReason` variant**: the test name still says *"every"*; there
  is no compile-time check to force additions (F5).
- **The two probe timeouts drift**: the type-level constraint only ensures
  the argument is one of `5_000 | 10_000`, not that it matches the spawn
  option (F2). A wrong pair type-checks.
- **`probeFailedMessage` calls a new detail a "timeout"** because no test
  or type binds the fall-through to the timeout variants only (F1).

## Summary

Same shape as the prior verdict: the preflight surface is well-shaped —
small, pure, closed taxonomy, tested against reachability in both directions.
The carried findings F1/F2/F5/F6/F8b are exactly what this lens exists to
name, and every one of them is a one-line fix to a specific line already
identified across multiple prior rounds. None crosses a covenant; none blocks
merge.

If forced to pick three to close *before merge* — F1 (a lying diagnostic is
worse than no diagnostic; this is exactly what M3 fixed and this PR
reintroduced through the path M3's fix created), F2 (the shape of
duplication that becomes wrong under a routine *"let's give the probe more
time"* edit), and F5 (the kernel test whose name will lie the moment a
covenant-2 failure kind is added — which is the very direction the RFC says
the kernel is going). But the shipped code is honest and the taxonomy is
mechanically closed. Cleared to merge.

REVIEW_PASSED
