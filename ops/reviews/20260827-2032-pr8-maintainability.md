# PR 8 — WP-4 `flows check` preflight (covenant 2)

**Lens:** maintainability — could a stranger read this in six months and change it safely?
**Reviewed at:** `71ed9fd` (branch `flow/drive-57e923c-08271542`; last code-bearing commit `4f8ecf8` — `f0abdd4` added four doc lines, everything since is ops artifacts)
**Reviewer:** independent maintainability pass, round eight
**Verdict:** **REVIEW_FAILED** — one new, verified defect in the artifact this PR ships; six carried findings still open

---

## Verification actually performed

Every claim marked *(verified)* below was produced by running, installing, or mutating
the code on this tree. The working tree was restored after each mutation and
`git status --porcelain` is clean.

| # | Action | Result |
|---|--------|--------|
| 1 | `npm test` in `sdk/` (`tsc --noEmit && vitest run`) | **121 passed / 7 files / 0 failed** |
| 2 | `CARGO_HOME=$PWD/.cargo-home cargo test` in `kernel/` | **72 passed / 0 failed** (18 + 19 + 26 + 3 + 6) |
| 3 | `npm run build`, then real `npm install <sdk>` into a scratch project, then `./node_modules/.bin/flows check testdata/preflight/cli-missing.flow.yaml` | **no output, exit 0** — must be `REFUSED [cli_missing]`, exit 2. Finding **B1** |
| 4 | Printed both sides of the main-module guard for the installed symlink | argv[1] → `file:///tmp/.../node_modules/.bin/flows`; `import.meta.url` → `file:///…/sdk/dist/cli.js`. Root cause of B1 confirmed |
| 5 | Fixture CLI that `kill -SEGV $$` on `auth status` | `REFUSED [cli_unauthenticated] … "exited non-zero; authenticate it"`. Node reports `{status: null, signal: 'SIGSEGV', error: undefined}` — finding **B2** |
| 6 | `spawnSync` under `timeout` | `{status: null, signal: 'SIGTERM', error: ETIMEDOUT}` — so timeouts *do* reach `probe_failed`; only signal death does not. B2 is precisely scoped |
| 7 | `cli: git` (installed at `/usr/bin/git`) checked under `env PATH=` | `REFUSED [cli_missing] … "git" … but it is missing.` — carried finding **B3** still open |
| 8 | 3-step flow (2× `llm`, 1× `agent`) sharing one flow-level `cli`, probe fixture logging each invocation | **3 `auth status` subprocesses** — carried finding **B4** still open |
| 9 | Mutation: cap `findConfig`'s parent walk at 2 directories | **121/121 still green** — finding **B7** |
| 10 | `toKernelSpec` on two authoring specs differing only by an unenumerated step key | **byte-identical kernel spec** → identical `spec_hash` — mechanism behind carried finding **B8** |
| 11 | Grep audit of `emitReport` vs. `docs/SURFACE.md:78`, and of SURFACE.md for the `flows.json` schema | no identity / scopes / budget / tools is printed; `executors` still appears once, incidentally — carried findings **B5**, **B6** |
| 12 | Grep for any test or script that spawns the built binary or touches `dist/` | **none** — the shipped entrypoint has zero coverage |

---

## What reads well, and should survive any rewrite

Not generosity — these are the parts a stranger will actually lean on, and I checked each:

- **The pure/impure seam is real and enforced by shape.** `preflight.ts` takes
  `PreflightProbes` and performs no I/O; `cli.ts:178` `systemProbes` is the only place
  `spawnSync`/`accessSync` meet preflight logic. That is why `preflight.test.ts` can
  inject a throwing probe and get a deterministic `probe_failed` with no fixture
  filesystem. Someone changing refusal *logic* never has to think about processes.
- **The taxonomy is closed, centralized, and typed.** `failure-kinds.ts` is 43 lines and
  is the single answer to "what can `flows check` say?". `PreflightRefusal.kind` is typed
  to the union, so `tsc --noEmit` holds the converse of the reachability tests — and the
  tests say so explicitly (`preflight.test.ts:102-106`) instead of overclaiming.
- **Comments answer *why* at exactly the non-obvious spots.** `preflight.ts:183-190`
  explains that deterministic steps warn rather than refuse because a string command goes
  through `/bin/sh -c`; I checked `kernel/relayflowd/src/exec_det.rs` and it does. The
  comment is load-bearing and true. Without it the warn/refuse split reads as timidity.
- **`cli.test.ts:145-148` is a control case that reasons about its own validity** —
  relocated-but-unmutated ladder flows must still pass, so the induced-fault refusals
  cannot be an artifact of the temp directory. Rare and right.
- **`temporaryProject()` writes a boundary `flows.json` into every temp dir**, so a stray
  `/tmp/flows.json` cannot make the suite green for the wrong reason.
- **`testdata/flows.json` moves the ladder's CLI out of the hashed spec**, and the fixture
  comments say why. The canonical JSON and `spec_hash` name no environment-specific binary.

None of this is undone by the verdict below. The failure is at the one seam where this
discipline stops.

---

## Findings

### B1 — the `bin` this PR ships is inert when installed: `flows check` exits 0, silently, on a flow it must refuse *(new; verified with a real `npm install`)*

This PR adds `"bin": {"flows": "./dist/cli.js"}` to `sdk/package.json` and the
main-module guard at `sdk/src/cli.ts:280-282`:

```ts
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = runCli(process.argv.slice(2));
}
```

`npm` installs a bin as a **symlink** in `node_modules/.bin`. Node sets `process.argv[1]`
to the path as invoked (the symlink), while the ESM loader resolves `import.meta.url`
through `realpath`. They never match, the guard is false, and the process falls off the
end of the module having done nothing.

Reproduced end to end, not theorised:

```
$ npm install /…/flows/sdk         # real install into a scratch project
$ ls -l node_modules/.bin/
flows -> ../@relayflows/sdk/dist/cli.js
$ ./node_modules/.bin/flows check /…/testdata/preflight/cli-missing.flow.yaml
$ echo $?
0
```

No stdout, no stderr, exit 0 — for the fixture whose entire purpose is to produce
`REFUSED [cli_missing]` and exit 2. Confirmed the cause directly:

```
argv1 as given -> file:///tmp/flows-bin-probe/node_modules/.bin/flows
realpath        -> file:///…/flows/sdk/dist/cli.js
```

`node dist/cli.js check …` works correctly; only the installed path is dead. So the
defect is invisible to anyone testing the way this repo tests.

Why this is the finding that fails the review rather than a nit:

1. **It is the exact failure mode covenant 2 exists to abolish.** RFC §1: "a raw stack
   trace, a silent wrong-workspace run, or a *'succeeded' that did nothing* is by
   definition a kernel bug," and the cited dogfood evidence is "a cron trigger reported
   `succeeded` into a void." A preflight gate that exits 0 having checked nothing is that
   defect, in the tool built to prevent it. Every refusal kind in `failure-kinds.ts` is
   unreachable for an installed consumer.
2. **`ops/DRIVE-LOG.md:446` states "The SDK now ships the `flows check` binary."** It
   ships a binary that does nothing. That is a document asserting what the code does not
   do — the specific thing this lens is asked to catch.
3. **Nothing in the suite could ever have caught it.** All 42 `cli.test.ts` cases call
   `runCli(...)` in-process; grep finds no test, script, or workflow that spawns the built
   binary or references `dist/`. The 121 green tests are green about `runCli`, and `runCli`
   is fine. The untested thing is the two-line adapter between `runCli` and the world —
   and it is the only part a design partner touches.
4. **A stranger in six months has no thread to pull.** The symptom is silence and success.
   There is no error to grep, no failing test, no log line. They will conclude preflight
   passed their flow.

**Remedy (verified correct by the probe in row 4):** compare realpaths, e.g.
`realpathSync(process.argv[1])` before `pathToFileURL`, guarded for the `argv[1]`-absent
case. Then add one test that actually spawns the built artifact — `npm run build` and
`execFileSync(process.execPath, [dist/cli.js, …])` through a symlink — asserting exit 2
and `REFUSED` on `cli-missing.flow.yaml`. Two lines of fix; one test that pins the seam
between the module and the shell forever.

### B2 — a CLI that dies on a signal is reported as `cli_unauthenticated`, and the operator is told to authenticate a crashing binary *(new; verified)*

`probeCli` (`cli.ts:186-196`) treats `result.error !== undefined` as `probe_failed` and
everything else as `authenticated: result.status === 0`. A child killed by a signal sets
neither: Node returns `{status: null, signal: 'SIGSEGV', error: undefined}`. With a fixture
CLI that segfaults on `auth status`:

```
REFUSED [cli_unauthenticated] Step "a" declares CLI "./crashing-cli", but
"./crashing-cli auth status" exited non-zero; authenticate it or implement that probe
to return exit 0 when authenticated.
```

It did not exit non-zero. It did not exit. The message names a remedy — authenticate, or
implement the probe — that cannot fix a crash, and `probe_failed`, which exists for
exactly "could not verify," is bypassed. I checked the adjacent case to scope this
precisely: a **timeout** does set `.error` (`ETIMEDOUT`), so timeouts are classified
honestly. Signal death is the one hole.

This matters more than a message wording bug because `cli_unauthenticated` is a *refusal*
whose stated cause is false. Under covenant 2 the taxonomy's value is that each kind means
one thing; a kind that also means "the binary crashed" is a kind the operator learns to
distrust.

**Remedy:** `if (result.error !== undefined || result.signal !== null) throw …` — one
clause, in the same line that already exists. Worth a doc line in SURFACE.md's
Preflightable-CLI contract too: "a probe that cannot be executed *or does not exit
normally* is `probe_failed`."

### B3 — `probe_failed` is unreachable from the resolution half of the probe; a broken checker environment reports the operator's CLI as missing *(carried from round seven M1; re-verified, still open)*

`resolveExecutable` (`cli.ts:198-210`) resolves a bare CLI name by spawning `which`. If
that spawn cannot happen — `which` absent, `PATH` empty or sanitised, a locked-down CI
image — `result.status` is `null`, the function returns `undefined`, and `probeCli`
reports `{exists: false}`. I reproduced it with `git` installed at `/usr/bin/git`:

```
$ env PATH= node dist/cli.js check /tmp/m1probe/m1.flow.yaml
REFUSED [cli_missing] Step "a" declares CLI "git", but it is missing.
```

`docs/SURFACE.md:80` promises "a probe that cannot be executed at all is `probe_failed`."
For bare-name resolution that promise does not hold, and the operator is sent to install
something already installed. B2 and B3 are the same class from opposite ends: the two
spawn sites in `probeCli`/`resolveExecutable` have different error contracts and only one
of them is honest.

**Remedy:** have `resolveExecutable` throw when `spawnSync('which', …)` sets `.error`, so
`probeResolvedCli`'s existing catch emits `probe_failed`; or drop `which` for a direct
`PATH` walk with `accessSync(…, X_OK)`, which deletes a subprocess, a 5s timeout, and a
platform dependency at once (`which` is not a Windows builtin, and `flows check` is the
first thing a design partner runs).

### B4 — the auth probe runs once per step, not once per CLI *(carried from round seven M2; re-verified, still open)*

`preflight()` (`preflight.ts:68-84`) probes inside the per-step loop with no memoisation.
A 3-step flow sharing one flow-level `cli` produced **three** `auth status` invocations in
my run; a 20-step flow produces twenty, each with a 10-second ceiling (`cli.ts:192`).

Real CLIs do network work in `auth status`. Twenty serial round-trips make a submit-time
check slow enough to skip, and a rate-limited auth endpoint makes `flows check`
intermittently emit `cli_unauthenticated` — a *refusal* — for a healthy CLI. A gate that
is flaky under load is a gate people learn to bypass, which costs covenant 2 more than the
bug does. `SURFACE.md:80`'s "runs exactly that probe … never invokes any other subcommand"
reads as *once*; it never says *per step*.

**Remedy:** memoise `CliProbeResult` by `(cli, source)` for the duration of one
`preflight()` call — a `Map`, about four lines, entirely inside the pure module, and it
makes the doc's singular phrasing true. While there: name `10_000` and `5_000` as
constants; they are the operator-visible latency budget and currently appear only as bare
literals.

### B5 — `docs/SURFACE.md:78` asserts `flows check` prints five things, four of which do not exist *(carried from round seven M5; re-verified, still open at `71ed9fd`)*

> The elaborated definition — cli, identity (derived from the flow: `<flow>/agent`),
> workspace scopes, budget, tools — **is printed and validated by `flows check`** before
> submission: you are told exactly who you hired…

`emitReport` (`cli.ts:227-242`) prints diagnostics, `RESOLVED step … cli … from <source>`,
and `CHECK PASSED`. No identity, no `<flow>/agent` derivation, no workspace scopes, no
budget, no tools — those strings do not exist in `cli.ts`. `cli` is one noun out of five.

The pre-PR sentence had the same overclaim, but this PR rewrote the clause and tightened
everything around it with genuinely scrupulous caveats (the unimplemented platform-default
rung, the `run.start` bypass). Tightening the neighbourhood of a false clause makes the
clause *more* credible, not less. `f0abdd4` touched this file again and did not fix it.

**Remedy:** one sentence. Scope it to what ships — "`flows check` prints the resolved CLI
and its source" — or mark the rest as gate-8 work exactly the way the platform-default rung
is already marked two clauses earlier. The paragraph already demonstrates the right move.

### B6 — the trigger half of covenant 2 is a string-membership test against a file the flow author writes, and it is documented nowhere *(carried from round seven M6; still open)*

`systemProbes`' executor probe is `config.executors.includes(trigger.executor)`
(`cli.ts:181`). "A worker exists to execute every trigger" — the RFC's covenant-2 wording —
is proven by the executor's name appearing in an array in the same `flows.json` the author
edits. Nothing contacts a registry, a broker, or RelayCron.

That is a defensible gate-1 scope decision. What is not defensible is that it is invisible.
This PR added two substantial SURFACE.md paragraphs for the CLI half and **zero** for the
trigger half; `executors` appears in SURFACE.md exactly once, incidentally, inside the
project-config paragraph. The `flows.json` schema (`cli`, `executors`, nothing else,
fail-closed on unknown keys) is written down nowhere. `no_executor` is undocumented.

A stranger reads `REFUSED [no_executor] Trigger "hourly" has no registered executor
"worker-a"`, reads the RFC's promise of a liveness-checked trigger plane, and reasonably
concludes preflight consulted something authoritative. Gate 2 is where that belief becomes
a defect, and gate 2 is next.

**Remedy:** a short paragraph parallel to the two this PR added — the `flows.json` schema,
what "registered executor" means today (a declared name, checked for presence, not
liveness), and that gate 2 replaces the array with a real registration plane.

### B7 — the documented root-ward config walk is pinned only one hop deep *(new; verified by mutation)*

`SURFACE.md:82` promises `flows check` "walks parent directories through the filesystem
root." I capped `findConfig`'s walk at two directories and the suite stayed at
**121/121**. Every fixture that exercises discovery is either same-directory
(`testdata/`, `preflight/project-default/`) or exactly one level up (the two temp-dir
cases). The traversal that the doc describes, and the shadowing semantics that depend on
it, are held by no test beyond a single hop.

This is low-severity today and cheap to close, but it is the same shape as B1: a
documented behaviour whose test would not fail if the behaviour broke.

**Remedy:** one fixture with the flow three or four directories below its `flows.json`.
`temporaryProject()` already gives the hermetic boundary that makes it safe.

### B8 — an authoring field can be validated, compiled, and silently dropped at the kernel boundary, changing nothing about the hash *(carried from round seven M3; mechanism re-verified)*

`toKernelSpec`'s own doc comment (`compile.ts:142-145`) states the contract: "Authoring
sugar that the dialect cannot carry is a `CompileError`, never a silent drop." Nothing
enforces it. `toKernelStep` builds an explicit object literal, so any authoring key it does
not enumerate vanishes. Two authoring specs differing only by an unenumerated step key
produce a **byte-identical** kernel spec:

```
kernel spec identical: true
```

and since `compileYamlToCanonicalJson`/`compileAndHash` both hash `toKernelSpec(...)`, they
also produce an identical `spec_hash` — two different flows sharing one memoisation
identity. Today this is latent, because `validate.ts`'s fail-closed key lists make the
extra key unreachable through `compileSpec`; round seven demonstrated it becomes live the
moment someone adds a field to `STEP_TYPE_KEYS` + `compileStep` without `toKernelStep`
(suite stayed green through that mutation).

The spec-parity round-trip is the right instinct, but it proves fidelity only for keys the
three canonical fixtures happen to contain, so coverage is fixture-shaped and decays every
time the authoring surface grows — and this PR just grew it (`cli`, `triggers`). Adding one
step field today means editing seven lists across `spec.ts`, `validate.ts`, `compile.ts`
(×3) and `spec.rs`. This PR threaded all seven correctly; the next contributor gets
compiler help on two of them.

**Remedy:** a key-coverage test that walks the exported authoring key lists and asserts
every key survives `toKernelSpec` → `kernelToAuthoring`. The lists are already exported
constants, so it is data-driven and needs no new fixtures. It converts "the reviewer
noticed" into "the suite notices".

---

## Nits

- **`flows check` executes a binary named by the spec, and no module comment says so.**
  `probeCli` spawns the resolved executable with the declaring file's directory as `cwd`;
  a flow carrying `cli: ./anything` gets that program run at check time. SURFACE.md
  discloses the probe, but the word "check" implies inspection, and given the RFC's own
  review-swarm design (agents run `flows check` on PR-supplied flows) the boundary deserves
  one explicit line in `cli.ts` and in the Preflightable-CLI contract.
- **`RESOLVED` prints for a CLI that was just refused.** My B3 repro shows both lines:
  `REFUSED [cli_missing] … "git" … is missing` on stderr, `RESOLVED step "a" cli "git" from
  flow` on stdout. Both are accurate — resolution succeeded, probing failed — but
  interleaved in a terminal the second reads as a retraction of the first.
- **`config_invalid` is the one error that does not name its offender.** `cli.ts:146` says
  `expects only cli and executors` without naming the bad key, while every compile error
  here says `spec.steps[0]: unknown key "mystery"`. The rest of the PR is consistent enough
  that this sticks out.
- **`PreflightOptions` has an unstated invariant.** `projectCli`, `projectConfigPath`, and
  `projectSearchStart` are three independent optionals and `unresolvedCliMessage` branches
  on which are present; `projectCli` is trusted to have come from `projectConfigPath`, and
  nothing says so. One doc comment — "pass all three together, or none" — saves a reader
  from reverse-engineering `cli.ts`.
- **`systemProbes` will silently mis-resolve a fourth `CliResolutionSource`.**
  `source === 'project' ? config.directory : flowDirectory` is a ternary, not an exhaustive
  switch, so adding the platform-default rung that SURFACE.md:78 says is coming resolves its
  paths against the flow directory with no compiler complaint. `resolveCli`'s if-chain and
  `unresolvedCliMessage` share the shape. Three edit sites, zero compiler help, for a
  planned change. A `switch` with a `never` default makes the compiler carry it.
- **`isCheckFailureKind` is exported from `index.ts` but called only by tests.** Defensible
  as the runtime witness of the closed taxonomy for `--json` consumers; worth a doc comment
  saying that, or it reads as speculative surface under AGENTS.md rule 6.
- **Two contract changes ride along unannounced.** `FlowSpec.name` went required →
  optional, and `SEMVER_RE` was replaced by exact equality with `SPEC_SCHEMA_VERSION`. Both
  are right (they align the SDK with `RunSpec`'s `Option<String>` and `UnsupportedVersion`)
  and both are tested, but neither is mentioned in SURFACE.md or in a comment, so "when did
  `name` stop being required, and why?" has no answer short of `git log -S`.

---

## Verdict

Both suites are green and I ran both: **SDK 121/121** including `tsc --noEmit`, and
**kernel 72/72** via `CARGO_HOME=$PWD/.cargo-home`.

Against the lens question — *could a stranger read this in six months and change it
safely?* — the source itself: largely yes, and for structural reasons that will keep
paying. The pure/impure seam is enforced by shape, the taxonomy is closed and typed, the
tests reason about their own validity, and the comments explain the decisions a reader
would otherwise second-guess.

But the artifact is not the source. **B1 is not a maintainability wart; it is the shipped
entrypoint of a covenant-2 gate returning exit 0 having checked nothing** — verified
through a real `npm install`, on the fixture whose only job is to refuse. It is a
maintainability finding in the strict sense the lens asks for: the behaviour is asserted by
`ops/DRIVE-LOG.md:446`, contradicted by the code, and pinned by no test, because no test or
script in this repo ever spawns the thing `package.json` tells the world to run. The 121
green tests are green about `runCli`; the two lines between `runCli` and a shell are the
only untested part, and they are the only part a design partner meets. Its symptom is
silence, which is the one symptom a stranger cannot pull a thread from.

B2 and B3 compound it: all three live in `systemProbes`/`probeCli`, the single place this
PR's otherwise-excellent seam discipline stops. That is not coincidence — an unseamed
module is an untested module, and here it is also the module the operator experiences.

Failing on B1 alone. It is a two-line fix plus one test that spawns the built binary; the
same test seam closes B2 and B3 and is worth building once. B5 and B6 are documentation
debt on a document that *is* the contract and should land in the same pass. B8 remains the
finding whose cost grows with every future field, and gate 2 will add trigger matchers to
exactly those lists.

**REVIEW_FAILED**
