# PR #8 — maintainability review (round two)

- **PR:** [#8 — WP-4 — flows check preflight (covenant 2)](https://github.com/AgentWorkforce/flows/pull/8)
- **Branch / head:** `flow/drive-57e923c-08271542` @ `c839179`
- **Lens:** maintainability — *could a stranger read this in six months and change it safely?*
- **Reviewer:** claude (review-swarm `maintainability` lens, `workflows/review-swarm.yaml`)
- **Date:** 2026-08-27 18:29
- **Read first:** `AGENTS.md`, `docs/RFC-0001-everything-is-a-relayflow.md`
  (§1 the three covenants, §2 rule 7, §3 gate 1 done-when, §7 versioning)
- **Prior round:** `ops/reviews/20260827-1810-pr8-maintainability.md` (M1–M4)

---

## 1. What I read and what I ran

Diff: `/tmp/pr-8.diff` (45 files, 5187 diff lines), regenerated at 18:23 and so
including `c839179` (`WP-5: address review swarm round-one findings`).
Metadata: `/tmp/pr-8.json`.

Substantive source under review this round:

| File | State | Read |
|---|---|---|
| `workflows/review-swarm.yaml` | new, 165 | in full — **not read closely in round one** |
| `sdk/src/preflight.ts` | new, 221 | in full |
| `sdk/src/cli.ts` | new, 241 | in full |
| `sdk/src/failure-kinds.ts` | new, 43 | in full |
| `sdk/src/compile.ts` | +153 | diff + `kernelToAuthoring` in full |
| `sdk/src/validate.ts` | +59 | diff |
| `sdk/src/spec.ts`, `sdk/src/index.ts` | +37 | diff |
| `kernel/relayflowd-core/src/spec.rs` | +57 | diff + `RunSpec::validate` |
| `sdk/tests/{cli,preflight,validate,spec-parity}.test.ts` | +418 | in full |
| `docs/SURFACE.md` | +4 | the two added paragraphs, in context |
| `testdata/**` | fixtures | all |

Executed, not inferred:

```
$ cd sdk && npm test
> tsc --noEmit && vitest run
 Test Files  7 passed (7)
      Tests  106 passed (106)
   Duration  941ms
```

Green including the typecheck. Every claim below was reproduced against this
tree; all scratch files were removed and `git status --porcelain` shows only the
untracked `.review-target`.

I read the two sibling transcripts this PR carries
(`20260827-1815-pr8-history.md`, `20260827-1819-pr8-structure.md`) so I would
report new ground. Overlap is marked where it exists.

---

## 2. Round-one findings: both blockers are closed, and closed properly

I verified the repairs by mutation, not by reading the patch.

**M1 (doc contradicted code on CLI path resolution) — fixed and now pinned.**
`docs/SURFACE.md:80` now says *"a path is taken relative to the file that
declares it — the flow for a step/flow-level `cli`, the project config for a
`flows.json` default"*, which is what `cli.ts:165` does. More importantly the
new fixture at `cli.test.ts:179-194` puts `flows.json` in an ancestor of the
flow, so the two resolution bases genuinely differ. Mutation check — revert
`systemProbes` to the documented-in-round-one rule:

```
- cli: (cli, source) => probeCli(cli, source === 'project' ? config.directory : flowDirectory),
+ cli: (cli, source) => probeCli(cli, flowDirectory),

 ❯ tests/cli.test.ts:192  expected 0, received 2
 Tests  1 failed | 30 passed
```

The behavior is no longer unpinned. This is exactly the repair I asked for.

**M2 (`FlowSpec.name` typed `string` while the validator accepted absent) —
fixed.** `spec.ts:164` is now `name?: string`; `compileSpec` (`compile.ts:73`)
and `toKernelSpec` (`compile.ts:147`) both omit the key rather than copying
`undefined`; `validate.test.ts:269-274` asserts
`compileSpec(nameless)).not.toHaveProperty('name')`. The SDK-public type,
the validator, `KernelRunSpec.name?`, and `RunSpec.name: Option<String>`
(`spec.rs:29`) now all agree.

**M3 and M4 remain open** (both were filed non-blocking and neither was in
WP-5's scope). Restated in §5 so they are not lost, not re-argued.

---

## 3. Findings

All three blocking findings this round are in `workflows/review-swarm.yaml`,
which this PR introduces in full. `ops/reviews/20260827-1815-pr8-history.md`
(H1) argues this file should not be in this PR at all; that is the history
lens's ground and I do not re-litigate it. My findings are different: they are
defects in the file **as an artifact someone must maintain**, and they would be
just as true if it landed on `main` tomorrow. Under this lens a gate that
decides whether work merges is the highest-stakes thing in the diff, because
every later reader trusts its verdict without re-deriving it.

Taken together the three mean the gate can **report success on no evidence**
(M5) and **report rejection on good evidence** (M6, M7). Neither direction is
recoverable by a reader who only sees `SWARM_PASSED` / `SWARM_FAILED`.

### M5 — the `fetch` step reports `FETCHED` and exits 0 when both `gh` calls fail, and the lenses then review an empty diff

**Blocking.** `workflows/review-swarm.yaml:41-56`:

```sh
set -u
...
gh pr view "$PR" --json headRefName,title,url > /tmp/pr-$PR.json
gh pr diff "$PR" > /tmp/pr-$PR.diff
echo "target PR #$PR, $(wc -l < /tmp/pr-$PR.diff) diff lines"
echo FETCHED
```

`set -u` is set; `set -e` is not, and neither `gh` invocation's exit status is
checked. The redirect truncates the target file before `gh` runs, so a failure
leaves a **zero-byte** artifact rather than no artifact, and `FETCHED` is
printed unconditionally.

**Reproduced in this repository** (real remote, nonexistent PR number):

```
$ sh /tmp/f2.sh
GraphQL: Could not resolve to a PullRequest with the number of 4242. (repository.pullRequest)
could not find pull request diff: HTTP 404: Not Found (https://api.github.com/repos/AgentWorkforce/flows/pulls/4242)
target PR #4242,        0 diff lines
FETCHED
EXIT=0
-rw-r--r-- 1 khaliqgant wheel 0 /tmp/prrepro-4242.diff
-rw-r--r-- 1 khaliqgant wheel 0 /tmp/prrepro-4242.json
```

The step succeeds. `lens-maintainability`, `lens-history`, and `lens-structure`
then each run against `/tmp/pr-<n>.diff` — now an empty file — and each is
capable of writing a transcript ending in `REVIEW_PASSED`, because an empty diff
contains nothing to object to. The aggregate finds three committed transcripts
with three passing verdicts and emits `SWARM_PASSED`.

There is standing evidence this is not hypothetical: `/tmp/pr-99999.json` sits
on this machine at 0 bytes, timestamped 17:37 — an earlier fetch that failed
and reported nothing.

The same failure mode is already recorded twice in this repo, which is what
makes it a maintainability finding rather than a style note:

- RFC-0001 covenant 2: *"A raw stack trace, a silent wrong-workspace run, or a
  'succeeded' that did nothing is by definition a kernel bug."*
- `ops/BACKLOG.md`: *"RelayCron's `succeeded` into a void (covenant 2)"* — filed
  as a regression fixture for this exact class.
- The workflow's own description says the swarm exists because *"external bots
  are not review signal … both reporting SUCCESS."* A swarm that reports
  SUCCESS on a diff it failed to fetch is the same defect it was built to
  replace.

A reader six months out sees `set -u` at the top and reasonably concludes the
step aborts on error. It does not. The repair is `set -eu` plus a non-empty
check on the diff (`[ -s /tmp/pr-$PR.diff ]`), so `FETCHED` means fetched.

### M6 — the aggregate greps the whole transcript for the rejection token while every lens is instructed to *end* with a verdict; a passing review that mentions the token is scored as a rejection

**Blocking.** The three lens tasks say (`review-swarm.yaml:73-78`, `99-105`,
`126-131`):

> write the complete review there, and **end the transcript with exactly**
> `REVIEW_PASSED` or `REVIEW_FAILED`

The aggregate does not check the end of anything (`review-swarm.yaml:156-162`):

```sh
if grep -q "REVIEW_FAILED" "$f"; then
  echo "SWARM_FAILED: $lens rejected — see $f"; fail=1
elif grep -q "REVIEW_PASSED" "$f"; then
```

Anywhere in the file counts, and the rejection token is tested first. This is
the archetype the lens asks about: an instruction that asserts a contract the
checking code does not implement.

**Reproduced** (throwaway git repo, three transcripts, the maintainability one
ending in the passing token and mentioning the other once in prose):

```
$ sh agg.sh
SWARM_FAILED: maintainability rejected — see ops/reviews/20260827-1900-pr8-maintainability.md
ok: history passed (ops/reviews/20260827-1900-pr8-history.md)
ok: structure passed (ops/reviews/20260827-1900-pr8-structure.md)
EXIT=1
```

The concrete consequence for this repository is that **the gate is structurally
hostile to being reviewed**. A lens examining `review-swarm.yaml` cannot quote
its own instruction text, cannot cite a prior round's verdict, and cannot report
this finding — all of which require writing the rejection token — without
converting its own pass into a refusal. It also cannot quote the workflow file's
task blocks, which contain both tokens verbatim. I am only able to write this
section plainly because my verdict this round *is* a refusal; had the SDK been
the whole PR I would have had to obfuscate the token to report the defect, and
the transcript would have been worse evidence for it.

The failure direction is toward false refusal, which is safe for merges and
corrosive for trust: a maintainer who sees the gate reject a review that plainly
says it passed learns to override the gate, and after that the gate is
decoration. The repair is to test the verdict where the instruction says it
lives — e.g. `tail -5 "$f" | grep -q ...`, or a single `VERDICT: <token>` line
matched with `grep -c '^REVIEW_'` and a uniqueness assertion.

### M7 — the aggregate selects a transcript by mtime, which git does not preserve; on a fresh clone it picks the *oldest* round and reports a stale rejection

**Blocking.** `review-swarm.yaml:149`:

```sh
f=$(ls -t ops/reviews/*-pr${PR}-${lens}.md 2>/dev/null | head -1)
```

`ls -t` orders by modification time. Git does not record mtimes; a clone,
checkout, or archive extraction stamps every file at roughly the same instant.
When mtimes tie, both BSD and GNU `ls` break the tie by name **ascending**, so
`head -1` returns the *earliest* filename — the oldest review round.

**Reproduced** — two rounds for one lens, round one rejecting and round two
passing, cloned and then given identical mtimes:

```
$ stat -f '%Fm %N' ops/reviews/*-pr8-maintainability.md
1787839200.000000000 ops/reviews/20260827-1810-pr8-maintainability.md
1787839200.000000000 ops/reviews/20260827-1900-pr8-maintainability.md

$ ls  -t ops/reviews/*-pr8-maintainability.md | head -1   # BSD (darwin)
ops/reviews/20260827-1810-pr8-maintainability.md
$ gls -t ops/reviews/*-pr8-maintainability.md | head -1   # GNU coreutils
ops/reviews/20260827-1810-pr8-maintainability.md

$ f=$(ls -t ... | head -1); grep -q "REVIEW_FAILED" "$f" && echo "SWARM_FAILED: ..."
SWARM_FAILED: maintainability rejected — see ops/reviews/20260827-1810-pr8-maintainability.md
```

This is imminent, not theoretical. The moment this transcript is committed there
are two `*-pr8-maintainability.md` files, and `ops/BACKLOG.md` records that runs
are moving to cloud sandboxes that materialize the repo by clone (*"Cloud
sandbox runs die in `sync`: no git remote"*). The first cloud run of this swarm
on PR #8 will read the 18:10 rejection and report it as the current verdict,
however many rounds have since passed.

The filenames already begin with a sortable `YYYYMMDD-HHMM` stamp, chosen by the
lens tasks for exactly this purpose. `ls -1 … | sort | tail -1` is deterministic,
carries no filesystem-metadata dependency, and is the same number of characters.
A stranger reading `ls -t` has no way to know that the ordering key is one git
deliberately discards.

### M8 — `cli` and `triggers`, the two fields this PR adds to the kernel dialect, are unpinned at the round-trip seam

**Non-blocking, but it undoes a guarantee the PR otherwise earns.**
`spec-parity.test.ts:41-44` asserts `kernelToAuthoring(toKernelSpec(f)) == f`
for the three canonical fixtures, and that is genuinely the right shape of test.
But **none of `hello-ladder`, `hello-llm`, or `hello-agent` declares a `cli` at
any level, and none declares `triggers`** — the round trip never sees either
field. `cli.test.ts:136-140`, the only end-to-end check of the kernel-dialect
path through `flows check`, uses `hello-ladder.spec.canonical.json` and has the
same blind spot.

**Verified by mutation** — I deleted every new field from `kernelToAuthoring`
(flow-level `cli`, flow-level `triggers`, `cli` on the llm branch, `cli` on the
agent branch):

```
- ...copyDefined(root, ['version', 'name', 'description', 'cli', 'triggers']),
+ ...copyDefined(root, ['version', 'name', 'description']),
- return { ...common, prompt: step['prompt'], ...copyDefined(step, ['model', 'cli']) };
+ return { ...common, prompt: step['prompt'], ...copyDefined(step, ['model']) };
- ...copyDefined(step, ['cli', 'surfaces']),
+ ...copyDefined(step, ['surfaces']),

 Test Files  7 passed (7)
      Tests  106 passed (106)
```

All green with the mapping gone. The consumer is `cli.ts:111` — `flows check`
runs `kernelToAuthoring` on any kernel-dialect input — so silent loss of `cli`
flips a `cli_missing` or `cli_unauthenticated` refusal into `cli_unresolved`, or
into a silent pass on the project default. That is a covenant-2 verdict changing
because of an untested mapping.

The maintenance cost compounds: the per-type key list for a step now exists in
**five** places that must move together —
`validate.ts:47-51` (`STEP_TYPE_KEYS`), `compile.ts:105-119` (`compileStep`),
`compile.ts:326-343` (`toKernelStep`), `compile.ts:176-189`
(`kernelStepToAuthoring`'s `unionKeys` **and** `typeKeys`), and
`spec.rs:144-152` (`STEP_LLM_FIELDS` / `STEP_AGENT_FIELDS`). This PR is the
proof: adding one field, `cli`, required touching all five. Nothing fails when
the sixth author updates four of them. One fixture carrying a flow-level `cli`,
a step-level `cli`, and a `triggers` entry closes the immediate hole; the
duplication is a design call for whoever adds the next field.

### M9 — preflight's verdict is a property of the machine that ran `flows check`, and the report never says which machine that was

**Non-blocking; recording the implicit contract.** `resolveExecutable`
(`cli.ts:183-195`) resolves a bare name with `spawnSync('which', …)` against the
checking process's `PATH`, and `probeCli` (`cli.ts:174-180`) runs
`<cli> auth status` against the checking host's credential store. Both feed
**refusals**, not just warnings.

Gate 7 routes steps to sandboxes chosen by the engine; gate 1's own
done-when has `flows check` refusing *"before the run starts"*. So the standard
case is: preflight answers on a laptop, the run executes somewhere else. A
`cli_unauthenticated` refusal can mean "the sandbox has no credentials" or "the
author's laptop has no credentials", and `flows check --json` cannot tell the
two apart — the report carries no host, no `PATH`, no resolved absolute path for
the probed binary, and (per the still-open M3) no config path either.

`docs/SURFACE.md:80` says a bare name "resolves via `PATH`" without saying whose.
The honest form of the claim is one clause plus one field on `CheckReport`
(the absolute path each `cli` resolved to). I am not asking for cross-host
preflight — that is gate 7's problem. I am asking that the report not read as
environment-independent when it is not.

---

## 4. What is genuinely good here

Most of this diff is above the bar and I want it on the record, because the
blocking findings are concentrated in one file.

- **The failure taxonomy is closed, in one 43-line file, and both directions
  are covered** — reachability asserted at runtime (`preflight.test.ts:107`),
  the converse delegated to `tsc` with a comment (`preflight.test.ts:102-106`)
  that scopes exactly how much the test proves. Still the best maintainability
  artifact in the PR.
- **The I/O boundary is drawn and type-enforced.** `preflight.ts` takes
  `PreflightProbes` and does no I/O; every filesystem and subprocess call is in
  `cli.ts:163-199`. The SDK-side analogue of the kernel's simulated clock.
- **The tests carry controls against false green.** `cli.test.ts:88-96`
  relocates each ladder flow *without* a fault and asserts it still passes, so
  the induced-fault refusals below cannot be an artifact of the temp directory.
- **The warning design states its own limits and is pinned three ways.**
  `preflight.ts:167-174` explains why an unresolved deterministic command warns
  rather than refuses (`/bin/sh -c` may supply a builtin);
  `failure-kinds.ts:23-28` states the invariant; `preflight.test.ts:75-85` pins
  all three states in a table. Comment, invariant, and test agree.
- **Fail-closed on unknown keys survives the new round trip.**
  `kernelToAuthoring` re-asserts the per-type allowlist instead of spreading the
  kernel object, and `cli.test.ts:142-155` proves a stray `prompt` on a
  deterministic step refuses rather than being dropped.
- **SDK↔kernel version parity is now exact** — `SPEC_SCHEMA_VERSION = '0.1.0'`
  (`spec.ts:175`) against `SPEC_VERSION: &str = "0.1.0"` (`spec.rs:21`), closing
  the half of backlog P2 that this PR set out to close.
- **Vocabulary and file-size rails hold.** Step verbs stay
  `deterministic`/`llm`/`agent`; the largest touched file is `validate.ts` at
  454 lines, under the 500 threshold.

---

## 5. Carried over, and smaller things

**Still open from round one** (both filed non-blocking then, neither in WP-5's
scope; restated, not re-argued):

- **M3** — `findConfig` (`cli.ts:147-161`) ascends to the filesystem root with
  no repo boundary and no comment saying so, and `CheckReport` never names the
  config file it used. Every committed fixture puts `flows.json` in the flow's
  own directory, so the ascent past its first iteration is still unexecuted by
  the suite. Adding the resolved config path to the report is one field.
- **M4** — `probe_failed` is still reached only by an injected throwing probe.
  `grep -rn probe_failed sdk/tests` returns nothing; the sole real producer,
  `cli.ts:179` (`spawnSync` 10 s timeout, or `EACCES`), has no test at any
  level. Delete that line and 106 tests stay green while a timed-out probe
  starts reporting `cli_unauthenticated`. Related: `SURFACE.md:80` describes
  `probe_failed` as *"a probe that cannot be executed at all"*, which does not
  obviously cover a probe that executed and hung.

**Checked and cleared:**

- Every doc comment in `preflight.ts` and `failure-kinds.ts` matches behavior.
  `SURFACE.md:80` is now correct on path resolution (M1 closed).
- Kernel/SDK parity for the new fields: `EmptyCli`, `EmptyStepCli`,
  `InvalidTrigger`, `DuplicateTrigger` (`spec.rs:428-437`) mirror
  `validateCli` / `validateTriggers`; `TriggerSpec` is `deny_unknown_fields`;
  the unknown-field allowlists were widened in lockstep.
- `--json` contract: diagnostics to stderr in both modes, report to stdout under
  `--json`; `cli.test.ts:128-134` parses it and asserts every kind is declared.
- Dead code (AGENTS.md rule 6): every export in the new modules has a consumer.
- The canonical `.spec.canonical.json` / `.spec.sha256` fixtures are untouched
  by this PR — the ladder YAML changes are comment-only, so the pinned hashes
  still mean what they meant.

**Nits, none of them findings:**

- The comment added to all three ladder fixtures reads *"the canonical spec and
  its hash pin **name** no environment-specific binary"* — a garbled word,
  copied identically into `hello-ladder`, `hello-llm`, and `hello-agent`. These
  headers are the contract for the repo's most load-bearing fixtures; worth one
  clean sentence.
- `index.ts` exports `PreflightProbes` but not `CliProbeResult`, and
  `CHECK_FAILURE_KINDS` but not `CHECK_INPUT_FAILURE_KINDS`. A consumer
  implementing the probe interface can satisfy it structurally but cannot name
  its return type.
- Human-readable output has a positive terminator (`CHECK PASSED`) and no
  negative one; a refusal prints resolutions to stdout and nothing else. The
  exit code carries it, but the asymmetry invites a fragile stdout grep.
- The kernel defaults a missing `version` to `SPEC_VERSION`
  (`spec.rs:26-27, 48-49`) while `validate.ts:100-101` refuses a spec with no
  `version`. Preflight refusing more than the kernel accepts is the safe
  direction, so this is a covenant-1 wording issue, not a hole — but it is the
  last unnamed member of the backlog's P2 family and deserves a line there.
- `.review-target` is untracked, is not in `.gitignore`, and is read
  independently by `fetch` and by `aggregate` up to ninety minutes apart.
  Nothing pins the PR number for the duration of a run.

---

## 6. Verdict rationale

The SDK half of this PR now passes this lens. Both round-one blockers were
repaired at the root rather than papered over, and both repairs are pinned by
tests I confirmed would fail if the behavior regressed. `preflight.ts`,
`failure-kinds.ts`, and the probe-injection boundary are code I would be glad
to inherit.

I am refusing on `workflows/review-swarm.yaml`, which this PR introduces whole
and which is the single artifact in the diff that a future reader will trust
*without* re-deriving it:

- **M5** — `fetch` prints `FETCHED` and exits 0 when both `gh` calls fail,
  leaving a zero-byte diff for three lens agents to review. Reproduced against
  the real remote. A gate that can report success on no evidence is the exact
  defect its own description says it exists to replace.
- **M6** — the aggregate greps the whole transcript for the rejection token
  while every lens is told to *end* with a verdict, so a passing review that
  merely mentions the token is scored as a rejection. Reproduced. It makes the
  gate unable to be reviewed without the reviewer writing around the checker.
- **M7** — the aggregate picks the transcript by `mtime`, which git does not
  preserve; on a fresh clone both BSD and GNU `ls` tie-break to the *oldest*
  round. Reproduced on both. The next cloud run of this swarm on PR #8 will
  report the 18:10 rejection as current.

Each is a few characters to repair — `set -eu` plus a `-s` check, a
`tail`-scoped verdict match, and `sort | tail -1` instead of `ls -t | head -1`.
I am not repairing them: `AGENTS.md` forbids editing a gate that judges my own
work, and this gate judges this review.

`ops/reviews/20260827-1815-pr8-history.md` (H1) argues on separate grounds that
this file should not be in this PR at all. I take no position on where it lands.
Wherever it lands, it should not land in this state.

M8 and M9 are recorded for the next assess and do not block.

REVIEW_FAILED
