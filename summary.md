# Advisory deterministic outcomes: `onNonZero: record` and the `steps_green` gate

Closes the "no advisory deterministic step" gap. v2 gated every `deterministic`
step on exit code with no opt-out, so every repair-before-failure flow
re-invented `<command> || true` — including this repo's own v1→v2 bridge
(`flows/spec-builder.ts`) and `flows/diagnose/orchestration.spec.ts`'s
`advisoryGate`.

`|| true` discards the exit code. A later gate has nothing to read, so the flow
either re-runs the command or builds an evidence journal outside the kernel.
Worse, it is indistinguishable from success: a flow that forgets one gate ships
red work silently.

## What an author writes now

```ts
const tests = await f.run('npm test', { onNonZero: 'record' });
if (!tests.ok) {
  await f.agent('fixer', { task: `Fix these failures:\n${tests.output}` });
}
```

```yaml
- id: check
  type: deterministic
  command: npm test
  onNonZero: record      # 'fail' (default) | 'record'

- id: green
  type: deterministic
  command: ./ship.sh
  verification: { type: steps_green, ids: [recheck] }
```

`tests.ok`, `tests.exitCode`, `tests.stdout` and `tests.stderr` are all read back
from the step's journaled `{exit_code, stdout_tail, stderr_tail}` envelope.
Nothing is re-run and nothing is re-measured — that is the claim `|| true`
cannot make.

## Acceptance

| Ticket clause | Where it is held |
| --- | --- |
| A deterministic step can be red without failing the run | `verify.rs` `a_recorded_nonzero_exit_passes_its_gate_and_names_the_code`; `relayflowd/tests/advisory_deterministic.rs` |
| Its exit code and output are readable by a later step from the journal | `authored-advisory-run-live.test.ts` "resolves to the journaled exit code instead of ending the flow" (asserts the repair branch received `2 failing tests`) |
| A gate can assert "these recorded steps were all green" without re-running | `steps-green.ts` + `advisory-outcome.test.ts` "steps_green lowering" |
| `|| true` is no longer the documented answer | `docs/SURFACE.md` §2 "Repair before failure: `onNonZero: record`" |

## Design decisions worth reviewing

**Recording is a policy about exit codes, and only about exit codes.** A
timeout, a signal, the executor's `-1` no-exit-status sentinel, a declared
content or schema gate, and a budget all stay fatal under either policy. `-1`
in particular is refused rather than handed back as a plausible code, mirroring
the kernel's own rule — otherwise a killed process would reach an author's
`if (!result.ok)` as a real red verdict.

**Red is allowed, not invisible.** The kernel labels the gate
`exit_code:recorded` and names the code in the verification detail;
`flows check` annotates the step with `[onNonZero: record]`. Reporting it as an
ordinary `exit_code` gate would have moved the `|| true` ambiguity into the
inspection output.

**The default is normalized away at both boundaries.** `onNonZero: fail` is
dropped in `compileStep` and again in `toKernelStep`, and `OnNonZero::is_default`
skips it on the Rust side — so every spec written before this field keeps its
exact canonical bytes and its exact `spec_hash`. A parity test asserts that
directly.

**`steps_green` is compiler-lowered, not a kernel gate.** It becomes a separate
fatal deterministic step bound to the sources' envelopes, so the kernel never
sees the SDK spelling. `testdata/advisory-repair.*` pins the *lowered* output,
which is what proves the kernel parses what the SDK actually emits. The
generated gate never inherits its host's recording policy, or a red gate could
not fail anything.

**Overload order on `f.run`.** The two literal overloads come first so an
omitted or `'fail'` policy keeps the `Step<string>` every existing body is
written against; only the literal `'record'` widens the result. A third
union-returning overload covers a policy held in a variable, where the author
narrows it themselves rather than having one branch guessed for them.
`packages/surface/tests/run-on-non-zero.test-d.ts` pins all of this, including
that a recorded result does *not* assign to `string`.

**A misspelled policy is refused, never defaulted.** Falling back to the fatal
default would delete the branch the author wrote below the call. Refused in
`validateSpec` for declarative specs and before any ordinal is consumed in
`f.run`.

## Bug found and fixed along the way

An authored `.gate()` lowers to its own kernel step (`<id>.gate`) that runs
*after* the producer. `readCompletedStepOutput` read only the producer's
`step.completed` entry, so a failed gate on a successful command resolved the
operation as though it had passed — the child run was terminally `failed` and
the author never heard about it.

This reproduces on the **default** policy too, so it predates this change, but
it is the same invisibility the recording policy exists to remove, one layer up,
and `record` would have widened its reach. `readCompletedStepOutput` now also
checks the run's own terminal reason from the entries it already reads.
`authored-advisory-run-live.test.ts` covers it under both policies and asserts
the failed step is named as `run-1.gate`, not the producer.

## Evidence

- `cd kernel && sh ../ops/cargo.sh test` — all suites pass, 0 failures
  (includes 6 new `verify.rs` tests, 2 new `spec/tests.rs` tests, 2 new
  `relayflowd/tests/advisory_deterministic.rs` integration tests, and the new
  `spec_parity.rs` fixture test).
- `npm --prefix packages/schema test` — 78 pass (the new `advisory-repair`
  fixture is picked up by the existing parity walk).
- `npm --prefix packages/surface test` — 46 pass, 9 files.
- `npm --prefix packages/surface run typecheck:regressions` — clean, including
  the new `run-on-non-zero.test-d.ts`.
- `npm --prefix packages/sdk test` — 2401 pass. 7 files fail, **all confirmed
  failing identically at pristine HEAD** (verified by stashing and rebuilding):
  `live-kernel`, `webhook-live`, `mcp`, `provider-trigger-executor`,
  `communication-mixed-resume` need `kernel/target/{debug,release}/relayflowd`,
  which `ops/cargo.sh` deliberately builds outside the repo;
  `stuck-run-triage` and `authored-node-runtime` hit a vitest module-duplication
  issue for flow files imported from outside the package root.
- Schema regeneration is reproducible: regenerating over the tracked file is
  byte-identical.

Four suites needed updating for this change rather than being broken by it:
`verb-field-lint` (its fail-closed pin demands a sample value for every new
step field), `validate` and `gate-contract` (the `unknown_gate_kind`
enumeration), and `preflight` (its converse test requires every declared
refusal kind to be reachable through the public boundary — the three
`steps_green` kinds now have scenarios).

## Not in scope

Retry policy (`maxIterations`) and agent-step failure semantics, per the ticket.
