# NEXT — single highest-priority work package

**Tick:** assess at `45cc352` (2026-08-27, ~17:55 local / 21:55Z)
**Gate:** 1 — a relayflow can run (RFC-0001 §3). Clause 1 (the hello ladder)
is closed on `main`. Clause 2 (`flows check` preflight, covenant 2) is
implemented **on PR #8's branch and blocked in review**.

---

## WP-5 — clear the review swarm's rejection of PR #8

### Why this package and not new work

`ops/DIRECTIVES.md` carries no unsatisfied standing directive. Its only
historical directive (stay lean — de-vendor kernel deps) was satisfied and
removed by PR #3 (`0ba6c88`); the file is now a header with no entries. So the
package comes from the gate, and the gate's rule is the run contract's: **no
new work over unfinished work.**

PR #8 (`WP-4 — flows check preflight (covenant 2)`, branch
`flow/drive-57e923c-08271542`, OPEN, MERGEABLE) is unfinished. It is the only
open PR, and on 2026-08-27T21:48Z the first run of `workflows/review-swarm.yaml`
posted **SWARM_FAILED — 2 of 3 lenses reject**:

| Lens | Model | Verdict |
|---|---|---|
| structure | opencode | PASSED |
| history | codex | **FAILED** — 4 findings |
| maintainability | claude | **FAILED** |

The PR comment ends: *"PR stays blocked. The next drive tick takes these
findings as its package."* This is that tick.

Do not be misled by the PR body's "Third adversarial review → REVIEW_PASSED"
or by the two green status checks. Both bot checks are known-empty signal on
this very PR (CodeRabbit rate-limited into skipping, Devin's trial expired) —
that is the documented reason the swarm exists (`73bdb59`, `09f6dd5`). The
swarm is the review of record and it says no.

### Objective

Bring PR #8 to a state where `workflows/review-swarm.yaml` returns
**SWARM_PASSED with three persisted, committed transcripts**, without widening
gate 1's done-when and without rewriting the branch's history.

### Retry correction after the timed-out build — controls over earlier text

The independent, `main`-owned review of `c8c15a0` produced three staged
transcripts at 19:21–19:24: history and structure passed; maintainability
failed on M1–M3. Preserve and commit those transcripts as rejection evidence.
The following directions supersede conflicting F0 instructions later in this
file for this retry:

1. **Do not ship a change to `workflows/review-swarm.yaml` in PR #8.** The
   maintainability lens correctly applied the rail that a branch cannot edit
   the gate judging that branch. Restore that file to `origin/main` here; land
   the durability hardening separately, judged by the pre-change swarm.
2. **Use the immutable `origin/main` workflow for PR #8's final verdict.** Its
   reviewers stage evidence. Commit each transcript explicitly after the run,
   without staging or committing product files with it. This preserves this
   run's evidence without making PR #8 its own judge.
3. **Close M2 and M3 before re-review.** State honestly that `flows check`
   performs preflight while direct `run.start` does not, both in the inert
   kernel field comment and `docs/SURFACE.md`. Make kernel-dialect conversion
   errors name the dialect marker, object path, and unknown key; pin the mixed
   `timeoutMs` + `depends_on` case through the real CLI.

The timed-out worker already left localized M2/M3 repairs in the working tree
and the three rejected transcripts staged. Verify and finish those changes;
do not repeat the five completed review rounds. The final review must bind to
the new PR head and all three lenses must pass honestly.

---

## The findings, independently verified by this assess

I re-derived each finding from the diff rather than taking the swarm's word.
This matters because **the swarm's own transcripts no longer exist** (F0).

### F0 — P1 — the swarm's evidence was destroyed; an unpersisted verdict is not evidence

The PR comment cites `ops/reviews/20260827-1745-pr8-history.md` and
`ops/reviews/20260827-1745-pr8-maintainability.md`. Neither file exists — not in
the working tree, not on `main`, not on `pr8-head`, not in any branch
(`git log --all --diff-filter=A -- 'ops/reviews/*1745*'` → empty).

Root cause, from the reflog: each lens step is told to write its transcript and
`git add` it (`workflows/review-swarm.yaml`, all three lens tasks) — **stage,
never commit**. The swarm ran ~17:45–17:48 local; the reflog then shows
`HEAD@{4}` and `HEAD@{2}` both `reset: moving to origin/main`. A hard reset
discards staged-but-uncommitted files. `ops/reviews/` has an mtime of 17:50 and
contains nothing newer than `20260827-1531`.

This violates the aggregate step's own stated rule, in the same file:

> `# A missing transcript is a refusal too: an unpersisted verdict is not evidence.`

The aggregate correctly fails on a missing transcript, but nothing makes the
transcript durable in the first place. Fix the workflow so each lens **commits**
its transcript, not merely stages it.

### F1 — P1 — `flows check` passes specs the kernel refuses, and refuses specs the kernel accepts

The covenant-2 promise is refusal at submit, never at minute 27. On PR #8 it
breaks in **both** directions. Verified at `pr8-head`:

- **False green.** `kernel/relayflowd-core/src/spec.rs:63-66` —
  `if self.version != SPEC_VERSION { return Err(SpecError::UnsupportedVersion(..)) }`
  with `SPEC_VERSION = "0.1.0"` (`spec.rs:21`). `sdk/src/validate.ts:100-104`
  accepts **any** semver-shaped string. So `version: 9.9.9` prints
  `CHECK PASSED`, and the kernel then rejects the run.
- **False red.** `RunSpec.name` is `Option<String>` (`spec.rs:29-30`) — optional
  to the kernel. `sdk/src/validate.ts:106-108` hard-fails a spec without a
  non-empty `name`. So `flows check` refuses a spec the kernel would accept.

The PR body admits this ("P2 is genuine and remains unfixed here") and files it
to the backlog as a follow-up. That triage is what the history lens rejects, and
it is right to: gate 1's done-when says *"the failure taxonomy is closed — every
failed run's journal terminates in a declared failure kind."* A preflight that
green-lights a spec the kernel will refuse leaves the failure taxonomy open at
exactly the seam preflight exists to close. **This is inside clause 2, not
after it.**

### F2 — P1 — a settled decision was silently deleted, not deferred

`git diff main...pr8-head -- docs/SURFACE.md` narrows the **anonymous
resolution law** from four rungs to three:

```
- ... step options → flow header → project config (`flows.json`) → platform default.
+ ... step options → flow header → project config (`flows.json`). Resolution stops
+ there: a platform may provision an explicit project default, but `flows check`
+ never invents an implicit one.
```

`docs/SURFACE.md` records decisions settled earlier the same day. The
implementation was written to refuse when the three rungs miss, and then the law
was edited down to match the implementation. The PR body relegates this to
"Human follow-up 1: Confirm `docs/SURFACE.md:78` intentionally abandons, rather
than defers, the anonymous 'platform default' rung" — i.e. it ships the change
to a settled decision and asks for permission afterwards. The charter is
explicit: the Lead encodes and enforces the constitution and never contradicts
it; changing it is Khaliq's decision, proposed by PR.

The fix does **not** require a human decision, because a correct option exists
that changes no law: state the rung as **deferred, unimplemented** rather than
deleting it. The behavior (refuse with `cli_unresolved`) stays exactly as built.

### F3 — P2 — a recorded design-partner priority was overridden without evidence

`ops/SCOREBOARD.md`, gate 6:

```
- | 6 — integrations via relayfile | RED | **next up** — harness (design partner)
-   needs slack/notion helpers; also unblocks its `REPLACE-WHEN: gate-2` shims |
+ | 6 — integrations via relayfile | RED | eligible after gate 1; the next assess
+   chooses among gates 2 and 5–8 from current evidence |
```

and the branch's `ops/BACKLOG.md` adds a preamble instructing the next assess
*"not [to inherit] the old gate-6 'next up' annotation as a commitment."*

`ops/BACKLOG.md` on `main` records the countervailing fact: *"Customer harness
is a named design partner (`sales/harness`) — its filed requirements rank gate
work,"* naming slack/notion helpers (gate 6) among its first asks. Charter duty 4
requires tracking design-partner evidence. A preflight PR is not the place to
demote a design partner's filed requirement, and no evidence was offered for the
demotion. Restore it; if the Lead wants to re-rank the gates, that is its own
package with its own argument.

### F4 — P3 — the commit history repeats an already-recorded defect

`823e35a` — `` drive: WP-4 — `flows check` preflight (cove `` — is the truncated
commit subject that `ops/DRIVE-LOG.md` diagnosed in tick 5 (a byte-wise
`cut -c1-60` across a multibyte em-dash in `workflows/drive.yaml`'s `pr` step).
The generator was fixed on `main` in `73bdb59`, after this commit was written.

**Do not force-push to repair this.** The PR body states as fact that no rebase,
squash, force-push, or history rewrite occurred, and reviewers have triaged
against that claim. The honest close is a note in the PR body pointing at
`73bdb59` as the landed guard, plus the regression test named in the DoD below.

### F5 — P2 — the dialect converter has no round-trip test

The maintainability lens's quotable ask: *"the cheapest guard that would have
caught this class: a round-trip test asserting `kernelToAuthoring(toKernelSpec(flow))`
structurally equals `flow`."*

Verified: `toKernelSpec` is exported from `sdk/src/compile.ts:144`, but
`kernelToAuthoring` is a **private function inside the CLI**
(`sdk/src/cli.ts:231`, used at `cli.ts:111`). The two halves of one bijection
live in different modules and only one is testable. Move `kernelToAuthoring`
next to its inverse in `compile.ts`, export it, and pin the round trip.

---

## Files in scope

| File | Change |
|---|---|
| `workflows/review-swarm.yaml` | F0 — each lens **commits** its transcript (not just `git add`); aggregate keeps failing on a missing or verdict-less transcript |
| `ops/reviews/20260827-*-pr8-*.md` | F0 — re-run the swarm; the three new transcripts are committed artifacts |
| `sdk/src/validate.ts` | F1 — version must equal `SPEC_SCHEMA_VERSION`; `name` becomes optional, matching `RunSpec.name: Option<String>` |
| `sdk/src/compile.ts` | F5 — receives `kernelToAuthoring`, exported |
| `sdk/src/cli.ts` | F5 — imports it instead of defining it |
| `sdk/src/index.ts` | F5 — re-export if the test needs it |
| `sdk/tests/validate.test.ts` | F1 — both directions pinned |
| `sdk/tests/spec-parity.test.ts` | F5 — the round-trip property |
| `docs/SURFACE.md` | F2 — platform-default rung restored as *deferred*, wording below |
| `ops/SCOREBOARD.md` | F3 — gate-6 design-partner priority restored |
| `ops/BACKLOG.md` | F3 — drop the preamble that demotes it; F1 item drops the P2 half (now built), keeps the P1 deterministic-command half |
| `ops/DRIVE-LOG.md` | the tick entry: swarm verdict, F0 root cause, verify tails |
| PR #8 body | F4 note; replace the "third review PASSED" framing with the swarm result |

### Wording to use for F2 (`docs/SURFACE.md`)

Restore the four-rung law and mark the fourth rung's status honestly — the law
is unchanged, the implementation is disclosed:

> **Anonymous resolution law:** `f.agent\`task\`` with no name is the *default
> agent*, resolved (never guessed) in order: step options → flow header →
> project config (`flows.json`) → platform default. *The platform-default rung
> is declared but not yet implemented: no platform default is provisioned as of
> gate 1, so a flow that reaches this rung refuses with `cli_unresolved` rather
> than guessing. `flows check` never invents an implicit default.*

Keep the new **Preflightable-CLI contract** paragraph — it is additive and
consistent with the law.

---

## Definition of done

Every command run from the repo root unless noted. Paste verbatim tails.

**Prerequisite — check out the right branch.** The `sync` step cut this tick's
branch from `main`; PR #8 lives on `flow/drive-57e923c-08271542`. Fixes
committed anywhere else will not update the PR:

```
git fetch origin && git checkout flow/drive-57e923c-08271542
git log --oneline -1        # expect 3e403b6, the branch tip
```

1. **Kernel unaffected and green.**
   ```
   (cd kernel && ../ops/cargo.sh test --workspace)      # exit 0
   (cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings)   # exit 0
   (cd kernel && ../ops/cargo.sh fmt --check)           # exit 0, empty
   ```
   Baseline measured on `main` at `45cc352` this tick: **70 passed, 0 failed**
   (18 + 19 + 24 + 3 + 6; doc-tests 0 ×3), clippy clean, fmt clean. The branch
   adds 2 spec tests → expect **72**. No kernel source change is in scope, so a
   count other than 72 means something unintended moved.

2. **SDK builds and tests green, with the new guards.**
   ```
   (cd sdk && npm run build)   # exit 0
   (cd sdk && npm test)        # exit 0
   ```
   Branch baseline is 99 tests. Expect **≥ 103** — at least four new:
   - `version: '9.9.9'` → `validateSpec` **fails** (kernel dialect).
   - `version: '0.1.0'` → passes.
   - a spec with **no `name`** → passes (kernel treats `name` as optional).
   - `kernelToAuthoring(toKernelSpec(flow))` deep-equals `flow` for all three
     ladder flows in `testdata/`.

3. **F1 proven end to end through the real CLI**, not only in unit tests:
   ```
   printf 'version: "9.9.9"\nname: v\nsteps:\n  - id: s\n    type: deterministic\n    command: "true"\n' > /tmp/bad-version.flow.yaml
   node sdk/dist/cli.js check /tmp/bad-version.flow.yaml   # expect exit 2, refusal names the version
   ```
   And the seven behavioral cases already in the PR body still produce their
   recorded output (3 × `CHECK PASSED` exit 0, 4 × refusal exit 2).

4. **F2/F3 restored.** Both diffs read as restorations:
   ```
   git diff main...HEAD -- docs/SURFACE.md ops/SCOREBOARD.md
   ```
   `docs/SURFACE.md` shows the four-rung law with the deferral note (net: the
   Preflightable-CLI paragraph added, the law's rungs unchanged).
   `ops/SCOREBOARD.md` gate 6 again carries the harness design-partner text;
   gate 1 stays **AMBER** with its updated clause-2 evidence.

5. **F0 fixed and demonstrated.** `workflows/review-swarm.yaml` commits each
   transcript. Then re-run the swarm against PR #8 and show:
   ```
   echo 8 > .review-target
   # run workflows/review-swarm.yaml
   git log --oneline -5 -- ops/reviews/     # three new transcripts, committed
   ls ops/reviews/*-pr8-*.md                # maintainability, history, structure
   ```
   The aggregate step prints **SWARM_PASSED**. A lens that still rejects means
   this package is not done — iterate on the finding, do not re-run for a
   friendlier verdict.

6. **PR #8 updated honestly.** Body carries: the swarm verdict table (old
   SWARM_FAILED → new SWARM_PASSED), the F0 disclosure that the first swarm's
   transcripts were lost to a hard reset and what changed so it cannot recur,
   the F4 note pointing at `73bdb59`, and the verbatim tails from 1–3. The
   "third adversarial review → REVIEW_PASSED" claim is corrected in place
   (errata style, as this branch already does), not deleted. Bot check statuses
   are not cited as review evidence.

7. **`ops/DRIVE-LOG.md`** gains this tick's entry: the SWARM_FAILED verdict that
   set the package, F0's root cause with the reflog evidence, what was fixed,
   the verify tails, and the honest gate-1 state (AMBER until a human merges #8
   and it re-verifies on `main`).

---

## Explicitly OUT of scope this tick

- **Any new gate-1 feature, and any gate 2–9 work.** Clause 2 is written; this
  tick makes it landable.
- **The deterministic-command P1** (refuse a path-like command word containing
  `/` when the path does not exist; keep warning for bare words that may be
  shell builtins/functions/assignments). Stays a backlog item. F1 is in scope
  because it is a *dialect disagreement between check and kernel*; this one is a
  judgment call about shell resolution and needs its own package.
- **Force-push, rebase, squash, or any history rewrite of
  `flow/drive-57e923c-08271542`.** F4 is closed by disclosure plus the landed
  guard. The PR's no-rewrite claim must stay true.
- **Merging.** The Lead never merges (charter, hard rails). This ends at a PR a
  human can merge.
- **Re-ranking the gates / choosing the post-gate-1 package.** F3 restores the
  recorded priority; it does not settle what comes next. That is next tick's
  assess, after #8 merges.
- **`workflows/drive.yaml`'s `pr` step** beyond what `73bdb59` and `f59d9cd`
  already landed.
- **Registering or re-registering cloud schedules**, and the sandbox
  no-git-remote failure. Backlog.

---

## Traps this tick will hit if unwarned

1. **Wrong branch.** `sync` cuts from `main`. PR #8 is on
   `flow/drive-57e923c-08271542`. Check out that branch first (DoD prerequisite).
2. **Local `git diff main..HEAD` lies on this branch.** Use three-dot
   `main...HEAD` (merge base). Two-dot reports `ops/` files as deletions the
   branch never made — the same trap tick 5's log recorded for PR #7.
3. **Green bot checks are not review signal on this PR specifically.** Verified:
   CodeRabbit skipped (rate limit), Devin's trial expired. Both report SUCCESS.
4. **`git add` is not persistence.** That is F0's whole lesson. Anything a step
   produces as evidence must be committed in the same step, or a later
   `git reset --hard` erases it — which is exactly how this PR's blocking review
   was lost.

---

## Gate 1 state after this package

Still **AMBER**. Clause 1 closed on `main`. Clause 2 becomes repository state
only when a human merges PR #8; the gate flips to GREEN only after a fresh
verification run on merged `main`. This package does not flip the gate and must
not claim to.
