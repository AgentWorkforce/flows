# PR #8 — maintainability review (round five)

- **PR:** #8 — `WP-4 — flows check preflight (covenant 2)`
- **Branch:** `flow/drive-57e923c-08271542`
- **Reviewed commit:** `3293ff3a1a974157ddd465086ff92e2fd545b4f3` (`fix(review-swarm): remove merge artifact`)
- **Lens:** maintainability — could a stranger read this in six months and change it safely?
- **Read first:** `AGENTS.md`, `docs/RFC-0001-everything-is-a-relayflow.md` (§1 covenants 1–2, §3 gate-1 done-when, §7 settled decisions), `docs/SURFACE.md` §2.6

---

## 1. What I read and what I ran

I did not review the supplied `/tmp/pr-8.diff` on its own. I read it, then read the
working tree at `HEAD` and ran experiments against it, because a maintainability
claim about "would a test fail if this broke" can only be settled by breaking it.

Read in full: `sdk/src/preflight.ts`, `sdk/src/cli.ts`, `sdk/src/failure-kinds.ts`,
`sdk/tests/preflight.test.ts`, `sdk/tests/cli.test.ts`, the `compile.ts` /
`spec.ts` / `validate.ts` diffs, `kernel/relayflowd-core/src/spec.rs` and its
tests, every `testdata/preflight/` fixture, `workflows/review-swarm.yaml`,
`ops/NEXT.md`, and all four prior maintainability transcripts
(`20260827-{1810,1829,1842,1857}-pr8-maintainability.md`).

Ran, in `sdk/`:

| # | Experiment | Result |
|---|---|---|
| E0 | `npm test` (`tsc --noEmit && vitest run`) at `HEAD` | **111 passed, 7 files.** Green. |
| E1 | Fed a kernel-dialect spec whose only kernel marker is a kernel-shaped `verification` | Refused `invalid_spec` with an **authoring-dialect** message |
| E2 | Same, with a kernel-shaped `budget` | Refused, message suggests `maxTokensIn` — a key invalid in the author's dialect |
| E3 | Reduced `cli.ts:242`'s `kernelKeys` from five keys to `['retry']` | **33/33 CLI tests still passed** |
| E4 | Placed an unrelated `flows.json` at `os.tmpdir()` | **1 test failed** (`recognizes a kernel spec when defaulted sentinel keys are omitted`) |
| E5 | Renamed the emitted `--json` fields `ok`→`okay`, `path`→`pathname` | `tsc` clean, **33/33 passed** |
| E6 | Checked a step with `command: "FOO=bar make build"` | `WARNING [command_unresolved] … command "FOO=bar" does not resolve` |
| E7 | `spawnSync(..., {timeout: 300})` on a 2 s child | `error: ETIMEDOUT` — confirms a slow CLI becomes `probe_failed` |

Every mutation was reverted; `git status` is clean apart from this round's
sibling transcripts and this file.

---

## 2. Verdict in one line

The engineering in `preflight.ts` is the best-shaped code in this repo — a pure,
I/O-free predicate module behind an injected-probe seam, with a closed taxonomy
and reachability tests — but the PR is **still not safely changeable by a
stranger**: four of round four's findings are verbatim unfixed, the machine-facing
`--json` contract it ships is pinned by nothing, and the dialect sniff carries a
comment asserting a safety property I disproved in two minutes.

**REVIEW_FAILED.**

---

## 3. Blocking findings

### B1 — round four's F4, C1, C2 and C3 are verbatim unfixed, and this is not "the reviewer arrived too early"

I checked whether the branch moved after round four's transcript
(`23127e2`) before filing this, because "carried" is only fair if the author had
the chance to act:

```
$ git diff --stat 23127e2 HEAD -- sdk kernel docs testdata workflows
 docs/RFC-0001-everything-is-a-relayflow.md |  6 +++++-
 docs/SURFACE.md                            |  2 ++
 sdk/src/cli.ts                             | 16 ++++++++++++++--
 sdk/src/compile.ts                         | 14 --------------
 sdk/src/preflight.ts                       | 13 ++++++++++++-
 sdk/tests/cli.test.ts                      | 29 +++++++++++++++++++++++++----
 workflows/drive.yaml                       | 17 ++++++++++-------
```

So the branch *did* move after round four. Round-four **F1** (undocumented config
walk) was closed properly — the "Project-config discovery" paragraph in
`SURFACE.md` plus the `Nearest project config "…" declares no cli; outer configs
are shadowed.` message plus a real shadowing test is a genuinely good fix.
Round-four **F3** (dead retry range guard) was closed by deleting the guard.

The rest were passed over:

- **F4 — two assertions that cannot fail.** Both still present, unchanged:
  - `sdk/tests/preflight.test.ts:121` — `expect(refusalKinds).not.toContain('unknown')`,
    two lines after `expect(new Set(refusalKinds)).toEqual(new Set(PREFLIGHT_FAILURE_KINDS))`.
    Line 119 passing makes line 121 unfalsifiable.
  - `sdk/tests/cli.test.ts:257` —
    `expect(new Set([...CHECK_INPUT_FAILURE_KINDS, ...PREFLIGHT_FAILURE_KINDS])).toEqual(new Set(CHECK_FAILURE_KINDS))`.
    `failure-kinds.ts:18-21` *defines* `CHECK_FAILURE_KINDS` as exactly that
    spread. It asserts a definition against itself.
  - A third of the same species that round four did not name:
    `preflight.test.ts:69` — `expect(PREFLIGHT_WARNING_KINDS).toContain(result.diagnostics[0]!.kind)`,
    three lines after asserting `kind: 'unprovable_effects'`, on a value whose
    type is already the union.
- **C1 — `PreflightProbes` never states that a probe may throw.** `preflight.ts:20`
  still reads only `/** Environment facts are injected; this module performs no I/O. */`.
  Two of the three catch arms (`probeTrigger`, `warnOnUnprovableEffects`) remain
  unreachable through the shipped CLI, undocumented as an interface obligation,
  and in tension with AGENTS.md rule 6.
- **C2 — `SURFACE.md` promises a message the code does not emit.** The doc still
  says the operator "is told to add the subcommand"; the code still emits
  `but its auth probe failed.` — no mention of `auth status`, no exit-code
  expectation, no instruction.
- **C3 — `spec.ts:126/139` still describe `cli` to the author as runtime
  selection** (`Agent CLI selected for this step`) while `spec.rs:32-37` correctly
  documents the field as inert for gate 1. The two files tell the reader
  different stories about the same field.

Individually each is small. Together they are the reason this is blocking: a
reader six months from now inherits a review record that says these were seen and
a codebase that says they were not addressed, with no note anywhere explaining
which. Either fix them or record the decision to defer them — silence is the one
option that costs the next reader real time.

### B2 — `--json` is the machine-facing contract this PR ships, and I renamed two of its fields without turning the suite red

`flows check --json` is how anything other than a human consumes preflight. Its
shape is `CheckReport` (`cli.ts:24-30`): `ok`, `path`, `projectConfigPath`,
`resolutions`, `diagnostics`. Round four filed this as F2; it is unfixed, and the
evidence is stronger than "one field":

```
E5: renamed ok→okay and path→pathname in CheckReport, emitInputFailure,
    the report literal in runCli, and emitReport
    → npx tsc --noEmit : clean
    → npx vitest run tests/cli.test.ts : 33 passed (33)
```

The only test that touches the JSON path (`cli.test.ts:128-134`) parses stdout and
inspects `report.diagnostics[].kind`. `ok`, `path`, `projectConfigPath` and
`resolutions` — three of which this PR added — are asserted by nothing in JSON
form. `resolutions` in particular is the answer to SURFACE.md's promise that "you
are told exactly who you hired before the run starts", and a consumer reading it
out of `--json` has no test standing behind the key names.

`CheckReport` is also not exported (`index.ts` exports `PreflightResult` but not
`CheckReport`), so a consumer cannot even type against it. One test asserting the
full parsed object for one refusal and one pass, plus exporting the interface,
closes this.

### B3 — the dialect sniff's comment asserts a safety property the code does not have, and four of its five keys are pinned by nothing

`cli.ts:238-246`:

```ts
function isKernelSpec(value: unknown): boolean {
  if (!isObject(value) || !Array.isArray(value['steps'])) return false;
  // Any kernel-only step key selects the boundary dialect. A minimal authoring
  // step may share all other keys with a defaulted kernel step.
  const kernelKeys = ['depends_on', 'max_iterations', 'retry', 'timeout_ms', 'recovery_mode'];
  ...
}
```

The second sentence is the load-bearing claim, and it is the exact species this
lens is asked to catch: *a comment that asserts what the code does not do*. Two
keys are kernel-only in **shape** rather than in **name**, and neither is in the
sentinel list:

```
E1  {"version":"0.1.0","steps":[{"id":"a","type":"deterministic","command":"printf x",
     "verification":{"output_contains":"x"}}]}
 → REFUSED [invalid_spec] spec.steps[0].verification.type: expected exit_code | output_contains | json_schema

E2  {"version":"0.1.0","budget":{"max_tokens_in":10},"steps":[…]}
 → REFUSED [invalid_spec] spec.budget: unknown key "max_tokens_in" — did you mean "maxTokensIn"?
```

Both inputs are well-formed kernel-dialect documents. Both are answered in the
authoring dialect, and E2 actively instructs the author to write `maxTokensIn` —
a key that is invalid in the dialect they are writing. Covenant 1 requires error
messages to "name the author's mistake in the author's vocabulary"; this names a
mistake the author did not make, in a vocabulary they are not using.

This is narrow today because `toKernelStep` always emits `retry`, so anything
*this compiler* produces is detected. But `readFlow` accepts arbitrary JSON from
disk — a hand-written kernel spec, a spec lifted out of a journal, a spec emitted
by the Rust side (`RunSpec` skips `retry` when defaulted:
`skip_serializing_if` on the retry fields). The comment tells the next maintainer
the sniff is complete. It is not.

Worse, the test that carries the claim does not test it:

```
E3: const kernelKeys = ['retry'];   // four of five entries deleted
 → 33 passed (33)
```

`cli.test.ts:142` is named `recognizes a kernel spec when defaulted sentinel keys
are omitted` and deletes only `depends_on` and `max_iterations`, leaving `retry`
in place — so it passes with a one-key sniff. `timeout_ms` and `recovery_mode`
are pinned by nothing at all. The test's name promises coverage of the sentinel
set; it covers one member of it.

Fix shape: either add `verification`/`budget` shape discrimination and say so, or
narrow the comment to what is true ("specs this compiler emits always carry
`retry`; hand-written kernel specs without a sentinel key are misrouted") and add
a case per sentinel key.

### B4 — test hermeticity is asserted in one helper and abandoned in four siblings, and I turned the suite red by touching nothing in the repo

`cli.test.ts:36-42` documents hermeticity as the principle, and `ladderVariant`
earns it — it writes its own empty `flows.json` into each temp directory
specifically so `findConfig`'s upward walk stops there:

> *"…written to a throwaway directory with its own empty flows.json, so
> resolution is hermetic: nothing mutates PATH, the canon on disk, or an ambient
> project config."*

Four sibling tests create temp directories and do not (`cli.test.ts:143`, `:163`,
`:178`, `:238`). `findConfig` (`cli.ts:156-170`) walks from the flow's directory
to the filesystem root, so those four read whatever `flows.json` exists above the
OS temp directory:

```
E4: $ echo '{"project":"other"}' > "$(node -p 'os.tmpdir()')/flows.json"
    $ npx vitest run tests/cli.test.ts
    × recognizes a kernel spec when defaulted sentinel keys are omitted
      → expected 2 to be +0
    Tests  1 failed | 32 passed (33)
```

I changed no repo file. On macOS `os.tmpdir()` is a per-user private directory,
which hides this; on Linux CI it is `/tmp`, world-writable and shared with every
other job on the box. The failure mode that matters is not the red run — it is
the *green* one, where a stray ambient config supplies a `cli` and a test that
should have refused quietly passes.

The comment on `ladderVariant` makes this worse rather than better: it tells the
next reader that hermeticity is the suite's standard, so they will not think to
check the four tests that do not meet it. One shared `temporaryProject()` helper
that always writes the boundary `flows.json` removes the whole class.

---

## 4. Non-blocking findings

### N1 — `runCli`'s catch-all destroys the cause and bills it to the author

```ts
} catch (error) {
  const failure = error instanceof CheckFailure
    ? error
    : new CheckFailure('invalid_spec', `Flow "${parsed.path}" could not be checked as a Relayflow spec.`);
```
`cli.ts:82-87`. `error` is bound and then never used — no rethrow, no log, no
detail field, nothing on stderr. Any exception from `preflight`, `systemProbes`,
`resolve`, `emitReport`, or a future edit to any of them is reported to the
author as *their spec being invalid*, with the stack destroyed. AGENTS.md rule 4
("no silent fallbacks") is precisely about this shape, and covenant 2's typed
taxonomy is weakened by a kind that can mean "internal bug" as well as "bad
input". I could not construct a reachable trigger today — which is the argument
for handling it now, while the blast radius is one function: a `check_failed`
kind carrying `String(error)`, or a rethrow, costs three lines and keeps the next
`flows check` bug debuggable.

### N2 — `PreflightProbes.cli`'s `source` parameter carries an undocumented obligation, on exported public API

`preflight.ts:21-25` is exported from `index.ts`, so third parties implement it.
`cli(cli: string, source: CliResolutionSource): CliProbeResult` — nothing on the
interface says what an implementer must *do* with `source`. The real obligation
is significant and load-bearing: resolve a relative path against the directory of
the file that declared it — the flow file for `'step'`/`'flow'`, the `flows.json`
directory for `'project'` (`cli.ts:174`). Get it wrong and `./authenticated-cli`
silently resolves against the wrong directory. The rule is written down, but only
in `SURFACE.md` prose *about `flows check`*, not on the interface a stranger will
implement against. One sentence on the method fixes it. (Same paragraph should
carry C1's "a probe may throw; a throw is `probe_failed`".)

### N3 — the probe timeouts are unnamed magic numbers inside a contract the docs call "the whole contract"

`cli.ts:186` (`timeout: 10_000`) and `cli.ts:202` (`timeout: 5_000`). E7 confirms
a timeout sets `result.error`, so `probeCli` throws and the step is refused
`probe_failed`. So a CLI whose `auth status` takes 11 s — a network-backed token
check on a slow link is the obvious case — refuses the flow. `SURFACE.md`'s
Preflightable-CLI paragraph enumerates `cli_missing`, `cli_unauthenticated` and
`probe_failed` and calls that "the whole contract", but never mentions a deadline.
Name the constants (`AUTH_PROBE_TIMEOUT_MS`, `WHICH_TIMEOUT_MS`) and add the
deadline to the documented contract.

### N4 — `command_unresolved` names something the author never wrote as a command

```
E6: command: "FOO=bar make build"
 → WARNING [command_unresolved] Step "build" command "FOO=bar" does not resolve
   as an executable; it runs only if the shell supplies it.
```
The *decision* is right and `warnOnUnprovableEffects`' doc comment
(`preflight.ts:178-185`) explicitly anticipates assignments as a reason to warn
rather than refuse — that comment is honest. The *message* is not: it tells the
author their command is `FOO=bar`. Since the code already knows this case is
expected, the message can say so ("the first word is a shell assignment, so the
executable cannot be determined statically").

### N5 — `CheckReport.resolutions: ReturnType<typeof preflight>['resolutions']`

`cli.ts:28`. `CliResolution` is declared and exported two files away. The indirect
form makes the reader chase a function's return type to learn a field's shape,
and it silently changes meaning if `PreflightResult` is ever refactored. Write
`CliResolution[]`.

### N6 — `PreflightOptions`' three project fields have an unexpressed relationship

`projectCli`, `projectConfigPath` and `projectSearchStart` (`preflight.ts:27-32`)
are three independent optionals that in truth describe one thing: the outcome of
config discovery. `unresolvedCliMessage` branches on `configPath` then
`searchStart`, and the combination "`projectCli` set but `projectConfigPath`
absent" is nonsense that the type permits (harmless today only because a set
`projectCli` means resolution never fails). A single
`project?: { cli?: string; configPath?: string; searchStart: string }` makes the
invariant structural instead of conventional.

### N7 — the shipped binary is executed by no test

`package.json` gains `"bin": {"flows": "./dist/cli.js"}`. Every test calls
`runCli` in-process. Nothing exercises the shebang, the `dist` build, or the
entry guard at `cli.ts:256`:

```ts
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = runCli(process.argv.slice(2));
}
```

If that comparison ever stops matching — a bundler, a symlinked `bin`, a
`node --experimental-*` path change — `flows check` becomes a program that exits
`0` and does nothing, and the suite stays green. For a PR whose entire deliverable
is a CLI, one `execFileSync('node', ['dist/cli.js', 'check', fixture])` asserting
exit `2` on a known-bad fixture is the difference between testing the product and
testing a function inside it.

### N8 — evidence integrity: the swarm that produced this review is not the swarm in the repo

Not a defect in the reviewed code; recorded because it affects how much this
transcript is worth. `workflows/review-swarm.yaml` at `HEAD` requires each lens to
stamp `reviewed-head: $(cat /tmp/pr-$PR.head)` and to *commit* its transcript, and
the aggregate refuses on either. But:

- `/tmp/pr-8.json` contains only `headRefName,title,url` — no `headRefOid`, which
  the committed fetch step requests;
- `/tmp/pr-8.head` does not exist;
- the task text I was given asks me to "`git add` it", not to commit, and says
  nothing about `reviewed-head`.

All three are the *pre-WP-5* contract. The definition on disk and the definition
that ran disagree, so the aggregate as committed would fail at
`if [ -z "$reviewed_head" ]` before evaluating any verdict. I have stamped the
head I actually reviewed below so this transcript is valid under either contract.
This is round four's F5 ("triplicated prose enforced by a grep, with no test, and
already not being honored") continuing to be true, now demonstrable from the
artifacts of this very run.

---

## 5. What is genuinely good here, and should survive any rework

Naming these precisely, because a rejection that does not distinguish the strong
parts invites someone to rewrite them:

1. **`preflight.ts` is the right module.** Zero I/O, all environment facts behind
   `PreflightProbes`, every predicate a pure function of `(FlowSpec, probes)`.
   It is testable without a filesystem, and the unit tests prove it (9 tests, 6 ms).
   This is what AGENTS.md rules 1 and 2 are asking for, applied on the surface
   side rather than the kernel side.
2. **The taxonomy is closed and the closure is argued correctly.** `failure-kinds.ts`
   splits input refusals from preflight refusals, and the comment at
   `preflight.test.ts:102-106` is the most honest thing in the PR: it states that
   the test proves *reachability* and that the *converse* is held by the typed
   union plus `tsc --noEmit`. That is exactly the distinction most suites blur.
3. **The induced-fault ladder tests have a control.** `cli.test.ts:92-96` relocates
   each ladder flow *without* a fault and asserts it still passes, so the twelve
   induced-fault refusals cannot be an artifact of the temp directory. Very few
   suites bother.
4. **The three-warning invariant is a real invariant, stated and tested.** "A
   deterministic step always leaves exactly one warning; silence is not one of the
   states" is asserted in `failure-kinds.ts:23-28`, restated at `preflight.ts:178`,
   and pinned by an `it.each` over all three states with `toEqual` on the whole
   diagnostics array (not `toContain`), which would fail on a spurious extra
   diagnostic.
5. **`SURFACE.md`'s two new contract paragraphs.** The Preflightable-CLI contract
   and the Project-config discovery paragraph are the kind of prose that makes a
   surface changeable — they say what the mechanism is, what it refuses, and what
   it deliberately does not do. C2 is a defect *within* an otherwise excellent
   paragraph, not an argument against it.
6. **The kernel side is fail-closed and honestly scoped.** `spec.rs` adds
   `deny_unknown_fields` on `TriggerSpec`, empty-string and duplicate-id checks,
   and — critically — comments that call `cli`/`triggers` inert for gate 1 rather
   than implying dispatch. `preflight_data_is_fail_closed` pins both halves.

---

## 6. Verdict rationale

The lens question is whether a stranger could change this in six months safely.
Four concrete answers, all demonstrated rather than asserted:

- They would trust `--json`'s field names, which nothing pins (**B2**, E5).
- They would trust `isKernelSpec`'s comment that the sniff is complete, which is
  false, and trust a test whose name claims coverage it does not have
  (**B3**, E1–E3).
- They would trust `ladderVariant`'s stated hermeticity as the suite's standard
  and not notice four tests that break it (**B4**, E4).
- They would find four findings from the previous round still open with no record
  of a decision (**B1**).

None of these is a correctness bug — the suite is green, `tsc` is clean, and the
preflight predicates do what covenant 2 asks. They are all *maintainability*
defects, which is this lens's job, and three of the four are things the PR's own
comments and test names actively mislead the next reader about.

The fixes are small and mostly mechanical: one full-shape `--json` assertion plus
an export; one corrected comment plus per-sentinel-key cases; one shared temp-project
helper; and either fixing or explicitly deferring round four's F4/C1/C2/C3.

reviewed-head: 3293ff3a1a974157ddd465086ff92e2fd545b4f3
REVIEW_FAILED
