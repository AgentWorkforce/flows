# PR #8 — maintainability review

- **PR:** [#8 — WP-4 — flows check preflight (covenant 2)](https://github.com/AgentWorkforce/flows/pull/8)
- **Branch / head:** `flow/drive-57e923c-08271542` @ `930f376`
- **Lens:** maintainability — *could a stranger read this in six months and change it safely?*
- **Reviewer:** claude (review-swarm `maintainability` lens, `workflows/review-swarm.yaml`)
- **Date:** 2026-08-27 18:10
- **Read first:** `AGENTS.md`, `docs/RFC-0001-everything-is-a-relayflow.md` (§1 thesis, the
  three covenants, §98 gate-1 done-when, §213 closed-vocabulary rule)

---

## 1. What I read and what I ran

Diff: `/tmp/pr-8.diff` (43 files, +3803 / −234). Metadata: `/tmp/pr-8.json`.

Substantive source under review:

| File | Δ | Read |
|---|---|---|
| `sdk/src/preflight.ts` | new, 221 | in full |
| `sdk/src/cli.ts` | new, 241 | in full |
| `sdk/src/failure-kinds.ts` | new, 43 | in full |
| `sdk/src/compile.ts` | +153 (389 total) | diff + `toKernelStep` |
| `sdk/src/validate.ts` | +59 (454 total) | diff |
| `sdk/src/spec.ts` | +24 (268 total) | diff |
| `kernel/relayflowd-core/src/spec.rs` | +57 | diff + `StepSpec` derives |
| `sdk/tests/{preflight,cli,validate,spec-parity}.test.ts` | +399 | in full |
| `docs/SURFACE.md` | +4 | the two added paragraphs, in context |
| `testdata/preflight/**` | new fixtures | all |

Executed, not inferred:

```
$ cd sdk && npm test
> tsc --noEmit && vitest run
 Test Files  7 passed (7)
      Tests  105 passed (105)
   Duration  624ms
```

Green, including the typecheck. Everything below was reproduced against this
tree with throwaway fixtures; the scratch test files were deleted and
`git status --porcelain` shows only the untracked `.review-target`.

I also read the four review transcripts this PR carries
(`ops/reviews/20260827-{1611,1627,1714,1726}-*.md`) so I would report new
ground rather than re-litigate N1–N6. Findings **M1** and **M2** below are not
in any of them; **M3** and **M4** are adjacent to N4/N5 but name a different
mechanism, and I mark the overlap explicitly.

---

## 2. What is genuinely good here

I want this on the record, because it is most of the diff and it is the part a
stranger will thank someone for.

- **The failure taxonomy is a closed set in one file, and the tests prove both
  directions.** `failure-kinds.ts` is 43 lines of `as const` arrays; every
  refusal and warning kind flows from it into a TypeScript union. The
  reachability direction is asserted at runtime
  (`preflight.test.ts:107` — "reaches every declared refusal kind"), and the
  converse — that no path emits an *undeclared* kind — is delegated to the
  compiler, with a comment at `preflight.test.ts:102-106` that says so plainly
  rather than letting a reader over-read the test. That comment is the single
  best maintainability artifact in this PR: it tells a stranger exactly how much
  the test proves and where the rest of the guarantee lives.
- **The I/O boundary is drawn and enforced by the type system.**
  `preflight.ts` takes `PreflightProbes` and does no I/O; every filesystem and
  subprocess call lives in `cli.ts:163-199`. A stranger can unit-test any
  preflight predicate without a filesystem, and `preflight.test.ts` does exactly
  that. This mirrors the kernel's "built against a simulated clock" discipline
  (AGENTS.md rule 2) on the SDK side.
- **The warning design is honest about its own limits.** The doc comment at
  `preflight.ts:167-174` explains *why* an unresolved deterministic command
  warns instead of refusing — `/bin/sh -c` means the first word may be a
  builtin, a function, or an assignment — and `failure-kinds.ts:23-28` states
  the invariant ("silence is not one of the states") that the three warning
  kinds exist to hold. `preflight.test.ts:75-85` then pins all three states with
  a table test. Comment, invariant, and test agree.
- **The tests include controls against false green.** `cli.test.ts:88-96`
  relocates each ladder flow *without* inducing a fault and asserts it still
  passes, so the induced-fault refusals below it cannot be an artifact of the
  temp directory. That is the kind of test a stranger can trust six months out.
- **Fail-closed on unknown keys survives the new round-trip.**
  `kernelToAuthoring` (`compile.ts:164-...`) re-asserts the per-type key
  allowlist rather than spreading the kernel object, and
  `spec-parity.test.ts:41-44` pins `kernelToAuthoring(toKernelSpec(f)) == f` for
  every canonical fixture. The seam has a test that would actually fail if the
  seam broke.
- **Vocabulary and file-size rails hold.** Step verbs stay
  `deterministic`/`llm`/`agent` (AGENTS.md rule 7, RFC §213); no file in the
  diff reaches 500 lines. `validate.ts` at 454 is the one approaching it — worth
  naming to the next author, not a finding.

---

## 3. Findings

### M1 — `docs/SURFACE.md:80` states a resolution rule the code does not implement, and the one fixture that could catch it cannot

**Blocking.** This is the archetype the lens asks about: a comment that asserts
what the code does not do, backed by a test that would not fail if the behavior
broke.

The paragraph added by this PR (`docs/SURFACE.md:80`) declares the
preflightable-CLI contract:

> `flows check` resolves the binary (**a path is taken relative to the flow**, a
> bare name via `PATH`) and runs exactly that probe…

The code resolves a path-shaped `cli` against **two different bases depending on
which rung of the resolution ladder declared it** (`sdk/src/cli.ts:163-169`):

```ts
function systemProbes(flowDirectory: string, config: ProjectConfig): PreflightProbes {
  return {
    cli: (cli, source) => probeCli(cli, source === 'project' ? config.directory : flowDirectory),
    ...
```

For `source === 'step'` and `'flow'` the base is the flow's directory — the doc
is right. For `source === 'project'` the base is the **`flows.json` directory**,
which may be an ancestor of the flow. The doc is silent on this, and its one
concrete claim contradicts it.

**Reproduced** (throwaway tree; probe binary sits next to `flows.json`, *not*
next to the flow):

```
root/flows.json        {"cli": "./authcli", "executors": []}
root/authcli           #!/bin/sh — exits 0 on `auth status`
root/flows/a.flow.yaml version 0.1.0, one llm step, no cli

$ flows check root/flows/a.flow.yaml
RESOLVED step "answer" cli "./authcli" from project
CHECK PASSED .../flows/a.flow.yaml
exit=0
```

Under the documented rule, `./authcli` relative to `root/flows/` does not
exist, so a reader predicts `REFUSED [cli_missing]`. They get `exit=0`.

**Why the suite does not catch it.** The only fixture that exercises the
`project` rung is `testdata/preflight/project-default/`, and there
`flows.json` and `project-cli.flow.yaml` sit in the *same* directory
(`testdata/preflight/project-default/flows.json` → `"cli": "../authenticated-cli"`).
Both resolution bases are that one directory, so `cli.test.ts:172-177`
("loads the final CLI resolution source from the nearest flows.json") passes
identically under either rule. Swapping `config.directory` for `flowDirectory`
in `systemProbes` keeps all 105 tests green. The behavior is unpinned.

**Evidence this has already misled a reader:** the round-4 transcript shipped in
this same PR, `ops/reviews/20260827-1726-review.md:258-259`, restates the doc's
claim as verified fact — *"a path-shaped `cli` resolved **relative to the flow
file's directory** (`:184-186`)"* — while reviewing the very lines that
contradict it. The doc is one review round old and has already propagated a
false statement into the repository's own record. That is the six-month failure
mode happening in under six hours.

**Which side is wrong:** the doc, not the code. A path written in `flows.json`
should be relative to `flows.json` — that is what a stranger would expect and it
is what the fixture depends on. The repair is a clause in `SURFACE.md:80`
(*"a path is taken relative to the file that declares it — the flow for a
step/flow-level `cli`, the project config for a `flows.json` default"*) plus a
fixture where the two bases genuinely differ.

---

### M2 — `FlowSpec.name` is typed `string` but this PR made it optional at validation, so the type now lies to every consumer

**Blocking.** Before this PR, `validate.ts` required a non-empty `name`, and
`FlowSpec.name: string` (`sdk/src/spec.ts:164`) was an honest contract. This PR
relaxed the validator for kernel parity (`sdk/src/validate.ts:106-108`, and a
new test at `sdk/tests/validate.test.ts:268` asserts a nameless spec is accepted
"because the kernel treats it as optional") — but left the interface unchanged.
`compileSpec` copies the field unconditionally (`sdk/src/compile.ts:73`,
`name: input.name`), so it now returns an object typed `{ name: string }` whose
`name` is `undefined`.

**Reproduced:**

```
$ flows check <nameless valid flow>
WARNING [unprovable_effects] Step "greet" command "echo" resolves, ...
CHECK PASSED .../noname.flow.yaml
exit=0

compileSpec({version:'0.1.0', steps:[{id:'a',type:'deterministic',command:'echo hi'}]})
  → typeof f.name === 'undefined'   ('name' in f === true)
  → f.name.toUpperCase()            throws TypeError
```

`FlowSpec` is exported from `sdk/src/index.ts`, so this is the SDK's public
contract. A stranger writing `flow.name.trim()` or `` `run ${flow.name}` `` gets
no compiler warning and a runtime `TypeError` — or worse, a journal entry
reading `run undefined`. In a repo whose rule 4 is *fail closed, no silent
fallbacks*, a type that silently disagrees with its validator is the quietest
possible fallback: the type **is** the documentation here, and it is now wrong.

Nothing pins the compiled shape either. The new test asserts `validateSpec`
returns `ok`, but no test asserts what `compileSpec` then hands back, so
tightening or loosening this contract later produces no failure.

The repair is two lines — `name?: string` on `FlowSpec` (matching
`KernelRunSpec.name?: string` at `spec.ts:262` and `RunSpec.name: Option<String>`
in `spec.rs:29`) and `...(input.name !== undefined ? { name: input.name } : {})`
in `compileSpec` — plus one assertion that a nameless compile omits the key.
I flag it rather than repair it because `sdk/src/` is inside this PR's diff.

*Relationship to prior rounds:* `ops/BACKLOG.md` files P2 as SDK↔kernel dialect
divergence in "the supported version and the kernel's optional `name`", and
`20260827-1726-review.md:226` extends it to `isKernelSpec`. All of that is about
*which specs are accepted*. None of it notices that closing the `name` half of
P2 left the TypeScript type behind. This is a new consequence of the fix, not
the filed gap.

---

### M3 — the project-config search walks to the filesystem root, and the report never says which config it used

**Non-blocking, but it will cost someone an afternoon.** `findConfig`
(`sdk/src/cli.ts:147-161`) ascends from the flow's directory to `/` looking for
`flows.json`, with no repo boundary (`.git`, `package.json`) and no comment
stating the search is unbounded. Two consequences a stranger cannot see from the
code:

1. A stray `flows.json` in `$HOME` or any ancestor silently becomes the project
   config and can supply the default `cli` for every flow beneath it.
2. `readProjectConfig` is fail-closed on unknown keys (`cli.ts:131-133`), so an
   unrelated `flows.json` belonging to some other tool makes *every* check in
   that subtree refuse with `config_invalid` — an error naming a file the author
   never wrote.

The report cannot help them diagnose it: `CheckReport` carries the flow `path`
and `resolutions[].source: 'project'`, but never the config file's path. "Where
did this CLI come from?" is unanswerable from `flows check --json`.

Coverage: every committed fixture places `flows.json` in the flow's *own*
directory (`testdata/flows.json`, `testdata/preflight/flows.json`,
`testdata/preflight/project-default/flows.json`, and the temp dirs written by
`ladderVariant`, `cli.test.ts:48`). The loop body past its first iteration —
`cli.ts:157-160`, the ascent itself — is never executed by the suite.

Adding the resolved config path to `CheckReport` costs one field and turns this
from a mystery into a printed fact. A stop marker is a design call for the next
author, not something to decide here.

---

### M4 — `probe_failed` is only ever produced by an injected probe, never by the real one

**Non-blocking.** `probe_failed` is a declared member of the closed taxonomy and
`docs/SURFACE.md:80` promises it for "a probe that cannot be executed at all".
`preflight.test.ts:113` reaches it, but only by injecting a throwing probe. The
sole real producer — `probeCli`'s `if (result.error !== undefined) throw new
Error('probe failed')` (`cli.ts:179`), which fires on the 10 s `spawnSync`
timeout or on `EACCES` — has no test at any level. `grep -rn probe_failed
sdk/tests` returns nothing.

That line is exactly the kind a future refactor deletes. Change it to
`return { exists: true, authenticated: false }` and all 105 tests stay green
while a timed-out probe starts reporting `cli_unauthenticated` — the wrong kind,
and a quiet degradation of the covenant-2 claim the taxonomy exists to make. A
fixture that `sleep 30`s, or one with the execute bit cleared, closes it.

*Related but distinct from N4/N5:* `20260827-1726-review.md` flagged that
`flows check` executes a spec-named binary (trust boundary) and that the
executor check is a declaration rather than a registry. Neither is about test
coverage of the probe's own error path.

---

## 4. Things I checked and cleared

- **Comments vs. code.** Every doc comment in `preflight.ts` and
  `failure-kinds.ts` matches behavior; the `/bin/sh -c` justification checks out
  against the kernel's deterministic executor, and "this module performs no I/O"
  is true. `SURFACE.md:80` is the one exception (M1).
- **Naming vs. scope.** `warnOnUnprovableEffects` is called for every step but
  returns early for non-deterministic ones, and its comment scopes the claim to
  deterministic steps. Slightly wider name than behavior; the comment carries it.
  Not a finding.
- **Kernel/SDK parity for the new fields.** `cli` and `triggers` are added on
  both sides with matching validation (`EmptyCli`, `EmptyStepCli`,
  `InvalidTrigger`, `DuplicateTrigger` in `spec.rs:425-440`;
  `validateTriggers`/`validateCli` in `validate.ts`), and `TriggerSpec` is
  `deny_unknown_fields`. The unknown-field allowlists were widened in lockstep.
- **Round-trip symmetry.** `kernelToAuthoring` drops an empty `depends_on` while
  `toKernelSpec` always emits one; `spec-parity.test.ts` covers this and passes,
  and the asymmetry is intentional (authoring shape omits the default).
- **Dead code / speculative abstraction (rule 6).** Every export in the new
  modules has a consumer. `isCheckFailureKind` is used by `cli.test.ts`;
  `CHECK_INPUT_FAILURE_KINDS` by both.
- **`--json` contract.** Diagnostics go to stderr in both modes and the report to
  stdout under `--json`; `cli.test.ts:128-134` parses it and asserts every kind
  is declared. Consistent, if undocumented as a stable interface.
- **File-size rail.** Largest touched file is `sdk/src/validate.ts` at 454 lines.
  Under the 500 threshold; the next author touching it should weigh a split.

---

## 5. Verdict rationale

The engineering in this PR is above the bar in most respects — the closed
taxonomy, the injected-probe boundary, the control tests, and the comment at
`preflight.test.ts:102-106` that scopes its own guarantee are all things a
stranger will be glad to find. My two blocking findings are not about the
design; they are about the two artifacts a stranger trusts *before* they read
any code.

- **M1**: the contract paragraph this PR added to `docs/SURFACE.md` makes a
  specific, checkable claim about path resolution that the code contradicts for
  one of three resolution sources, and the fixture set cannot distinguish the
  two rules. It has already put a false statement into a review transcript
  shipped in this same PR.
- **M2**: `FlowSpec.name` now claims `string` where the validator, the compiler,
  and the kernel all accept absent — an SDK-public type that produces a runtime
  `TypeError` with no compiler warning, introduced by this PR's own parity fix.

Both are reproduced above, both were introduced by this diff, and both are
repairable in a handful of lines plus one discriminating fixture each. Under
this lens — *can a stranger change this safely in six months* — a wrong doc and
a lying type are the two failures that compound, because every later reader
inherits them. M3 and M4 are recorded for the next assess and do not block.

I am refusing on the two, not on the whole.

REVIEW_FAILED
