# PR #8 — maintainability review (round four)

**PR:** `WP-4 — flows check preflight (covenant 2)`
· branch `flow/drive-57e923c-08271542` · <https://github.com/AgentWorkforce/flows/pull/8>
**Lens:** maintainability — could a stranger read this in six months and change it safely?
**Reviewer:** independent maintainability lens (Claude)
**Date:** 2026-08-27 18:57
**Reviewed at:** `3d9b9cea191958c60fa55647a3f0a22e5c6480ba` (`WP-5: close boundary parity review findings`)

---

## 1. What I read and what I ran

Read first, as instructed: `AGENTS.md`, `docs/RFC-0001-everything-is-a-relayflow.md`
(covenants 1 and 2, gate 1's done-when, settled decisions #13/#14, Appendix A).

Then `/tmp/pr-8.diff` (52 files) and the working tree for everything it touches:
`sdk/src/preflight.ts`, `sdk/src/cli.ts`, `sdk/src/failure-kinds.ts`,
`sdk/src/compile.ts`, `sdk/src/spec.ts`, `sdk/src/validate.ts`, `sdk/src/index.ts`,
`sdk/tests/{cli,preflight,spec-parity,validate}.test.ts`,
`kernel/relayflowd-core/src/spec.rs` and its tests, every fixture under
`testdata/preflight/`, `testdata/flows.json`, `docs/SURFACE.md`, and
`workflows/review-swarm.yaml`.

**Executed, not inferred** (all commands run by me at the commit above):

| What | Result |
|---|---|
| `cd sdk && npm test` (`tsc --noEmit && vitest run`) | **110 passed, 0 failed**, 7 files |
| `cd kernel && cargo test --workspace` | **72 passed, 0 failed** across 9 suites |
| `cd kernel && cargo clippy --workspace -- -D warnings` | exit 0 |
| `cd kernel && cargo fmt --check` | exit 0 |
| 4 live experiments against the real CLI (§3, §4) | see findings |
| 2 source mutations, each reverted and `git status`-verified clean | see F2, F3 |

> Environment note, not a finding against this PR: `~/.cargo/registry` is a symlink
> into an unmounted volume, so the Rust half was run under
> `CARGO_HOME=/tmp/cargo-review-home`. Same override the round-three transcript
> records. Anyone reproducing needs it.

I read the prior PR #8 transcripts *after* forming my own findings. §6 records
what round three left open and what WP-5 actually closed. **F1–F5 below are new
or newly measured; none is a restatement.**

---

## 2. Verdict in one line

Round three's two blockers are genuinely closed, with tests — but the surface
this PR exists to deliver still answers one realistic, natural repository layout
with a **refusal whose message is false**, and the rule that produces it is
written down nowhere while being load-bearing in this PR's own fixtures. One
blocking finding; four non-blocking, two of them demonstrated by mutation.

---

## 3. Blocking finding

### F1 — the project-config rung is an unbounded upward filesystem walk with nearest-wins-no-merge semantics; the rule is undocumented, it silently changes verdicts, and when it bites, `flows check` tells the author something untrue

**Blocking. Demonstrated three ways, live.**

`cli.ts:147-161`:

```ts
function findConfig(start: string): string | undefined {
  let directory = start;
  while (true) {
    const candidate = join(directory, 'flows.json');
    try { accessSync(candidate, constants.R_OK); return candidate; }
    catch { /* Continue toward the filesystem root. */ }
    const parent = dirname(directory);
    if (parent === directory || directory === parsePath(directory).root) return undefined;
    directory = parent;
  }
}
```

The **first** `flows.json` found on the way to `/` becomes *the whole* project
config. There is no merge, no stop at a repo boundary, no bound on the ascent,
and no record of which file won.

**Experiment 1 — the config can come from arbitrarily far away, invisibly.**
A flow three directories below a `flows.json` it has never heard of:

```
/tmp/mrev/flows.json          {"cli": "./authenticated-cli", "executors": ["ambient-worker"]}
/tmp/mrev/a/b/c/flow.yaml     llm step, no cli; trigger executor: ambient-worker
```

```
$ flows check /tmp/mrev/a/b/c/flow.yaml
RESOLVED step "answer" cli "./authenticated-cli" from project
CHECK PASSED /tmp/mrev/a/b/c/flow.yaml            (exit 0)
```

Both the CLI *and* the executor registration that made this flow provable came
from a file the output never names. `--json` is no better: the report carries
`source: "project"` and no path. Covenant 2's promise is *"you are told exactly
who you hired before the run starts"* (`SURFACE.md:78`). The author is told the
rung, not the hire.

**Experiment 2 — a nearer partial config silently deletes the outer one, and the
refusal message denies a CLI that exists.** Add a nested config declaring only
executors — the natural layout when a repo root holds the CLI default and a
subdirectory registers its own workers:

```
/tmp/mrev/flows.json          {"cli": "./authenticated-cli", "executors": ["ambient-worker"]}
/tmp/mrev/a/b/flows.json      {"executors": ["ambient-worker"]}
```

```
$ flows check --json /tmp/mrev/a/b/c/flow.yaml
REFUSED [cli_unresolved] Step "answer" has no CLI at step, flow, or project level.
{"ok":false,…,"diagnostics":[{"severity":"refusal","kind":"cli_unresolved",…}]}   (exit 2)
```

There **is** a CLI at project level. It is in `/tmp/mrev/flows.json`, it is
executable, and it passes its auth probe. The message states the opposite. RFC
covenant 1: *"Error messages name the author's mistake in the author's
vocabulary, never engine internals."* This message names a mistake the author did
not make, and gives them nothing to act on — the actual cause (a nearer
`flows.json` shadowed the outer one wholesale) appears in no output, no doc, and
no comment. A valid flow is refused, which is covenant 2 running backwards: the
engine refused something it *could* have proven.

**Experiment 3 — this PR's own fixture suite depends on the unwritten rule.**
`testdata/flows.json` declares `{"cli": "./preflight/authenticated-cli"}`.
`testdata/preflight/flows.json` declares `{"executors": ["fixture-executor"]}` and
no `cli`. `cli-unresolved.flow.yaml` refuses *only* because the nested config
shadows the parent's CLI. Merge the two configs — the obvious tidy-up for someone
consolidating fixtures — and:

```
$ flows check ../testdata/preflight/cli-unresolved.flow.yaml     # before
REFUSED [cli_unresolved] Step "answer" has no CLI at step, flow, or project level.   (exit 2)

# after adding "cli" to testdata/preflight/flows.json:
RESOLVED step "answer" cli "./authenticated-cli" from project
CHECK PASSED ../testdata/preflight/cli-unresolved.flow.yaml                          (exit 0)
```

(Restored; `git status testdata/` clean.) A fixture named for the thing it proves
stops proving it, and the failure surfaces as `cli.test.ts:80` expecting exit 2
and getting 0 — a test failure pointing at the CLI, not at the fixture config that
actually changed.

**Why this is the blocking one.** AGENTS.md and the RFC both make this class
gate-blocking on its own terms: *"Authoring friction is a gate-blocking defect,
not a docs problem"* and *"error messages name the author's mistake."* Every other
resolution rule in this PR was written down — `SURFACE.md:80` spells out
step-vs-flow-vs-project path resolution and `PATH` lookup for bare names, which is
exactly the standard being applied here. The `flows.json` **discovery** rule (walk
up, unbounded; nearest wins whole; no merge) and the file's own schema (`cli`,
`executors`, both optional) are the one part of the contract that exists only in
`readProjectConfig`'s implementation. A stranger in six months debugging
"passes on my laptop, refuses in CI" has no thread to pull.

**Fix (small, three parts).**

1. Put the config path in the report: `ProjectConfig` already carries `directory`;
   add `configPath` to `CheckReport` and print it (`RESOLVED … from project
   (<path>)`). This is the single change that makes all three experiments
   self-explaining, and it also closes the carried M3/F5 half.
2. Make the `cli_unresolved` message name what it searched:
   `… no CLI at step, flow, or project level (project config: <path>, which
   declares no cli)` — or `(no flows.json found above <dir>)` when the walk found
   nothing.
3. One paragraph in `SURFACE.md` §78 stating the discovery rule and the
   nearest-wins-no-merge decision, next to the resolution law it completes. If
   nearest-wins-whole is deliberate, say so there and say why; if merging up is
   wanted, that is a different (larger) change and should not be smuggled in now.

A test that pins the shadowing behavior — parent declares `cli`, child declares
only `executors` — would keep whichever semantics you choose from drifting again.

---

## 4. Non-blocking findings

### F2 — the `--json` contract has no test that pins its shape: I renamed a top-level field and all 110 tests stayed green

Round three filed this as a style gap (F5: `CheckReport` is not exported). It is
measurably worse than that. I renamed `CheckReport.resolutions` → `resolved`
throughout `cli.ts` — the exact break an external CI consumer would suffer — and:

```
Test Files  7 passed (7)
     Tests  110 passed (110)
```

(Mutation reverted; `git status sdk/src/cli.ts` clean.)

`--json` exists specifically so a machine can parse the report (`cli.ts:54-55`),
and `emitReport` carefully keeps stdout clean for that reason. But the only thing
touching the shape is an inline cast in a test:

```ts
// cli.test.ts:131
const report = JSON.parse(result.stdout.join('\n')) as { diagnostics: Array<{ kind: string }> };
```

which reaches one nested field and asserts nothing about the top level.
`CheckReport` (`cli.ts:23-28`) is still non-exported; `index.ts` exports every
diagnostic type and three of the four kind constants — but not the envelope those
diagnostics arrive in, and not `CHECK_INPUT_FAILURE_KINDS`, so a consumer cannot
distinguish an input refusal from a preflight refusal through the public API even
though the SDK's own test imports exactly that constant to do so.

**Fix.** Export `CheckReport` from `cli.ts` and re-export it (plus
`CHECK_INPUT_FAILURE_KINDS`) from `index.ts`; assert the full top-level key set
in one test — `expect(Object.keys(report).sort()).toEqual([...])` — so the field
rename I just performed fails loudly.

### F3 — `validateKernelRetry`'s range guard cannot change any accept/reject decision; deleting it entirely leaves the suite green

`compile.ts` (WP-5's fix for round-three F2) validates a compiled retry policy
twice: a range guard, then an equality check against `KERNEL_RETRY_DEFAULTS`.

```ts
if (![initial, maximum, multiplier, jitter].every(isNonNegativeInteger)
  || (multiplier as number) === 0 || (jitter as number) > 100
  || (maximum as number) < (initial as number)) {
  throw new CompileError(['compiled spec contains an invalid retry policy']);
}
for (const [field, expected] of Object.entries(KERNEL_RETRY_DEFAULTS)) {
  if (retry[field] !== expected) { throw new CompileError([`… retry.${field} must equal the authoring default ${expected}`]); }
}
```

The second loop accepts exactly one policy: the defaults. The defaults pass the
range guard. Therefore **no input exists that the range guard rejects and the
defaults loop would accept** — it can only change which message a
already-doomed spec receives. Verified by deletion (replaced the whole `if` with
`void`s): **110 passed, 0 failed.** (Reverted; `git status` clean.)

The equality check is the right fail-closed call and I would keep it. The range
guard is speculative machinery for a configurability the dialect does not have —
AGENTS.md rule 6, *"No dead code, no speculative abstraction. Build what the
current gate needs."* Worse for a reader: a stranger sees a general-looking
bounds validator and concludes retry policies are tunable within limits. They are
not; exactly one is legal.

Related, same lines: `cli.test.ts:177` is titled *"rejects malformed compiled
retry policies instead of trusting them"* and sets `multiplier = 0` — the range
guard's signature case. It passes with the range guard deleted, because the
defaults loop catches it first. The test's name describes a guard its assertion
cannot distinguish from the other one.

**Fix.** Delete the range guard and let the equality check own the refusal, or —
if the intent is a better message for a garbled policy — assert the *specific*
message in the test so the two paths are told apart.

### F4 — two assertions in the new tests cannot fail

Both sit in tests that are otherwise excellent, which is what makes them worth
naming: they read as extra safety and supply none.

- `preflight.test.ts:121` — `expect(refusalKinds).not.toContain('unknown')`,
  two lines after `expect(new Set(refusalKinds)).toEqual(new Set(PREFLIGHT_FAILURE_KINDS))`.
  `'unknown'` is not in that union, so line 119 passing makes line 121
  unfalsifiable. The comment directly above (102-106) already explains, correctly
  and honestly, that the converse is held by the typed union plus `tsc --noEmit`.
  The assertion adds a second, weaker claim to a paragraph that got it right.
- `cli.test.ts:236` —
  `expect(new Set([...CHECK_INPUT_FAILURE_KINDS, ...PREFLIGHT_FAILURE_KINDS])).toEqual(new Set(CHECK_FAILURE_KINDS))`.
  `failure-kinds.ts:18-21` *defines* `CHECK_FAILURE_KINDS` as that spread. This
  asserts a definition against itself.

Neither is harmful today; both are the kind of line that makes the next reader
trust a suite slightly more than it has earned. Delete them.

### F5 — the swarm's new `reviewed-head` contract is triplicated prose enforced by a grep, with no test, and it is already not being honored

WP-5's fix for round-three F4 is the right mechanism: each lens stamps
`reviewed-head: <oid>` and the aggregate refuses a transcript that names a
different commit (`review-swarm.yaml:176`). Two maintainability problems with how
it is expressed.

**It is stated three times, in prose, inside three agent prompts.** Lines 77-87,
106-116, and 134-144 are near-identical eighteen-line blocks: set `TRANSCRIPT`,
write, end with the verdict token, stamp `reviewed-head`, `git add`,
`git commit --only`, confirm with `git cat-file -e`. The aggregate parses all five
of those conventions. Change any one — the token, the stamp format, the filename
pattern — and a maintainer must make the identical edit in three places or the
aggregate silently fails whichever lens they missed, reporting
`SWARM_FAILED: <lens> reviewed a different commit` for a lens that reviewed the
right commit. There is no test over this workflow at all; `flows check` cannot
help, since `review-swarm.yaml` is a previous-generation `version: '1.0'` spec
(legitimately so, per RFC §2 rule 1) and no schema covers it.

**It has already drifted, within one round.** At the commit I reviewed:

- `/tmp/pr-8.head` does not exist, so `aggregate` would stop at its first check
  (`SWARM_FAILED: fetched PR head is missing`) regardless of any lens's verdict;
- `ops/reviews/20260827-1852-pr8-structure.md` — the newest transcript in the
  tree, written after WP-5 landed — contains no `reviewed-head:` line and is not
  committed;
- the task text I was handed for *this* review contains neither the
  `reviewed-head` stamp instruction nor the `git commit`/`git cat-file` steps that
  `review-swarm.yaml:77-87` specifies. I was asked to `git add` only.

I record that last point as an observation, not an accusation — I can see what I
was given, not why. But the pattern is consistent: the file is not the thing being
executed, so a contract that lives only in that file's prose will keep drifting
away from the aggregate that enforces it.

**Fix.** Hoist the shared block into one place the three lenses reference (a
`REVIEW-PROTOCOL.md` the prompts point at, or a single `persist-transcript` helper
step), so the contract has one definition. Secondary, cheap: `verdict=$(tail -n 1 "$f")`
means a single trailing blank line turns a `REVIEW_PASSED` into
`SWARM_FAILED: … carries no verdict`. It fails closed, so it is not a defect —
but `tail -n 5 | grep -Fx` would spare a future round a confusing red.

---

## 5. Carried and still open

### C1 — `probe_failed` is the only refusal kind whose real producer is never exercised, and two of the three probes cannot produce it at all

Filed in rounds one, two, and three; still true, and there is a sharper way to
say it. Every `probe_failed` in the suite comes from a probe injected to throw
(`preflight.test.ts:113`). Through the real CLI, `systemProbes` (`cli.ts:163-169`)
gives three implementations, and **only one can throw**:

- `cli` → `probeCli`, which throws when `spawnSync` sets `result.error` (10 s
  timeout, `EACCES`) — reachable, untested end-to-end;
- `executor` → `config.executors.includes(...)` — an array lookup; **cannot throw**;
- `command` → `executableExists` → `accessSync` in a `try`/`catch` plus
  `spawnSync`, which returns errors rather than throwing — **cannot throw**.

So `probeTrigger`'s catch arm (`preflight.ts:146-154`) and
`warnOnUnprovableEffects`' catch arm (`preflight.ts:194-201`) are unreachable
through the shipped CLI. They are defensible as part of the injected-probe
contract — a different host may well throw — but nothing says that, and AGENTS.md
rule 6 argues the other way. One sentence on `PreflightProbes` (`preflight.ts:20`)
stating that a probe *may* throw and that a throw is `probe_failed`/warning would
convert three unreachable branches into a documented interface obligation. A
hanging fixture (`#!/bin/sh` + `sleep 30`) with a shortened timeout would close
the `cli` half for real.

### C2 — `SURFACE.md:80` promises a message the code does not emit

The new Preflightable-CLI paragraph is one of the best things in this PR (§7), but
its last clause overreaches: *"A CLI that does not implement `auth status` is
refused as unauthenticated rather than assumed healthy, so **the operator is told
to add the subcommand** instead of discovering it at minute 27."*

The operator is told:

```
REFUSED [cli_unauthenticated] Step "answer" declares CLI "x", but its auth probe failed.
```

No mention of `auth status`, of the required exit code, or of adding anything. For
the case the doc singles out — a CLI with no `auth` subcommand at all — the
message points the author at their credentials, which are fine, instead of at the
missing subcommand, which is the actual mistake. Naming the probe in the message
(`… its "x auth status" probe exited non-zero`) makes the sentence true and costs
one string.

### C3 — the resolved CLI is computed, printed, and discarded

`PreflightResult.resolutions` is the answer to "who did we hire". It goes to
stdout and nowhere else: it is not journaled, and nothing forwards it to the
worker that will execute the step (`triggers` and the spec `cli` field are read
nowhere in the kernel outside `spec.rs` — verified by grep). That is correct for
gate 1 under AGENTS.md rule 6, and `spec.rs:32-37`'s comments say the fields are
inert. But `spec.ts:126` describes step `cli` to the *author* as *"Agent CLI
selected for this step"*, which reads as runtime selection. One clause — "resolved
and checked at preflight; gate 1 does not yet dispatch on it" — at the two type
declarations would keep the next reader from looking for the dispatch path.

---

## 6. What WP-5 actually closed — verified, not taken on trust

Round three's two blockers are properly closed. I re-derived both rather than
reading the commit message.

- **F1 (`triggers: []` hash divergence).** `compile.ts` now guards with
  `...(flow.triggers?.length ? …)` in **both** `compileSpec` and `toKernelSpec`,
  matching the `surfaces` guard the round-three transcript pointed at. The
  property is now *tested*, not assumed: `spec-parity.test.ts:47-54` appends
  `triggers: []` to the real ladder fixture and asserts the normalized flow, the
  round-trip, the canonical JSON, **and** the pinned `spec_hash` all match the
  no-triggers artifact. That is the fixture round three asked for.
- **F2 (silent retry loss).** `validateKernelRetry` now refuses any policy that is
  not `KERNEL_RETRY_DEFAULTS`, and the doc comment was corrected to state its real
  domain — *"the inverse of `toKernelSpec` over specs this compiler emits. Kernel-only
  values with no authoring representation are refused."* `spec-parity.test.ts:56-61`
  pins the refusal by field name. The silent fallback is gone; only F3 above (the
  now-redundant range guard) is left behind by the fix.
- **F3 (dialect sniff).** `isKernelSpec` now sniffs five kernel-only keys instead
  of two and carries a comment saying why (`cli.ts:228-233`), with a test that
  strips `depends_on`/`max_iterations` from a compiled spec and still routes it
  correctly (`cli.test.ts:142-160`). Materially better. The residue is that a
  hand-written kernel spec carrying none of the five is still read as authoring
  — but every one of those five is a kernel key with a serde default, so such a
  spec is byte-identical to a valid authoring spec and compiles the same either
  way. I could not construct a misroute that changes the outcome. Closed.
- **F4 (stale transcripts).** The `reviewed-head` mechanism is exactly the fix
  proposed. Its expression is F5 above; the mechanism itself is right.

**Checked and clear — I went looking and found nothing wrong:**

- The `/bin/sh -c` justification in `preflight.ts:167-174` still matches
  `exec_det.rs`, and the three-state warning invariant in `failure-kinds.ts:23-28`
  is genuinely closed *and* genuinely tested — `preflight.test.ts:75-85` drives all
  three states with `toEqual` on the full diagnostic array, so an extra or missing
  warning fails the test. Comment and test agree; this is the standard.
- The induced-fault control (`cli.test.ts:88-96`) remains the best test-design
  decision in the PR: relocated-but-unmutated ladder flows are asserted to still
  pass, so the twelve induced-fault refusals cannot be an artifact of the temp
  directory.
- Exit-code and stream discipline is uniform (0 pass / 2 refuse; diagnostics to
  stderr, JSON alone to stdout; `--json` honoured even when the invocation itself
  failed).
- Version pinning is consistent across the boundary: `SPEC_SCHEMA_VERSION = '0.1.0'`
  (`spec.ts:175`) and `SPEC_VERSION = "0.1.0"` (`spec.rs:21`), both exact-match. A
  one-version window is narrower than RFC §7's eventual policy, but §7 is explicitly
  open and gate 1 needs no window.
- `preflight.ts` is still 221 lines, one purpose, zero I/O. `validate.ts` at 454
  lines is the only file near AGENTS.md's 500-line smell; this PR added 40 of them.

---

## 7. What is genuinely good here

Worth recording so the next author copies it rather than regressing it.

`preflight.ts` remains the module this repo should be measured against, and the
reason is one comment: *"Environment facts are injected; this module performs no
I/O."* Every environment fact enters through three predicates, which is why the
unit tests drive all five refusal kinds and all three warning kinds without
touching a filesystem, and why `cli.ts` gets to be a thin composition root owning
`spawnSync`/`accessSync` and nothing else. AGENTS.md rule 2 applied on the SDK
side, where the rule does not formally reach.

The failure taxonomy is a closed `as const` union split into two honestly-named
halves, with the whole derived rather than restated — adding a kind is one edit
and `tsc` finds every site. And `cli.test.ts:216-239` is the test I would most
want kept: it drives all four input-refusal paths through the real CLI, asserts
the produced kinds equal `CHECK_INPUT_FAILURE_KINDS` **as a set**, and asserts no
`SyntaxError` leaks.

WP-5 also did the thing this lens most wants to reward: it took round three's
"the round-trip is lossless" claim, found it false, made it true by *narrowing the
contract* rather than widening the code, and corrected the doc comment to say what
the function actually does. That is the right instinct, and F3 above is only the
scaffolding it forgot to take down.

Finally, `SURFACE.md`'s new paragraphs volunteer two things against their own
code — that the platform-default rung is declared but unimplemented, and that
preflight *never* sends a prompt or spends a token. Docs that tell on themselves
are how a stranger stays oriented in six months. F1 is a request to extend exactly
that habit one rung further down, to `flows.json` discovery.

---

## 8. Verdict rationale

**F1 blocks.** A repository laid out the obvious way — CLI default at the root,
executors registered per area — gets a valid flow refused, with a message
asserting there is no project CLI while one sits two directories up, executable
and authenticated. The rule that causes it is in no doc, no comment, and no test,
yet it is load-bearing in this PR's own fixtures: I flipped `cli-unresolved.flow.yaml`
from refuse to pass by tidying a fixture config. RFC covenant 1 makes a message
that names a mistake the author did not make a gate-blocking defect, and covenant 2
is about refusing only what cannot be proven — this refuses what *was* proven, one
directory further up. The fix is small and mechanical: name the config path in the
report, say what the walk found in the message, and write the discovery rule next
to the resolution law that already documents its sibling.

Everything in §4 and §5 should be filed and none of it needs to block. F2 and F3
are each a few lines and are now backed by mutation evidence rather than reading.

This is a strong PR — the round-three blockers were closed properly, with the
fixtures the reviewer asked for, and the preflight module is the best-factored
code in this repo. The gap is the same shape it was last round, one layer down:
the pure predicate module got the care, and the code that feeds it environment
still has a rule nobody wrote down.

reviewed-head: 3d9b9cea191958c60fa55647a3f0a22e5c6480ba

REVIEW_FAILED
