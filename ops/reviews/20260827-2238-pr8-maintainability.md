# PR #8 — Maintainability Review

- **PR:** #8 — *WP-4 — flows check preflight (covenant 2)*
- **Branch:** `flow/drive-57e923c-08271542`
- **HEAD:** `18f03be` (last code-bearing commit `18f03be` — a SURFACE.md
  disclosure change; the last code-bearing change to `sdk/`/`kernel/` is
  `2701aef`/`6fab45a`, WP-8).
- **Lens:** Maintainability — could a stranger read this in six months and
  change it safely?
- **Reviewer:** maintainability agent (non-interactive)
- **Reviewed at:** 2026-08-27 22:38 UTC

## Read

- `AGENTS.md`, `docs/RFC-0001-everything-is-a-relayflow.md`, `docs/SURFACE.md`
  (the WP-4/WP-9 additions in the diff).
- The whole diff at `/tmp/pr-8.diff` (91 files, ~15.6k lines; ~11k are in
  `ops/`).
- The current-tree files that carry the shipped behaviour:
  `sdk/src/preflight.ts`, `sdk/src/cli.ts`, `sdk/src/failure-kinds.ts`,
  `sdk/src/compile.ts`, `sdk/src/validate.ts`, `sdk/src/spec.ts`,
  `sdk/src/index.ts`, `sdk/scripts/make-cli-executable.mjs`.
- `sdk/tests/preflight.test.ts`, `sdk/tests/cli.test.ts`, `sdk/tests/bin.test.ts`.
- `kernel/relayflowd-core/src/spec.rs` (diff), `kernel/…/src/spec/tests.rs`,
  `kernel/…/src/machine/tests.rs`.
- `testdata/preflight/*` fixtures.

The stranger test: a competent TS/Rust engineer who has read the RFC lands on
this diff cold. Can they change it safely?

## Verdict

**Broadly yes.** The preflight surface is small and I/O-free (`preflight.ts`
imports zero from `node:*`); everything shell-ish lives behind
`PreflightProbes` in `cli.ts`. The refusal taxonomy is closed
(`PreflightFailureKind`) and the reachability test in
`preflight.test.ts:177-191` pins the direction the type system cannot
(kind emitted → declared) with the compiler pinning the converse. Covenant
2's "refuse *or* warn, never silence" is stated as a per-branch test on
deterministic steps (`preflight.test.ts:145-155`). Diagnostics carry
structured `detail` for the paths where an operator needs to distinguish
timeout / signal / spawn failure. The kernel additions
(`RunSpec.cli`, `triggers`) are marked inert in their docstrings and are
validated fail-closed with per-cause `SpecError` variants.

Six carried findings from the last round remain open in the tree and are
still real — they are places where a future edit is likelier to break
something silently than the rest of the diff. Two of them (F1, F2) are
prospective traps where the *next* edit will render a false diagnostic under
a green build. None blocks merge.

## Findings

### F1 — `probeFailedMessage`'s fall-through will assert "timed out" about any new detail *(verified by reading)*

**Where:** `sdk/src/preflight.ts:187-198`.

```ts
if (detail === undefined) return `${prefix}.`;
if (detail === 'spawn_failed') return `${prefix}: the probe process could not be started.`;
if (detail.startsWith('signal:')) {
  return `${prefix}: the probe was terminated by signal "${detail.slice('signal:'.length)}".`;
}
return `${prefix}: the probe timed out after ${detail.slice('timeout:'.length)}.`;
```

The final `return` assumes any `detail` that is neither `undefined`,
`spawn_failed`, nor `signal:*` is a timeout string. That is true today
because `CliProbeFailureDetail` has exactly three shapes, but the union is
the canonical place a maintainer will add a fourth. `tsc` will not object,
because the fall-through infers `detail` as `string`. If the next variant is
`'permission_denied'`, the CLI will render *"the probe timed out after
on_denied."* — a message that is both false and visibly garbled, produced
by a green build.

M3's whole point was that `probe_failed` must tell the operator what
actually happened. A silent fall-through converts "no information" into
"wrong information," which is worse than the state M3 replaced.

**Fix shape:** exhaust the union — match `detail.startsWith('timeout:')`
explicitly and let a genuine fall-through assign `detail` to a `never`-typed
local. The next variant then becomes a compile error instead of a lie.
One-line change.

### F2 — Probe timeouts are two literals per call site; the classifier's `timeoutMs` type does not bind them *(verified by reading)*

**Where:** `sdk/src/cli.ts:190-198` (auth probe) and `sdk/src/cli.ts:210-213`
(`which` resolver), plus the type
`type CliProbeFailureDetail = … | 'timeout:5000ms' | 'timeout:10000ms' | …`
in `sdk/src/preflight.ts:22-24`.

```ts
const result = spawnSync(executable, ['auth', 'status'], { …, timeout: 10_000 });
const failure = classifySpawnFailure(result.error, result.signal, 10_000);
```

Duration `10_000` is written twice with nothing linking the copies. If a
future edit changes the spawn timeout to `30_000` and leaves the classifier
argument at `10_000`, the code type-checks, the tests stay green (there is
no end-to-end timeout test — see F3), and a probe that hung for 30 seconds
tells the operator *"timed out after 10000ms"*. The same duplication exists
for `5_000` in `resolveExecutable`. `SURFACE.md` names the 10s figure as
part of the contract; the 5s figure is not disclosed anywhere.

The parameter type `timeoutMs: 5_000 | 10_000` on `classifySpawnFailure` is
clearly trying to enforce a link, but it constrains the *argument*, not its
*agreement* with the spawn option, which is the half that matters. It also
propagates a magic-number pair through the type union
(`'timeout:5000ms' | 'timeout:10000ms'`) with no cross-reference from
either side to the numbers in `cli.ts`.

**Fix shape:** two named constants (`AUTH_PROBE_TIMEOUT_MS`,
`WHICH_TIMEOUT_MS`) declared once, referenced at both the spawn call and
the classifier, and used to build the literal detail
(`` `timeout:${AUTH_PROBE_TIMEOUT_MS}ms` ``). Then changing one number
either propagates or breaks the build. Add a one-line note on why the two
timeouts differ; today no comment says.

### F3 — The `timeout:*` production path has no end-to-end coverage

**Where:** `sdk/tests/preflight.test.ts:107-121` and `sdk/tests/bin.test.ts`.

`preflight.test.ts` covers the timeout by *throwing* a
`new CliProbeError('timeout:10000ms')` directly at the seam — that pins the
rendering of the diagnostic, not the classifier that produces the string.
`bin.test.ts` exercises the `signal:` and `spawn_failed` classifications
against the real built binary, but there is no fixture for a hung probe,
understandably (10s of wall clock). The only line that turns a hung probe
into `timeout:` rather than `spawn_failed` is
`cli.ts:222`: `(error as NodeJS.ErrnoException).code === 'ETIMEDOUT'`.
That line is unpinned: replacing `'ETIMEDOUT'` with a string that never
matches would leave every hung probe classified as `spawn_failed` and the
suite would stay green.

**Fix shape:** a direct unit test of `classifySpawnFailure` against a
synthetic `{ code: 'ETIMEDOUT' } as NodeJS.ErrnoException` — no wall clock,
pins the one line that matters. Or a fixture CLI with a `sleep` invoked
under an injected shorter timeout.

### F4 — Kernel-dialect field lists live in three files with no cross-reference *(carried)*

**Where:**
- `kernel/relayflowd-core/src/spec.rs:139-152` (`STEP_LLM_FIELDS`,
  `STEP_AGENT_FIELDS`),
- `sdk/src/compile.ts:188-204` (`unionKeys`, per-type key arrays in
  `kernelStepToAuthoring`),
- `sdk/src/cli.ts:262-284` (`kernelDialectMarker`'s `kernelStepKeys`,
  `kernelBudgetKeys`, `kernelVerificationKeys`, `kernelPermissionKeys`).

Registering a new snake_case kernel field means touching all three, and
no comment in any file names the other two. This PR added `cli` to
`STEP_LLM_FIELDS`/`STEP_AGENT_FIELDS` and to `compile.ts:unionKeys`, and
correctly *did not* add it to `kernelStepKeys` (since `cli` is spelled
identically in both dialects and is not a routing marker). The next
person will re-derive that judgment from scratch, and the failure mode is
a confusing routing message at a user, not a red build. AGENTS.md rule 3
("the journal protocol is the boundary") is exactly the sort of place
that a comment saying *"if you add a field here, also register it in
`compile.ts:unionKeys` and consider `cli.ts:kernelDialectMarker`"*
would prevent long-term drift.

### F5 — `every_failed_run_terminates_with_declared_completion_reasons` iterates a hand-maintained list *(carried; verified by reading)*

**Where:** `kernel/relayflowd-core/src/machine/tests.rs:66-75`.

```rust
let failure_reasons = [
    CompletionReason::VerificationFailed,
    CompletionReason::RetriesExhausted,
    …
    CompletionReason::Canceled,
];
```

The array is complete today (I confirmed the enum has exactly these eight
plus `Success`), but nothing holds it complete. Adding
`CompletionReason::EnvironmentLost` — a variant RFC covenant 2 explicitly
names in the closed failure set the kernel is expected to grow into —
compiles clean and the test's name still claims "every." The first person
to add a variant will get a green build and a test whose name says it
covered them.

The `SpecError` tests in the same subsystem already use exhaustive
`assert_eq!` on each variant; the pattern exists in-repo. `strum::EnumIter`
or an exhaustive `match` in a small helper (`is_failure(&reason) -> bool`
with no `_` arm) would make the loop's coverage load-bearing rather than
aspirational.

### F6 — `SpecError::InvalidTrigger` collapses two distinct faults into one message

**Where:** `kernel/relayflowd-core/src/spec.rs:70-80` (validation) and
`spec.rs:428-434` (message).

```rust
if trigger.id.trim().is_empty() || trigger.executor.trim().is_empty() {
    return Err(SpecError::InvalidTrigger(trigger.id.clone()));
}
```

Error: `"trigger {0} must declare a non-empty id and executor"`. When
`id` is empty and `executor` is present, `{0}` renders empty and the
operator sees *"trigger  must declare a non-empty id and executor"* — two
consecutive spaces and no signal about which field is at fault. When
`executor` is empty and `id` is `hourly`, the message *reads* as if both
fields are at fault when only one is. The rest of the taxonomy is precise
(`EmptyStepId`, `EmptyStepCli(id)`, `DuplicateTrigger(id)`); this one
collapses two faults into one and produces a garbled message in the id case.

The unit test `preflight_data_is_fail_closed` cheerfully asserts
`Err(SpecError::InvalidTrigger("".to_owned()))` for the empty-id case —
which reads to a maintainer as "the empty string is a valid trigger id
here," reinforcing the confusion.

**Fix shape:** split into `EmptyTriggerId` and `EmptyTriggerExecutor(id)`.
Two enum variants and two message strings. The test then asserts against
distinct kinds and stops encoding the wrong invariant.

### F7 — `readProjectConfig` uses positional key membership; the spec validator has `nearestKey` *(carried)*

**Where:** `sdk/src/cli.ts:146-148`.

```ts
if (!isObject(value) || Object.keys(value).some((key) => !['cli', 'executors'].includes(key))) {
  throw new CheckFailure('config_invalid', `Project config "${configPath}" expects only cli and executors.`);
}
```

`sdk/src/validate.ts` uses Levenshtein + normalization to say *"unknown key
`depends_on` — did you mean `dependsOn`?"* That is a real UX investment for
one config surface (`flows.json`) and it is missing on the other. An
author who types `{"clis": "…"}` or `{"executor": [...]}` (both
plausible mistakes) is told only *"expects only cli and executors"* and
left to guess. The two surfaces have the same audience.

Small, but exactly the kind of inconsistency that becomes cargo-cult
("preflight uses one style, `flows.json` uses another; I guess we don't do
suggestions here"). Extracting `nearestKey` from `validate.ts` into a
tiny helper — or just duplicating three lines — would close it.

### F8 — Comments overstate what the code enforces (three cases)

Each of these makes a stranger's mental model wrong about the code:

**F8a — `spec.ts:162`:** `/** Spec schema semver (RFC §7). Compilers always
emit latest. */` on `FlowSpec.version`. The comment describes the writer;
`validate.ts` is the reader and accepts *exactly* `SPEC_SCHEMA_VERSION`,
rejecting every other semver. A reader of the type will guess wrong about
`0.2.0`. Rename to *"Spec schema semver; this SDK accepts exactly
`SPEC_SCHEMA_VERSION`."*

**F8b — `compile.ts:132-138`:** `KERNEL_RETRY_DEFAULTS` is documented as
*"materialized at compile time so the emitted spec is byte-identical to the
kernel's own serialization of it."* The nearby `validateKernelRetry`
enforces the *reverse* — that a kernel-dialect spec offered to `flows check`
must match the same defaults byte-for-byte, and refuses valid kernel specs
with different retry policies (the kernel itself accepts them). The
error message *"retry.multiplier must equal the authoring default 2"* names
the authoring rule as if the kernel imposed it. A hand-written kernel spec
or a different producer will be told the wrong thing. Either relax the
check to accept anything the kernel accepts, or name it honestly:
*"this CLI does not yet re-derive retry policy from arbitrary kernel
specs; produced specs must match the SDK's authoring defaults."*

**F8c — `preflight.ts:141-143`:** the "source is load-bearing" comment on
the probe cache key is correct today because `preflight()` runs on one flow
at a time (so `(cli, source)` uniquely identifies a resolution directory).
The comment does not warn that the invariant depends on the caller's
one-flow-per-call discipline. A future `flows check <dir>` that reuses the
cache across sibling flows would silently collide (two flows in different
subdirectories both declaring `./shared-cli` under `source: 'step'` would
share one probe result and one probe's answer). A one-line
*"invariant: one preflight() call = one flow directory"* — or, more
robustly, keying on the resolved absolute path — would pin the coupling.

### F9 — `probeTrigger` still catches every error with no classification *(carried)*

**Where:** `sdk/src/preflight.ts:200-217`.

`probeResolvedCli` uses `CliProbeError` to preserve `detail`;
`probeTrigger` uses a bare `catch { }` and emits `probe_failed` with no
`detail`, no cause. Today `probes.executor` is a synchronous membership
check that cannot realistically throw (see `cli.ts:182`), so this branch
is closer to dead than to unpinned. But `docs/SURFACE.md`'s wp9
disclosure ("`flows check` does not yet contact a registry, broker, or
RelayCron, and absence is `no_executor`") is a promise this predicate
will grow past — at which point the catch will silently classify broker
timeouts, signals, and connection failures identically. When the same
path exists twice in a module with two different levels of care, six
months later someone models the sloppier one and files a bug about the
tighter one.

**Fix shape:** either reuse `CliProbeError` for the trigger probe, or
introduce a sibling `TriggerProbeError` with the same discriminated
detail. Match `probeResolvedCli` so both surfaces evolve together.

### F10 — Small load-bearing details on the boundary that a reader will trip over

Individually cheap, together the class of thing this lens exists to catch:

- **`PreflightProbes.executor(trigger: TriggerSpec)`** (`preflight.ts:44`)
  receives the whole trigger while every implementation and call site
  reads only `trigger.executor`. A reader assumes the id or something
  else is used. Narrow the type to `(executor: string)`, or add a
  one-line note explaining why the full struct is passed. *(carried)*
- **`ProjectConfig.directory`** (`cli.ts:22`) means "the config's
  directory" when a config exists and "the flow's directory" when none
  does; only the first case is read in `systemProbes`. The dual meaning
  is invisible from the type. *(carried)*
- **`warnOnUnprovableEffects`** re-tests `step.type === 'deterministic'`
  (`preflight.ts:242`) that its caller already tested one line earlier
  (`preflight.ts:88`). Either the guard is defensive against future
  callers (say so), or drop the guard and narrow the parameter type.
  *(carried)*
- **`readProjectConfig`** rejects every key outside `cli`/`executors`,
  so a `"$schema"` key (a convention every editor understands) is a hard
  `config_invalid`. A stranger who adds it — legitimately, to get
  autocomplete — gets a refusal from `flows check`. *(carried)*
- **The 5-second `which` timeout** is documented nowhere. `SURFACE.md`
  names the 10s auth-probe timeout; the sibling 5s timeout can equally
  surface as `probe_failed` (see `'timeout:5000ms'` in the union), and
  the contract does not mention it.

### F11 — The review record still cannot answer "what is still open?" *(carried; the pile grew)*

**Where:** `ops/reviews/` — this PR adds ~10.5k lines of review artefacts
to a ~13k-line diff (excluding `package-lock.json`); the tree now holds
50+ review files with no index. This is a maintainability concern about the
change itself, not about the shipped code.

Two prior maintainability rounds recorded open findings that never made it
into `ops/BACKLOG.md` (which does keep four other deferred items well —
the Codex P1 deterministic-command gap, the `steps: []` asymmetry, the
WP-7 F6 probe-environment scoping, the release pipeline). Reconstructing
the live open set for this review meant reading the last three review
files and diffing them against the current tree — the cost is real and
the record's growth is outpacing its usefulness.

RFC §2 rule 5 makes pruning the norm — rules are "added when a review
surfaces a new failure class and pruned when they stop firing." One
`ops/reviews/PR8-OPEN.md` carrying the live findings (with superseded
rounds marked as such), or promoting F1–F10 into `ops/BACKLOG.md`,
closes it. Costs one file.

## Positive notes — patterns worth keeping

- **Closed diagnostic taxonomy pinned by a reachability test.**
  `preflight.test.ts:177-191` asserts that the produced `refusalKinds`
  equal `PREFLIGHT_FAILURE_KINDS` exactly; the compiler pins the converse.
  That pair covers "kind declared but never emitted" and "kind emitted but
  not declared" in two assertions. Same shape for warnings at
  `preflight.test.ts:157-170`. This is the whole covenant-2 taxonomy
  pinned mechanically, which is unusually good.
- **`ladderVariant` fixture pattern** (`cli.test.ts:55-62`). Induces
  each fault on the *canonical ladder flows themselves* in a hermetic
  temp directory, with a control test
  (`passes relocated ladder flow ... when no fault is induced`,
  `cli.test.ts:149-153`) that proves the refusals are the fault, not the
  relocation. AGENTS.md's "evidence is captured, not narrated" made
  flesh.
- **Pure-predicate `preflight()`.** `sdk/src/preflight.ts` imports zero
  from `node:*`; all I/O is behind `PreflightProbes`, and the seam is
  small (three methods). AGENTS.md rule 2 in the file layout.
- **`RunSpec.triggers`' docstring** (`spec.rs:98-100`) names its own
  boundary — *"Inert gate-1 declarations. Matching and dispatch belong to
  gate 2."* A stranger reading `spec.rs` learns why the field does
  nothing, which is the question they would otherwise file a bug about.
- **`kernelDialectMarker`** cleanly separates dialect detection from
  authoring-parsing and tells the operator which specific key triggered
  the routing decision (`cli.test.ts:77-100` pins this end-to-end).
- **`kernelToAuthoring`** fails closed on unknown fields
  (`assertKernelKeys`), preserving RFC decision #5.
- **`preflight_data_is_fail_closed`** exhaustively asserts each new
  `SpecError` variant rather than sampling them, and pins
  `deny_unknown_fields` on trigger with a guessed `worker` key.

## Summary

The preflight surface is well-shaped: small, pure, tested against a
closed taxonomy, and read cleanly cold. What remains is a familiar
maintainability class — comments that assert more than the code
enforces, coverage gaps over verified-correct code, and two prospective
traps (F1's fall-through diagnostic, F2's duplicated timeout literal)
where the *next* edit renders a false message under a green build. None
of it blocks merge.

If I could pick three to close before merge, I would pick F1 (a lying
diagnostic is worse than no diagnostic — this is exactly what M3 fixed
last round, reappearing on the path M3's fix created), F2 (the shape of
duplication that becomes wrong under a routine "let's give the probe
more time" edit), and F5 (the kernel test whose name will lie the moment
a covenant-2 failure kind is added — which is the very direction the RFC
says the kernel is going).

REVIEW_PASSED
