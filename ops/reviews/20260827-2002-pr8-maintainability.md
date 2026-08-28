# PR 8 — WP-4 `flows check` preflight (covenant 2)

**Lens:** maintainability — could a stranger read this in six months and change it safely?
**Reviewed at:** `a8c9110` (working tree; PR head `flow/drive-57e923c-08271542`)
**Reviewer:** independent maintainability pass, round seven
**Verdict:** PASS with six findings — one of which I would fix before gate 2 opens

---

## Verification actually performed

This was not a read-only pass. Every claim below that says "verified" was produced by
running or mutating the code, and the working tree was restored after each mutation.

| # | Action | Result |
|---|--------|--------|
| 1 | `npm test` in `sdk/` (`tsc --noEmit && vitest run`) | **121 passed / 7 files / 0 failed** |
| 2 | `cargo test` in `kernel/` with `CARGO_HOME=./.cargo-home` | **72 passed / 0 failed** (18 + 19 + 26 + 3 + 6) |
| 3 | Live run: 3-step flow (2× `llm`, 1× `agent`) sharing one flow-level `cli`, probe fixture logging each invocation | **3 `auth status` subprocesses** — finding M2 |
| 4 | Live run: `cli: git` (installed at `/usr/bin/git`) checked under `env PATH=` | **`REFUSED [cli_missing] … "git" … but it is missing.`** — finding M1 |
| 5 | Mutation: add `temperature?: number` to `LlmStepSpec` + `validate.ts` `STEP_TYPE_KEYS.llm` + `compileStep`, but *not* to `toKernelStep` | **121/121 still green** — finding M3 |
| 6 | Mutation: delete `if (result.error !== undefined) throw new Error('probe failed')` from `probeCli` (`cli.ts:194`) | **121/121 still green** — finding M4 |
| 7 | Grep audit of `emitReport` against the SURFACE.md sentence this PR edited | no identity / scopes / budget / tools is ever printed — finding M5 |
| 8 | Grep audit of SURFACE.md for `executors` / `flows.json` schema | executors appear once, incidentally; the schema is undocumented — finding M6 |

**On the Rust suite.** The previous round reported it unrunnable here
(`failed to create directory .../registry/cache/…: File exists`). That reproduces
against the user-level `~/.cargo`, but the repo carries its own `.cargo-home/`, and
`CARGO_HOME=$PWD/.cargo-home cargo test` runs clean: **72 passed, 0 failed**. So the
Rust half of this PR — `EmptyCli`, `InvalidTrigger`, `DuplicateTrigger`,
`EmptyStepCli`, and the new `preflight_data_is_fail_closed` /
`every_failed_run_terminates_with_declared_completion_reasons` tests — is now
**executed and green**, not merely read. That closes the prior round's stated
limitation. Worth writing this invocation into the repo so the next reviewer does not
rediscover it.

Working tree confirmed clean after every mutation (`git status --porcelain` shows only
this round's review artifacts).

---

## What reads well, and should survive any rewrite

I want to be specific about this rather than generous, because these are the parts a
stranger will actually lean on:

- **The pure/impure seam is real and enforced by shape.** `preflight.ts` takes
  `PreflightProbes` and does no I/O; `cli.ts:178` `systemProbes` is the only place
  `spawnSync` and `accessSync` meet the preflight logic. That is why `preflight.test.ts`
  can inject a throwing probe and get a deterministic `probe_failed` with no fixture
  filesystem. A stranger changing refusal *logic* never has to think about processes.
- **The taxonomy is closed, centralized, and typed.** `failure-kinds.ts` is 43 lines and
  is the single answer to "what can `flows check` say?". `PreflightRefusal.kind` is typed
  to the union, so `tsc --noEmit` holds the converse of the reachability tests. The tests
  say so explicitly (`preflight.test.ts:102-106`) rather than overclaiming.
- **The comments answer *why*, not *what*, at exactly the non-obvious spots.**
  `preflight.ts:183-190` explains that deterministic steps warn rather than refuse
  because a string command goes through `/bin/sh -c` — I checked
  `kernel/relayflowd/src/exec_det.rs:24-25`, and it does, so the comment is load-bearing
  and true. Without it the warn/refuse split reads as timidity.
- **`cli.test.ts:145-148` is a control case that reasons about its own validity** —
  relocated-but-unmutated ladder flows must still pass, so the induced-fault refusals
  cannot be an artifact of the temp directory. Rare and right.
- **`temporaryProject()` writes a boundary `flows.json` into every temp dir**, so a stray
  `/tmp/flows.json` cannot make the suite pass or fail for the wrong reason. Someone
  thought about the discovery walk's blast radius.
- **`testdata/flows.json` moves the ladder's CLI out of the hashed spec.** The canonical
  JSON and `spec_hash` name no environment-specific binary. That is the right call and
  the fixture comments say why.

---

## Findings

### M1 — `probe_failed` is unreachable when the probe machinery itself is what broke; the operator is told their CLI is missing *(verified)*

`resolveExecutable` (`cli.ts:197-209`) resolves a bare CLI name by shelling out to
`which`. If that spawn cannot happen — `which` absent, `PATH` empty or sanitized, a
locked-down CI image — `result.status` is `null`, the function returns `undefined`, and
`probeCli` returns `{ exists: false }`. Preflight then emits:

```
REFUSED [cli_missing] Step "a" declares CLI "git", but it is missing.
```

I produced exactly that line with `git` installed at `/usr/bin/git`, under `env PATH=`.

This is the failure mode the closed taxonomy exists to prevent. `probe_failed` is
declared for precisely this state — "could not verify" — and it is unreachable from the
resolution half of the probe: only the `spawnSync(executable, ['auth','status'])` call
can produce it. An operator reading `cli_missing` goes and installs a CLI that is
already installed; the actual defect is in the checker's environment. SURFACE.md:80
promises "a probe that cannot be executed at all is `probe_failed`" — for bare-name
resolution, that promise does not hold.

The prior round's nit about `resolveExecutable` not passing `cwd` brushed this area but
framed it as cosmetic symmetry. It is not cosmetic: the two spawn sites have different
error contracts and only one of them is honest.

**Remedy:** distinguish "resolution said no" from "resolution could not run". Have
`resolveExecutable` throw when `spawnSync('which', …)` sets `.error`, letting
`probeResolvedCli`'s existing catch emit `probe_failed`; or drop `which` for a direct
`PATH` walk with `accessSync(…, X_OK)`, which removes the subprocess, the 5s timeout,
and the platform dependency in one move. The second is smaller and strictly more
portable — `which` is not a Windows builtin, and `flows check` is the first thing a
design partner runs.

### M2 — the auth probe runs once per step, not once per CLI *(verified)*

`preflight()` (`preflight.ts:68-84`) calls `probeResolvedCli` inside the per-step loop.
Nothing memoizes by resolved CLI. A 3-step flow sharing one flow-level `cli` spawned
three `auth status` subprocesses in my run; a 20-step flow spawns twenty, each with a
10-second timeout (`cli.ts:192`).

Real CLIs do network work in `auth status` (token refresh, `/me`). Twenty serial
round-trips turn a submit-time check into something slow enough to skip, and a
rate-limited auth endpoint makes `flows check` intermittently emit
`cli_unauthenticated` — a *refusal* — for a healthy CLI. A gate that is flaky under
load is a gate people learn to bypass, which costs covenant 2 more than the bug costs.

SURFACE.md:80 reinforces the wrong mental model: "runs exactly that probe … never
invokes any other subcommand" reads as *once*. It never says *per step*.

**Remedy:** memoize `CliProbeResult` by `(cli, source)` for the duration of one
`preflight()` call. It is a `Map` and about four lines, it lives entirely in the pure
module, and it makes the docs' singular phrasing true. Also worth naming the `10_000` /
`5_000` timeouts as constants — they are the operator-visible latency budget and
currently appear only as bare literals.

### M3 — an authoring field can be added, validated, compiled, and silently dropped at the kernel boundary with the suite fully green *(verified by mutation)*

`toKernelSpec`'s own doc comment (`compile.ts:142-145`) states the contract: "Authoring
sugar that the dialect cannot carry is a `CompileError`, never a silent drop." Nothing
enforces it.

I added `temperature?: number` to `LlmStepSpec`, listed it in `validate.ts`
`STEP_TYPE_KEYS.llm`, and copied it through `compileStep` — but not through
`toKernelStep`. Result: **121/121 green**. `validateSpec` accepts the field,
`compileSpec` preserves it, and `toKernelSpec` drops it — so it never reaches the
kernel, and, because `compileYamlToCanonicalJson`/`compileAndHash` both hash
`toKernelSpec(...)`, two flows differing only in `temperature` produce the **same
`spec_hash`**. Under memoization that is two different flows sharing one identity.

The spec-parity round-trip (`kernelToAuthoring(toKernelSpec(flow))` deep-equals `flow`)
is the right idea, but it only proves fidelity for keys the three canonical fixtures
happen to contain. Coverage is fixture-shaped, so it silently decays every time the
authoring surface grows — and this PR just grew it (`cli`, `triggers`).

This is adjacent to the prior round's N1 (`permissions.network_allowlist` missing from
`kernelPermissionsToAuthoring`'s accept list) but is the *other* direction and the more
dangerous one: N1's failure mode is a spurious refusal, which is loud. M3's is a silent
drop that changes the hashed artifact, which is exactly what the comment promises cannot
happen.

For scale: adding one step field today means editing `spec.ts` (authoring + kernel
interfaces), `validate.ts` `STEP_TYPE_KEYS`, `compile.ts` `compileStep`,
`compile.ts` `toKernelStep`, `compile.ts` `kernelStepToAuthoring`'s `unionKeys` **and**
`typeKeys`, and `spec.rs` `STEP_*_FIELDS`. Seven lists. This PR did all seven correctly
for `cli`; the next contributor gets no help from the compiler on five of them.

**Remedy:** a key-coverage test that walks the exported authoring key lists and asserts
every key survives `toKernelSpec` → `kernelToAuthoring`. The lists are already exported
constants in `validate.ts`, so the test is data-driven and does not need new fixtures. It
converts "the reviewer noticed" into "the suite notices".

### M4 — the production `probe_failed` path is untested end-to-end *(verified by mutation)*

Deleting `if (result.error !== undefined) throw new Error('probe failed');` from
`probeCli` (`cli.ts:194`) leaves the suite at **121/121**. With that line gone, a spawn
error yields `status === null`, so the report becomes `cli_unauthenticated` — a
different, wrong, operator-facing refusal — and nothing notices.

The same holds for `command_unresolved` and `command_unprovable`: both are exercised only
through injected probes in `preflight.test.ts`, never through `systemProbes`. The unit
tests prove the *predicates* map probe outcomes to kinds; nothing proves `systemProbes`
produces the right probe outcomes. That is the seam where M1 lives, and it is exactly the
untested half.

**Remedy:** make the probe factory injectable into `runCli` (a defaulted parameter
alongside `io`, which is already injectable). That gives the CLI-level tests a seam for
`probe_failed` and `command_unresolved`, and it is the same seam the prior round wanted
for exercising an `internal_error` kind — one change unblocks both.

### M5 — SURFACE.md asserts `flows check` prints things it does not print *(verified)*

SURFACE.md:78, edited by this PR, now reads:

> The elaborated definition — cli, identity (derived from the flow: `<flow>/agent`),
> workspace scopes, budget, tools — **is printed and validated by `flows check`** before
> submission: you are told exactly who you hired…

`emitReport` (`cli.ts:227-241`) prints diagnostics, `RESOLVED step … cli … from
<source>`, and `CHECK PASSED`. There is no identity, no `<flow>/agent` derivation, no
workspace scopes, no budget, no tools — the strings do not exist in `cli.ts`. The `cli`
noun is the only one of five that is real.

The pre-PR sentence had the same overclaim, but this PR rewrote the clause (from "is
printed by `flows check` and validated at preflight" to "is printed and validated by
`flows check` before submission") and tightened the surrounding paragraph with genuinely
scrupulous caveats — the platform-default rung, the `run.start` bypass. Tightening
everything around a false clause while leaving the clause makes it *more* credible, not
less. This is the specific failure the lens asks about: a document asserting what the
code does not do, in a file whose whole job is to be the contract.

**Remedy:** one sentence. Either scope it to what ships — "`flows check` prints the
resolved CLI and its source" — or mark the rest as gate-8 work the way the
platform-default rung is already marked in the very same paragraph. The paragraph
already demonstrates the right move; apply it twice.

### M6 — the trigger half of covenant 2 is a string-membership test against a file the flow author writes, and it is documented nowhere *(verified)*

`systemProbes`' executor probe is `config.executors.includes(trigger.executor)`
(`cli.ts:181`). "A worker exists to execute this trigger" is proven by the executor's
name appearing in an array in the same `flows.json` the author edits. Nothing contacts a
registry, a broker, or RelayCron.

That is a defensible gate-1 scope decision. What is not defensible is that it is
invisible. This PR added two substantial SURFACE.md paragraphs for the CLI half —
the `auth status` contract, the discovery walk — and **zero** for the trigger half.
`executors` appears in SURFACE.md exactly once, incidentally, inside the
project-config paragraph. The `flows.json` schema (`cli`, `executors`, nothing else,
fail-closed on unknown keys) is not written down anywhere. The `no_executor` refusal kind
is not documented.

A stranger reads `REFUSED [no_executor] Trigger "hourly" has no registered executor
"worker-a"`, reads the RFC's promise of a liveness-checked trigger plane, and reasonably
concludes preflight consulted something authoritative. They will build on that belief.
Gate 2 is where that belief becomes a defect, and gate 2 is next.

**Remedy:** a short SURFACE.md paragraph, parallel to the two this PR added: the
`flows.json` schema, what "registered executor" means today (a declared name, checked for
presence, not liveness), and that gate 2 replaces the array with a real registration
plane. Naming the limitation costs three sentences and prevents the whole class of
wrong assumption.

---

## Nits

- **`RESOLVED` prints for a CLI that was just refused.** Checking `cli: git` emits
  `REFUSED [cli_missing] …` on stderr and `RESOLVED step "a" cli "git" from flow` on
  stdout. Both are accurate — resolution succeeded, probing failed — but interleaved in a
  terminal the second line reads as a retraction of the first. Suppressing resolution
  lines for steps that carry a refusal, or labelling them `RESOLVED (refused)`, removes
  the double-take.
- **`config_invalid` is the one error that does not name its offender.** `cli.ts:146`
  says `expects only cli and executors` without naming the bad key, while every compile
  error in this codebase says `spec.steps[0]: unknown key "mystery"`. Covenant 1 asks for
  the author's mistake in the author's vocabulary; the rest of the PR delivers that
  consistently enough that this one sticks out.
- **`PreflightOptions` has an unstated invariant.** `projectCli`, `projectConfigPath`,
  and `projectSearchStart` are three independent optionals, and `unresolvedCliMessage`
  branches on which are present. `projectCli` is trusted to have come from
  `projectConfigPath`; nothing says so and nothing checks it. One doc comment on the
  interface — "pass all three together, or none" — costs a line and saves a reader from
  reverse-engineering `cli.ts` to find out.
- **`systemProbes` will silently mis-resolve a fourth `CliResolutionSource`.**
  `source === 'project' ? config.directory : flowDirectory` is a ternary, not an
  exhaustive switch, so adding the platform-default rung that SURFACE.md:78 explicitly
  promises is coming resolves its paths against the flow directory with no compiler
  complaint. `resolveCli`'s if-chain and `unresolvedCliMessage` have the same shape.
  Three edit sites, zero compiler help, for a change the docs say is planned. A
  `switch` with a `never` default in `systemProbes` makes the compiler carry it.
- **Two contract changes ride along unannounced.** `FlowSpec.name` went from required to
  optional and `SEMVER_RE` was replaced by exact equality with `SPEC_SCHEMA_VERSION`.
  Both are right — they align the SDK with `RunSpec`'s `Option<String>` and
  `UnsupportedVersion` — and both are tested. Neither is mentioned in SURFACE.md or in
  a comment, so a stranger asking "when did `name` stop being required, and why?" gets
  no answer short of `git log -S`. One line in each test would have carried it; the
  nameless-spec test nearly does.

---

## Verdict

The suites are green and I ran both: **SDK 121/121** (including `tsc --noEmit`) and
**kernel 72/72** via `CARGO_HOME=$PWD/.cargo-home`, which resolves the previous round's
"could not run cargo" caveat rather than inheriting it.

Against the lens question — *could a stranger read this in six months and change it
safely?* — mostly yes, and for structural reasons that will keep paying: the pure/impure
seam is enforced by shape, the taxonomy is closed and typed, the tests reason about their
own validity, and the comments explain the decisions a reader would otherwise second-guess.
This is markedly better than the code it replaces.

The six findings split cleanly. **M5 and M6 are documentation debt on a document that
*is* the contract** — a stranger will trust SURFACE.md over the source, and on the printed
elaboration and the executor check, SURFACE.md is wrong and silent respectively. **M1, M2,
and M4 are the untested impure half**: `systemProbes` is the one place this PR's
otherwise-excellent seam discipline stops, and all three findings live there, which is
not a coincidence — an unseamed module is an untested module.

**M3 is the one I would fix before gate 2 opens.** Not because it is broken today — it
is not; this PR threaded all seven key lists correctly — but because it is the finding
whose cost grows with every future field, its failure mode is a silent divergence in the
hashed artifact that the code's own comment declares impossible, and gate 2 will add
trigger matchers to exactly these lists. The key-coverage test is small, data-driven over
constants that are already exported, and it converts an invariant currently held by
reviewer attention into one held by the suite. That is the difference between a stranger
changing this safely and a stranger changing this luckily.

None of the six makes a change unsafe today. Passing.

**REVIEW_PASSED**
