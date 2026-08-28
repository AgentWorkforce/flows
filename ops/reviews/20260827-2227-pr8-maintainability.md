# PR #8 — Maintainability Review

- **PR:** #8 — *WP-4 — flows check preflight (covenant 2)*
- **Branch:** `flow/drive-57e923c-08271542`
- **Lens:** Maintainability — "could a stranger read this in six months and change it safely?"
- **Reviewer:** maintainability agent (non-interactive)
- **Reviewed at:** 2026-08-27 22:27 UTC

I read `AGENTS.md`, `docs/RFC-0001-everything-is-a-relayflow.md`, `/tmp/pr-8.diff`, and
the current tree files that carry the meat of the change:

- `sdk/src/preflight.ts` (pure predicates)
- `sdk/src/cli.ts` (I/O + config + spawn shell)
- `sdk/src/failure-kinds.ts` (closed taxonomy)
- `sdk/src/spec.ts`, `sdk/src/compile.ts`, `sdk/src/validate.ts`
- `sdk/tests/preflight.test.ts`, `sdk/tests/cli.test.ts`, `sdk/tests/bin.test.ts`,
  `sdk/tests/validate.test.ts`
- `kernel/relayflowd-core/src/spec.rs` (+ `spec/tests.rs`, `machine/tests.rs`)
- `testdata/preflight/*` and the ladder fixtures

The stranger test: a competent TS/Rust engineer who has read the RFC lands on
this diff cold. Can they change it safely?

**Verdict:** Broadly yes. The preflight module is small, pure, and the
predicates test well. Diagnostics are typed to a closed taxonomy that a
compiler enforces (`PreflightFailureKind`), and covenant 2's "refuse or warn,
never silence" is checked by a test that requires every declared warning kind
and every declared refusal kind to be reachable. That is unusually good.

There are, however, a handful of implicit contracts, one clearly load-bearing
comment that overstates what the code does, and two tests whose failure modes
would not catch the regression they appear to guard against. Full findings
below.

## Findings

### M1 — `CliProbeFailureDetail` duplicates timeout constants across three files

**Where:** `sdk/src/preflight.ts:20-24`, `sdk/src/cli.ts:193,210,219`.

```ts
// preflight.ts
export type CliProbeFailureDetail =
  | 'spawn_failed'
  | 'timeout:5000ms'
  | 'timeout:10000ms'
  | `signal:${string}`;

// cli.ts
spawnSync(executable, ['auth', 'status'], { ..., timeout: 10_000 });
spawnSync('which', [command], { ..., timeout: 5_000 });
classifySpawnFailure(result.error, result.signal, 10_000);
```

The literal-string type in `preflight.ts` enumerates exactly the two millisecond
values used in `cli.ts`. There is nothing on the type side that binds these
values together. A six-months-later change from 10 s to 15 s in `cli.ts` will
change the string in the diagnostic message but the type `'timeout:10000ms'`
will stay in place, and TypeScript will not warn — because
`classifySpawnFailure` accepts `timeoutMs: 5_000 | 10_000` as an intersecting
literal, and template-string mismatch is only caught at the throw site.

**Fix shape:** define the two timeouts as `const AUTH_PROBE_TIMEOUT_MS = 10_000`
and `PATH_RESOLVE_TIMEOUT_MS = 5_000` in one file, derive the literal-union
type from them (`` `timeout:${typeof AUTH_PROBE_TIMEOUT_MS}ms` ``), and pass
those constants into `classifySpawnFailure`. Then the type breaks the moment a
constant changes.

### M2 — `probeTrigger` catches every error with no classification

**Where:** `sdk/src/preflight.ts:200-217`.

```ts
try {
  registered = probes.executor(trigger);
} catch {
  diagnostics.push({
    severity: 'refusal',
    kind: 'probe_failed',
    triggerId: trigger.id,
    executor: trigger.executor,
    message: `Could not verify executor "${trigger.executor}" for trigger "${trigger.id}".`,
  });
  return;
}
```

Compare with `probeResolvedCli`, which uses `CliProbeError` to preserve a
classified detail (`spawn_failed`, `timeout:...`, `signal:...`). The trigger
path throws away everything: no `detail`, no cause, no way for an operator to
distinguish a spawn failure from a timeout from a signal. It also silently
elides the original error message, so a probe that failed for an unexpected
reason leaves no evidence outside of the (already-elided) exception.

Today `probes.executor` in the CLI is a synchronous membership check that
cannot realistically throw, so this may never fire — which is exactly why the
gap is hard to spot and easy to widen. When gate 2 replaces this predicate
with a broker query, the failure mode arrives silently classified as
"probe_failed, no detail."

**Fix shape:** either reuse `CliProbeError` for triggers, or add a
`TriggerProbeError` with the same discriminated detail. Match `probeResolvedCli`
so both surfaces evolve together.

### M3 — The "probe never invokes any other subcommand" contract is documented
but not tested

**Where:** `docs/SURFACE.md:82-85`, `sdk/src/cli.ts:187-198`.

The SURFACE.md paragraph added by this PR promises: *"preflight never sends a
prompt, never spends a token, and never invokes any other subcommand."* The
`bin.test.ts` `counting-cli` fixture asserts one probe per shared CLI, but
neither the CLI nor the test file pins the *argv* of the probe (`['auth',
'status']`) at the process boundary. If a future refactor accidentally passes
`['auth', 'status', '--json']`, `['auth', 'health']`, or a stray prompt, the
existing tests all still pass — the fixture only checks `$1 = auth && $2 =
status` and exits 0. A test that reads the fixture's argv log ("`auth status`
with no additional args, nothing else invoked") would pin the contract that
the doc claims.

### M4 — Comment on `retry` validation asserts more than the code enforces

**Where:** `sdk/src/compile.ts:240-251`, `sdk/tests/cli.test.ts:272-284`.

`validateKernelRetry` rejects any kernel spec whose `retry` policy differs
byte-for-byte from `KERNEL_RETRY_DEFAULTS`. The message is *"retry.multiplier
must equal the authoring default 2"*. But the CLI is advertised as *"the
compiled kernel-dialect canonical spec"* checker, and the kernel itself
accepts any well-formed retry policy (`step.retry.validate` in `spec.rs`). The
CLI therefore refuses valid kernel specs that were produced by anything other
than this SDK. That is a hidden precondition, and it is not called out in
`SURFACE.md`, `cli.ts`, or the test's `describe` name.

Six months from now, someone hand-writing a compiled spec — or another
compiler emitting one — will see *"multiplier must equal the authoring default
2"* and reasonably conclude the *kernel* imposes that constraint. The comment
in the function ("materialized at compile time so the emitted spec is
byte-identical to the kernel's own serialization of it") reinforces the wrong
mental model.

**Fix shape:** rename the error to name the check honestly ("compiled spec
retry policy must match the SDK's authoring defaults; the kernel accepts other
values but the CLI does not re-derive them yet"), or relax `validateKernelRetry`
to accept any policy the kernel would accept. Prefer the former if the intent
is "this CLI checks specs *this* SDK emits."

### M5 — Cache key does not encode the resolution directory

**Where:** `sdk/src/preflight.ts:135-154`.

```ts
const cacheKey = JSON.stringify([resolution.cli, resolution.source]);
```

The load-bearing comment above it explains that `source` is what distinguishes
`./shared-cli` under a project config from `./shared-cli` under a flow. That is
correct today because `preflight()` runs on one flow at a time and there is
one project directory per call — so the `(cli, source)` pair is a stand-in for
`(cli, resolution-directory)`. That coupling is not stated in the type. If
someone later reuses the cache across sibling flows (an obvious optimization
for `flows check <dir>`), the invariant silently breaks: two flows in
different subdirectories with the same relative `./shared-cli` will cache
together and hit whichever probe answered first.

**Fix shape:** either encode the resolved absolute path in the cache key, or
add a `// invariant: one preflight() call = one flow directory` assert. A test
that runs two flows in different directories through the same probe would
express the contract.

### M6 — `probes.cli` exception path silently drops detail for non-`CliProbeError`

**Where:** `sdk/src/preflight.ts:146-165`.

```ts
outcome = { failure: detail ?? null };
...
if ('failure' in outcome) {
  const detail = outcome.failure ?? undefined;
  diagnostics.push({ ..., ...(detail !== undefined ? { detail } : {}), ... });
}
```

If the probe throws anything other than a `CliProbeError`, the diagnostic
becomes `probe_failed` with no `detail`. That is defensive against injection
of raw exception text (the test `reports a classified probe cause without
leaking raw exception text` pins this — good). But it means the *only* way to
add a new failure classification is to invent a new `CliProbeError` variant,
and there is no test that fails when a new `spawnSync` failure mode goes
unclassified. A `spawnSync` bringing back `ENOMEM` in the future will be
silently bucketed as "probe_failed, no detail." A comment above
`classifySpawnFailure` would help — currently the classification lives
half-implicitly in the type union.

### M7 — Config schema uses positional key-check while the spec validator has
`nearestKey`

**Where:** `sdk/src/cli.ts:146-148`.

```ts
if (!isObject(value) || Object.keys(value).some((key) => !['cli', 'executors'].includes(key))) {
  throw new CheckFailure('config_invalid', `Project config "${configPath}" expects only cli and executors.`);
}
```

The spec validator (`validate.ts`) goes to some lengths — `nearestKey`,
Levenshtein — to say *"unknown key `depends_on` — did you mean `dependsOn`?"*
This surface is the same UX (`flows.json`), the same audience (an author who
mistyped `clis` or `executor`), and the error handling is a bare "expects only
cli and executors." A user with `{"cli": "x", "executor": ["y"]}` gets no hint
that they meant `executors`. Small, but exactly the kind of inconsistency that
becomes cargo-cult ("preflight uses one style, `flows.json` uses another; I
guess we don't do suggestions here").

### M8 — `SpecError::InvalidTrigger` cannot tell an author which field is empty

**Where:** `kernel/relayflowd-core/src/spec.rs:70-80,430-434`.

```rust
if trigger.id.trim().is_empty() || trigger.executor.trim().is_empty() {
    return Err(SpecError::InvalidTrigger(trigger.id.clone()));
}
```

Error: `"trigger {0} must declare a non-empty id and executor"`. When the
`id` is empty and the `executor` is present, `{0}` is `""` and the operator
sees `"trigger  must declare a non-empty id and executor"`. When the
`executor` is empty and the `id` is `hourly`, the message *appears* to accuse
both fields. The spec.rs error taxonomy is otherwise precise (`EmptyStepId`,
`EmptyStepCli(id)`, `DuplicateTrigger(id)`); this one collapses two distinct
faults into one. Cheap to split into `EmptyTriggerId` / `EmptyTriggerExecutor(id)`.

### M9 — `preflight_data_is_fail_closed` bundles seven unrelated assertions

**Where:** `kernel/relayflowd-core/src/spec/tests.rs:121-172`.

The test now covers: `deny_unknown_fields`, empty flow CLI, empty trigger id,
empty trigger executor, duplicate trigger, empty step CLI. Any early
failure short-circuits later ones, so a regression in the last bucket is
invisible until the earlier ones pass again. `#[test]` per case (or
`rstest`-style parameterization) would isolate the failure mode. This mirrors
the good pattern already used on the TS side in `validate.test.ts`
(`describe: preflight declarations` splits by case).

### M10 — `every_failed_run_terminates_with_declared_completion_reasons` proves
one thing, not the two it appears to

**Where:** `kernel/relayflowd-core/src/machine/tests.rs:65-104`.

The test loops over eight `CompletionReason` variants and asserts each maps to
`RunCompletionReason::StepFailed`. It gives the impression it pins "every
failure kind is a *declared* completion reason." What it actually pins is
"these eight enum values, when injected as `failure_reason`, deserialize
through `StepCompletedPayload`." If a ninth variant is added to
`CompletionReason` and the terminal-run logic forgets it, this test does not
regress — the loop only iterates over the eight literals hard-coded at the top.
`strum::IntoEnumIterator` or an exhaustive match with `#[deny(non_exhaustive_omitted_patterns)]`
would make the intent load-bearing rather than aspirational. The RFC's covenant
2 asks for a *closed* taxonomy — the test needs the same closure.

### M11 — `isDirectInvocation` swallows realpath failure without explaining
the symlink case

**Where:** `sdk/src/cli.ts:298-307`.

```ts
try {
  return pathToFileURL(realpathSync(entryPath)).href === import.meta.url;
} catch {
  return false;
}
```

`bin.test.ts` covers the symlink cases for `argv[1]`, but not the case where
`import.meta.url` itself points through a symlink (pnpm-style installs). The
comment addresses only the `argv[1]` failure. If the module file is symlinked,
`realpathSync(argv[1])` resolves and `import.meta.url` does not, and the check
returns false — `runCli` never runs. Add a test that installs the SDK through
a symlink and executes the binary (or `realpath` both sides of the comparison
and note it in the comment).

### M12 — `emitReport` splits diagnostics across stdout and stderr without a
documented contract

**Where:** `sdk/src/cli.ts:245-260`.

On failure with `--json`, stdout carries the complete `CheckReport` object.
Without `--json`, stderr carries `REFUSED [...]` and `WARNING [...]` lines and
stdout carries `RESOLVED ...` lines; on pass, stdout gets a final `CHECK
PASSED`. A calling script that greps stdout for a fail marker sees nothing.
The behavior is fine, but it is a public contract of the CLI, and it is not
in `SURFACE.md`, in the `runCli` doc comment, or in a test. If someone
"cleans up" the output format later, they will have no signal that a call
site is relying on it.

## Positive notes — patterns worth keeping

- **Closed diagnostic taxonomy pinned by a reachability test.**
  `preflight.test.ts:177-191` asserts that the set of produced `refusalKinds`
  equals `PREFLIGHT_FAILURE_KINDS`, and the compiler pins the converse. That
  pair covers "refusal kind added but never emitted" and "refusal kind emitted
  but not declared" simultaneously — the whole covenant-2 taxonomy in two
  assertions.
- **`ladderVariant` fixture pattern.** `cli.test.ts:55-62` induces each fault
  on the *canonical ladder flows themselves* in a hermetic temp directory,
  with a control test (`passes relocated ladder flow ... when no fault is
  induced`) that proves the refusals are the fault, not the relocation. This
  is exactly the discipline AGENTS.md's "Evidence is captured, not narrated"
  section is asking for.
- **`kernelDialectMarker`.** Cleanly separates dialect detection from
  authoring-parsing, and the error message tells the operator which specific
  key triggered the routing decision. The kernel-dialect path stays fail-closed
  on unknown fields (`assertKernelKeys`), preserving decision #5.
- **Pure-predicate `preflight()`.** All I/O is behind the `PreflightProbes`
  interface; the module has no `spawnSync`, no `fs`, no `path`. That is the
  design shape AGENTS.md rule 2 asks for ("no I/O in core logic"), and it is
  what makes the test suite deterministic and fast.

## Summary

The preflight surface is small, well-typed, and pinned by tests that
understand covenant 2. The findings above are all local — they are places
where a future change is likelier to break something silently than the rest
of the diff. None of them block merge. M1 (timeout constants), M4 (retry
policy assertion), and M10 (completion-reason exhaustiveness) are the ones I
would prioritize because they each create a mental model that the code no
longer fits — the shape of bug that shows up as a review claim that doesn't
reproduce.

REVIEW_PASSED
