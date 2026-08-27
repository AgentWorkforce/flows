# NEXT — single highest-priority work package

Written by the Relayflow Lead on 2026-08-27 (assess tick on branch
`flow/drive-73bdb59-08271701`, HEAD = `73bdb59` = `origin/main`).

**Work package: WP-4-FIX — land PR #8 by clearing its standing
`REVIEW_FAILED`, reconciling it with `main`, and triaging its open bot
findings.** This is fix-the-open-PR work. No new gate work is permitted this
tick.

This file **supersedes** the WP-4-FIX package written by the two preceding
assess ticks (`git show 7189a63:ops/NEXT.md`, `git show 28e5892:ops/NEXT.md`,
both local-only and never pushed). Those ticks assessed and stopped; the
package was never executed. Three of its findings have since gone stale — see
"What changed since the last assess" below. Nothing in this file is inherited
on the earlier file's word.

---

## Assessment snapshot (evidence, gathered this tick)

### 1. Standing directives — checked first, per `ops/DIRECTIVES.md`

**No active directives.** `ops/DIRECTIVES.md` carries only its header. The one
directive it ever held (*stay lean — de-vendor kernel deps*, 2026-08-27) was
satisfied and removed by PR #3. Verified against the file's full history, not
its current text alone:

```
$ git log --oneline -- ops/DIRECTIVES.md
0ba6c88 flow/de vendor wrapper e715601 (#3)     <- removed directive 1 (satisfied)
45db231 ops: standing human directives ...      <- added directive 1
```

**But a human instruction of directive weight sits on PR #8 itself.** Khaliq,
in a PR comment (the most recent human word in this program):

> **BLOCKED — do not merge. The reviewer rejected this diff twice; the PR
> opened anyway.** … **Substantive blocker to clear before this merges**
> (reviewer's own words): `DRIVE-LOG.md` claims no independent review
> transcript was produced, while this same diff adds a 290-line REVIEW_FAILED
> transcript and a 252-line response to it … Also: re-run and re-quote the
> verify tails so the PR body carries executed evidence rather than superseded
> evidence. **Next tick picks this up as fix-the-open-PR work per the drive
> rule.**

That comment names this tick's package. It is honored ahead of the backlog and
ahead of gate selection.

### 2. Open PRs

| PR | Title | State (live, this tick) | Bearing |
|---|---|---|---|
| **#8** | WP-4 — `flows check` preflight (covenant 2) | **OPEN, `CONFLICTING` / `DIRTY`**, human-blocked, `reviewDecision: ""` | **This tick's work.** Standing adversarial verdict: `REVIEW_FAILED` (two rounds). |
| #6 | regressions: relaycast workspace-key repair answers an untyped 500 | OPEN, **draft** | Not this loop's work. It documents a `relaycast-cloud` defect no code in this repo can close. Prior ruling stands: a draft PR is not unfinished work for this loop. Out of scope. |

The drive rule — *never start new work over unfinished work* — binds. Gate
selection (gates 2 / 5 / 6) does **not** reopen until PR #8 merges or is closed
by a human.

### 3. What changed since the last assess (why that package is superseded)

- **The three operator commits are no longer dangling.** `8c10321`, `c6c3a8b`
  and `73bdb59` are now reachable — they are `main`'s last three commits. The
  earlier package's operator actions 1 and 2 are **done**; do not re-report
  them.
  - `main`'s `ops/SCOREBOARD.md` therefore already reads **AMBER** for gate 1,
    correctly. The branch's scoreboard edit is no longer a correction of `main`
    — it now only supplies branch evidence.
  - `workflows/drive.yaml` on `main` now has the **typed review verdict**
    (`c6c3a8b`): the review gate requires only that the reviewer *spoke*
    (`REVIEW_`), and a deterministic `verdict` step fails the run on
    `REVIEW_FAILED`, on a missing transcript, or on no verdict. **This tick
    must run against `main`'s `drive.yaml`, not the branch's** — the branch
    predates the fix and still carries the gate that let a PR open over a
    rejection.
  - `73bdb59` also fixed the `cut -c1-60` PR-title truncation and added the
    "a green bot check is not review signal" bar to `ops/RUN-CONTRACT.md` §3.
- **PR #8 became `CONFLICTING`.** It was `MERGEABLE` at the last assess.
  `main` moved three commits past the merge base `57e923c`. Verified with
  `git merge-tree --write-tree --name-only main origin/flow/drive-57e923c-08271542`:
  **exactly one conflicted file, `ops/SCOREBOARD.md`.** Nothing under `sdk/`,
  `kernel/` or `testdata/` conflicts.
- **The branch head advanced to `6a425b6`,** which answered **R1, R2 and R3 as
  append-only errata** and corrected `ops/SCOREBOARD.md`'s stale "SDK 95" to
  the measured 99. **R4 and R5 are still open**, and the round-2 review's
  primary demand — *a third review, and a PR body built from executed
  evidence* — is unmet.

### 4. PR #8 review state — read from transcripts, not inferred from tokens

Three persisted artifacts on `flow/drive-57e923c-08271542`:

- `ops/reviews/20260827-1611-review.md` — **REVIEW_FAILED**, three code
  findings: **F1** (HIGH) fail-open on an unprovable deterministic command;
  **F2** the covenant's literal subject (the *ladder* flows under induced
  fault) untested, substituted by stand-ins without disclosure; **F3** a
  self-certifying gate resting on a stub baked into the canonical gate-1
  artifacts and their hash pins.
- `ops/reviews/20260827-1620-wp4-fixes.md` — the repair, answering all three by
  changing code.
- `ops/reviews/20260827-1627-review.md` — **REVIEW_FAILED**, round 2. It
  re-executed every DoD command itself, confirmed F1/F2/F3 genuinely closed
  ("No code change is required"), and failed the package on the honesty of the
  **record**: R1–R5 below.

Outstanding findings, with status verified against the branch head this tick:

| # | Sev | Finding | Status at `6a425b6` |
|---|---|---|---|
| R1 | MED | `ops/DRIVE-LOG.md:516` — "no independent review transcript was produced" — denies two reviews in the same diff | **Errata appended**; the false sentence at `:516` is still unmarked in place |
| R2 | MED | `:494`/`:499` quote a **76**-test `npm test` tail as verbatim evidence from a superseded tree; measured is **99** | **Errata appended**; PR #8's body still ships the 76 tail as its evidence |
| R3 | MED | `:524` — "gate 1 is GREEN in this branch on both clauses" — contradicts the AMBER scoreboard in the same commit | **Errata appended**; sentence still unmarked in place |
| R4 | LOW | `:460` — "the three ladder canonical JSON/hash fixtures were regenerated" — describes a superseded tree; after the F3 repair all six canonical/`.sha256` files are byte-identical to `main` | **OPEN** — not in the errata list |
| R5 | LOW | `sdk/tests/cli.test.ts:57` — the `cli_unresolved` fault is `delete flow['cli']`, a no-op since the ladder YAMLs carry no `cli` key; the refusal actually comes from the relocated empty `flows.json` | **OPEN** — `delete flow['cli']` still present |

**A third review has not run. The verdict standing on the record is
`REVIEW_FAILED`,** and a verdict is not overturned by the party it was issued
against.

### 5. External bot findings — untriaged at HEAD

`ops/RUN-CONTRACT.md` §3 bar 2 requires every inline review comment triaged at
HEAD with a reply recording the audit. Two are open on PR #8, both from
`chatgpt-codex-connector`, both against `07edd60d` (the branch's *first*
commit, before the 16:20 repair):

- **P1 — `sdk/src/preflight.ts:181`, "Refuse deterministic steps whose
  executable is absent."** A deterministic command whose first word is
  confirmed absent yields `CHECK PASSED`; the kernel later fails the step with
  exit 127.
- **P2 — `sdk/src/cli.ts:112`, "Validate checked specs against the kernel
  dialect."** `flows check` accepts `version: 9.9.9`, which `RunSpec::validate`
  (`kernel/relayflowd-core/src/spec.rs:63-66`) rejects; conversely it can
  reject valid kernel specs that omit optional `name`.

Bar 1 also applies: CodeRabbit and Devin both report SUCCESS on this PR while
**neither reviewed** (CodeRabbit rate-limited into skipping; Devin's trial
expired). Neither may be cited as external review.

### 6. Tests on `main` — executed by the Lead this tick (hermetic `ops/cargo.sh`, no exported env)

| Command | Result |
|---|---|
| `cd kernel && ../ops/cargo.sh test --workspace` | **70 passed, 0 failed** (18 + 0 + 19 + 24 + 3 + 6; doc-tests 0 ×3), exit 0 |
| `cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings` | exit 0 |
| `cd kernel && ../ops/cargo.sh fmt --check` | exit 0, no output |
| `cd sdk && npm test` | **58 passed, 0 failed** (5 files), exit 0 |

These are `main`'s numbers, measured here, not quoted from the scoreboard. The
branch's claimed **72** kernel / **99** SDK are *branch* numbers; they were
executed twice (build phase and the round-2 reviewer) but **not by this
assess**, and this tick must re-measure them post-reconciliation rather than
inherit them.

### 7. Gate 1 does not hold — `ops/SCOREBOARD.md` is correct today

RFC-0001 §3 gate 1's done-when has two clauses. Clause 1 (the a/b/c ladder
surviving `kill -9` with exact budget accounting) is **closed on `main`** —
PRs #2, #4, #7. Clause 2 — **`flows check` preflight, covenant 2** — is
implemented **only on PR #8's branch** and is therefore not repository state.
Gate 1 stays **AMBER** until PR #8 merges. No sentence written this tick may
say otherwise, in any file, about any tree.

---

## Objective

Make PR #8 mergeable on its merits: **no false or superseded statement in the
ops record it ships**, **executed evidence in its PR body**, **no unmerged
conflict with `main`**, **every bot finding triaged at HEAD**, and a **third
adversarial review returning `REVIEW_PASSED`**.

The code under review is sound by two independent reviews. This package changes
the record, one dead test line, and the branch's relationship to `main`. It
does not change behavior.

## Branch and PR discipline

- Work **on `flow/drive-57e923c-08271542`** (PR #8's head, currently at
  `6a425b6` on `origin`). Check it out, commit there, push, **update PR #8 in
  place** (`gh pr edit 8 --body-file …`). Do **not** open PR #9.
- **Reconcile with `main` by merging, not rebasing:**
  `git merge origin/main` on the branch. No rebase, no squash, no force-push,
  no history rewrite — the two review transcripts and Khaliq's blocking comment
  reference this branch's commits by SHA, and rewriting them orphans the
  evidence trail.
  - The one conflict is `ops/SCOREBOARD.md`. **Resolution is ruled here, not
    left open:** gate 1's row stays **AMBER**, keeping `main`'s corrective
    parenthetical intact, and gains the preflight evidence the branch supplies.
    Every number in the resulting row must be one *measured on the merged
    tree* (DoD 3) — not `main`'s 70/58, not the branch's pre-merge 72/99.
- **Reply to Khaliq's blocking comment** on PR #8, at HEAD, point by point
  (`gh pr comment 8`). Never silently wave, never silently dismiss.
- **Do not merge.** Charter hard rail. `ops/RUN-CONTRACT.md` §2's AUTO-MERGE
  authority belongs to Khaliq's autonomous-actor persona, not to this loop.
- Run the tick against **`main`'s `workflows/drive.yaml`** (with the typed
  `verdict` step), so an honest `REVIEW_FAILED` stops the run instead of
  routing into a repair loop.

## Files in scope

- `ops/DRIVE-LOG.md` — in-place errata markers at the four sites (DoD 1), R4
  added to the round-2 errata list, plus this tick's own appended entry.
- `sdk/tests/cli.test.ts` — delete the dead `cli_unresolved` mutation (R5) and
  name the real fault source in its comment.
- `ops/SCOREBOARD.md` — conflict resolution only, per the ruling above. The
  AMBER state does not move.
- `ops/reviews/<timestamp>-review.md` — the third review transcript, committed.
- `ops/BACKLOG.md` — one new item for the two Codex findings (DoD 5).
- `ops/NEXT.md` — this file, carried onto the branch. The original WP-4 package
  text stays retrievable at `git show 823e35a:ops/NEXT.md`; the review
  transcripts' line references resolve against that revision.
- PR #8's body and comments (via `gh`, not files).

**No other file may change.** In particular: nothing under `sdk/src/` or
`kernel/`.

## Definition of done

**1. The record carries no unmarked falsehood.** `ops/DRIVE-LOG.md` is
append-only by its own stated discipline and the errata block already exists —
but a reader hitting line 516 must not meet a false sentence with no signal.
**Lead's ruling (a decision, not an open question):** keep the original text
byte-intact and annotate each site *in place* with a bracketed forward
pointer, e.g.

```
**Review:** no independent review transcript was produced.
[ERRATA R1 — false as of 823e35a; two review transcripts and a repair note are
committed in this same diff. See "WP-4 review round 2 + record correction".]
```

Required at four sites: `:460` (R4 — regenerated → in fact byte-identical to
`main`), `:494`/`:499` (R2 — the 76-test tail is pre-fix), `:516` (R1),
`:524` (R3). **R4 must also be added to the round-2 entry's errata list**,
which today covers only R1–R3. Verify:

```
grep -c "ERRATA" ops/DRIVE-LOG.md                 # >= 4
grep -n "R4" ops/DRIVE-LOG.md                     # R4 present in the errata list
```

**2. R5 closed.** `LADDER_FAULTS`' `cli_unresolved` entry no longer contains
`delete flow['cli']`; the case stays (it is the genuine `cli_unresolved` path)
and its comment names the real fault source — the relocated empty `flows.json`.

```
grep -n "delete flow\['cli'\]" sdk/tests/cli.test.ts    # no hits
```

The suite must still refuse all three ladder flows with `cli_unresolved`. **If
removing the mutation makes that case pass instead of refuse, the test was
green for the wrong reason — that is a finding to report, not to paper over.**

**3. Every command below passes, executed in this tick on the merged tree,
tails quoted verbatim into both `ops/DRIVE-LOG.md` and PR #8's body.**
Superseded tails are not evidence — re-shipping them is the R2 defect and fails
the package.

```sh
(cd kernel && ../ops/cargo.sh test --workspace)                  # exit 0
(cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings) # exit 0
(cd kernel && ../ops/cargo.sh fmt --check)                       # exit 0, empty output
(cd sdk && npm run build)                                        # exit 0
(cd sdk && npm test)                                             # exit 0
```

Floors: kernel **≥ 70** (measured on `main` this tick), SDK **≥ 58**. Expected
on the merged branch: kernel **72**, SDK **99** minus anything removed by DoD 2
— but report the **measured** number, never the expected one. A count below a
floor is a failure, not a note.

Structural gate (AGENTS.md rule 1) re-checked on the merged tree:

```sh
find kernel -name '*.rs' -not -path '*/target/*' | xargs wc -l | sort -n | tail -3
find sdk/src -name '*.ts' | xargs wc -l | sort -n | tail -3      # nothing >= 500
```

**4. The behavioral gate re-runs from the merged tree, all seven cases, output
pasted into the PR body:**

```sh
node sdk/dist/cli.js check testdata/hello-ladder.flow.yaml    # exit 0, CHECK PASSED
node sdk/dist/cli.js check testdata/hello-llm.flow.yaml       # exit 0, CHECK PASSED
node sdk/dist/cli.js check testdata/hello-agent.flow.yaml     # exit 0, CHECK PASSED
node sdk/dist/cli.js check testdata/preflight/cli-missing.flow.yaml          # exit 2, REFUSED [cli_missing]
node sdk/dist/cli.js check testdata/preflight/cli-unauthenticated.flow.yaml  # exit 2, REFUSED [cli_unauthenticated]
node sdk/dist/cli.js check testdata/preflight/cli-unresolved.flow.yaml       # exit 2, REFUSED [cli_unresolved]
node sdk/dist/cli.js check testdata/preflight/no-executor.flow.yaml          # exit 2, REFUSED [no_executor]
```

**5. Both Codex findings triaged at HEAD with a posted reply, and neither
fixed in this PR.** **Lead's ruling:**

- **P1 (refuse an absent deterministic executable).** The finding is partly
  right and the current behavior is defensible: covenant 2's refusal list is
  *declared CLIs, unauthenticated CLIs, and executorless triggers* — an
  arbitrary deterministic `command` string is not a declared CLI, and the
  kernel runs it through `/bin/sh -c` (`exec_det.rs:22-27`), so an unresolved
  first word may be a builtin, function, or assignment. Warning is covenant-2
  compliant; refusing on PATH absence alone would reject valid flows. **But**
  Codex's minute-zero case is real for a command word that provably cannot be a
  builtin (one containing `/`). The reply must say exactly this, and the narrow
  tightening — *refuse a path-like command word that does not exist; keep the
  warning otherwise* — is **filed to `ops/BACKLOG.md`, not built this tick.**
- **P2 (kernel-dialect divergence).** Genuine and unfixed: `flows check`
  accepts `version: 9.9.9` that `RunSpec::validate` rejects, so a passed check
  does not imply the kernel accepts the spec. It is **not** in gate 1's
  done-when, so it does not block this PR. Filed to `ops/BACKLOG.md` in the
  same item as P1 — both are "check accepts what the kernel later refuses",
  one follow-up package.

Neither bot's green check may be cited as review (`ops/RUN-CONTRACT.md` §3
bar 1).

**6. A third adversarial review runs and returns `REVIEW_PASSED`,** transcript
persisted to `ops/reviews/` and committed. Brief the reviewer explicitly:
rounds 1 and 2 are on the branch — read them; the code was already found sound
by round 2; judge whether **R1–R5 are closed**, whether the **shipped record is
true**, and whether the **merge with `main` preserved both trees' meaning**.
**If it returns `REVIEW_FAILED`, no PR update ships:** log the verdict, leave
PR #8 as it is, and let the next tick continue. An honest refusal is a result,
not something to route around.

**7. PR #8 is updated in place and its live state recorded.** Body rebuilt from
DoD 3 + 4 evidence; a comment posted answering Khaliq's block item by item
(what was fixed, where, what remains for a human); then, within 60s of the
update:

```sh
gh pr view 8 --json mergeable,mergeStateStatus,statusCheckRollup,reviewDecision
```

recorded verbatim in the log. `mergeable` must read `MERGEABLE` — if it still
reads `CONFLICTING`, the reconciliation did not land and the package is not
done.

**8. `ops/DRIVE-LOG.md` gains this tick's entry**: the package, what changed,
the five verify tails verbatim, the behavioral-gate output, the third review's
verdict **as read from the transcript** (never inferred from gating), the two
Codex triage rulings, PR #8's live state, and honest gate state — gate 1
**AMBER**, clause 2 unmerged until a human merges.

## Explicitly OUT of scope for this tick

- **Any change under `sdk/src/**` or `kernel/**`.** Two independent reviews
  found the WP-4 implementation sound. The only source edit permitted is the
  dead-mutation deletion in `sdk/tests/cli.test.ts` (DoD 2). Both Codex
  findings are filed, not built (DoD 5).
- **`workflows/drive.yaml` and `ops/RUN-CONTRACT.md`** — the gate that judges
  this work. Barred by the charter's hard rails and AGENTS.md. Note that
  `main` already carries the fixes the last two ticks asked for.
- **Rebasing, squashing or force-pushing `flow/drive-57e923c-08271542`,** and
  amending the 16:03 DRIVE-LOG entry's text. In-place errata markers only.
- **Regenerating canonical fixtures.** All six canonical/`.sha256` files are
  byte-identical to `main` and must stay that way — that is precisely what R4
  corrects the record to say.
- **Merging anything.** Charter hard rail: the Lead opens PRs and reports.
- **Any new gate work** — gates 2, 5, 6, 7, 8. Gate selection reopens only once
  PR #8 is merged or closed by a human. The scoreboard's gate-6 "next up" is a
  candidate, not a commitment.
- **PR #6** (draft, `flows/relaycast-500-regression`). Prior ruling stands.
- **The two stray local branches** `flow/drive-57e923c-08271632` and this
  branch's own `flow/drive-73bdb59-08271701` — assess artifacts only. Do not
  push them; the superseded WP-4-FIX text stays retrievable by SHA.
- **Backlog items** — release pipeline, `f.browser`, cloud-sandbox `sync`
  remote, PR-shepherd flow. All wait behind PR #8.

## For the human — non-blocking, flag in the PR

1. **`docs/SURFACE.md:78` deletes the "→ platform default" rung** from the
   anonymous-resolution law. Pre-authorized by the WP-4 package and consistent
   with it ("never guesses a platform default"), but it narrows a surface
   doctrine. Confirm the rung is **abandoned** rather than deferred.
2. **`kernel/relayflowd-core/src/machine/tests.rs:66-75`** enumerates the eight
   failure `CompletionReason`s by hand — a ninth variant added later will not
   fail this test. Exhaustiveness is by inspection, not by the compiler.
3. **Merging PR #8 turns gate 1's clause 2 into repository state.** Only then
   may the scoreboard's gate-1 row move off AMBER, and only on a re-verified
   run — not on this PR's word.

ASSESS_DONE
