# NEXT — single highest-priority work package

Written by the Relayflow Lead on 2026-08-27 (assess tick on branch
`flow/drive-57e923c-08271632`, HEAD = `57e923c` = `origin/main`).

**Work package: WP-4-FIX — clear the standing `REVIEW_FAILED` on PR #8.**
This is fix-the-open-PR work. No new gate work is permitted this tick.

---

## Assessment snapshot (evidence, gathered this tick)

### 1. Standing directives — checked first, per `ops/DIRECTIVES.md`

**No active directives.** `ops/DIRECTIVES.md` carries only its header; the one
directive it ever held (*stay lean — de-vendor kernel deps*, 2026-08-27) was
satisfied and removed by PR #3 (`0ba6c88`). Verified against the file's full
history, not its current text alone:

```
$ git log --oneline -- ops/DIRECTIVES.md
0ba6c88 flow/de vendor wrapper e715601 (#3)     <- removed directive 1 (satisfied)
45db231 ops: standing human directives ...      <- added directive 1
```

Nothing in the directives file outranks gate work this tick.

**But a human instruction of directive weight sits on PR #8 itself.** Khaliq
commented at `2026-08-27T20:29:24Z`:

> **BLOCKED — do not merge. The reviewer rejected this diff twice; the PR
> opened anyway.** … Next tick picks this up as fix-the-open-PR work per the
> drive rule.

That comment names this tick's package. It is honored as the first item, ahead
of the backlog and ahead of gate selection.

### 2. Open PRs

| PR | Title | State | Bearing on this tick |
|---|---|---|---|
| **#8** | WP-4 — `flows check` preflight (covenant 2) | **OPEN, MERGEABLE, human-blocked** | **This tick's work.** Standing verdict is `REVIEW_FAILED` (two rounds). |
| #6 | regressions: relaycast workspace-key repair answers an untyped 500 | OPEN, **draft** | Not this loop's work. Documents a defect in `relaycast-cloud` (filed as AgentWorkforce/relaycast-cloud#88) that no code in this repo can close. Prior ruling stands; out of scope. |

The drive rule — *never start new work over unfinished work* — binds this tick.
Gate selection (gates 2 / 5 / 6) does **not** reopen until PR #8 is merged.

### 3. PR #8 review state — read, not inferred from tokens

Two persisted adversarial transcripts on `flow/drive-57e923c-08271542`, both
ending `REVIEW_FAILED`:

- `ops/reviews/20260827-1611-review.md` — **REVIEW_FAILED** on three code
  findings: F1 (HIGH) fail-open on an unprovable deterministic command; F2 the
  clause's literal subject (the *ladder* flows under induced fault) untested;
  F3 a self-certifying gate resting on a stub baked into the canonical gate-1
  artifacts and their hash pins.
- `ops/reviews/20260827-1620-wp4-fixes.md` — the repair note answering them.
- `ops/reviews/20260827-1627-review.md` — **REVIEW_FAILED**, round 2. It
  confirms F1/F2/F3 are genuinely closed, re-ran every DoD command on its own
  tree, and states verbatim: *"The code is sound. Nothing below asks for a code
  change."* It fails the diff on **record honesty**, not engineering.

Round 2's open findings, and their status after `6a425b6` (pushed 2 minutes
*after* Khaliq's blocking comment, so his comment does not account for it):

| # | Finding | Status now | Left to do |
|---|---|---|---|
| R1 | `ops/DRIVE-LOG.md:516` says *"no independent review transcript was produced"* in the same commit that adds a 290-line `REVIEW_FAILED` transcript | Errata appended ~180 lines later; **the false sentence still stands unmarked at :516** | Mark it in place |
| R2 | Three different SDK counts for one measurement — DRIVE-LOG `76`, SCOREBOARD `95`, actual `99` | SCOREBOARD corrected to 99; DRIVE-LOG's `76` tail still quoted as *verbatim evidence* at :494,:499 | Mark it in place; **PR #8's body still ships the 76 tail** |
| R3 | `ops/DRIVE-LOG.md:524` re-asserts *"gate 1 is GREEN in this branch on both clauses"* while `SCOREBOARD.md` in the same diff says AMBER | Errata appended; **the false sentence still stands unmarked at :524** | Mark it in place |
| R4 | `ops/DRIVE-LOG.md:460` says the three ladder canonical/hash fixtures *"were regenerated"* — they are byte-identical to `main` | **Not covered by the errata at all** | Add to errata + mark in place |
| R5 | `sdk/tests/cli.test.ts:57` — `delete flow['cli']` is a dead no-op; the ladder YAMLs carry no top-level `cli` key, so the refusal actually comes from the relocated empty `flows.json` | **Open** | Delete the dead mutation, name the real fault source |

R5 verified independently this tick: `git show
origin/flow/drive-57e923c-08271542:testdata/hello-ladder.flow.yaml` has no
top-level `cli:` key (F3's repair removed it), so the mutation at `:57` cannot
change anything. AGENTS.md rule 6 (no dead code), and the label misnames where
the fault originates.

### 4. Tests on `main` (this machine, hermetic `ops/cargo.sh`, no exported env)

- `cd kernel && ../ops/cargo.sh test --workspace` → **70 passed, 0 failed**
  (18 + 0 + 19 + 24 + 3 + 6; doc-tests 0 ×3), exit 0.
- `cd sdk && npm test` → **58 passed, 0 failed** (5 files), exit 0.

Both match `ops/SCOREBOARD.md`'s cited numbers. Main is green; the WP-4 branch
adds +2 kernel and +41 SDK tests on top (72 / 99, per two independent runs).

### 5. Gate 1 does **not** hold — `ops/SCOREBOARD.md` on `main` is wrong today

RFC-0001 §3 gate 1's done-when has **two** clauses, read in full:

> **Done when:** the canonical hello *ladder* … each survives `kill -9` … and
> its journal replays *results, not code*. … **Preflight holds (covenant 2):**
> `flows check` refuses the ladder flows when a declared CLI is missing or
> unauthenticated or a trigger has no executor, warns on unprovable
> assumptions before starting, and the failure taxonomy is closed …

Clause 1 is closed and merged (`ca6b80a`, PR #7). **Clause 2 is unmerged** — it
is PR #8. `ops/SCOREBOARD.md` on `main` nonetheless reads **GREEN** for gate 1.
The WP-4 branch already corrects that row to **AMBER** with clause 2 named; the
correction reaches `main` when PR #8 merges. Until then, `main`'s scoreboard
overstates a gate on half its done-when — the exact defect this package exists
to close. See the operator note below for the immediate-correction option.

### 6. Three operator commits are unreachable — flagged, not fixed

Khaliq's blocking comment says the review-gate fix landed "`c6c3a8b` on main."
It is **not on `main`**. `git ls-remote origin refs/heads/main` →
`57e923c414…`, and `git branch -a --contains c6c3a8b` is empty. Three commits
exist only as dangling objects in this local clone:

```
73bdb59  ops: a green bot check is not review signal; stop truncating PR titles
c6c3a8b  fix(drive): typed review verdicts — an honest REVIEW_FAILED is no longer a crash
8c10321  ops(scoreboard): correct gate 1 back to AMBER — preflight clause unmet
```

Consequence, stated plainly: **`workflows/drive.yaml` in the tree still carries
the defective gate** (`output_contains: REVIEW_PASSED` at `maxIterations: 1`,
lines 115–117), so the loop can again open a PR over a truthful rejection. The
Lead does not repair this — `workflows/drive.yaml` and `ops/RUN-CONTRACT.md`
are the gate that judges this work, and editing them is barred by the charter's
hard rails and by AGENTS.md. Recovery is a cherry-pick of those three SHAs
while they remain in this object store; `git gc` will eventually reap them.

---

## Objective

Make PR #8 mergeable on its merits: leave **no false statement** in the ops
record it ships, carry **executed** evidence in its PR body, remove the one
dead test mutation, and obtain a **third adversarial review returning
`REVIEW_PASSED`** — because a verdict is not overturned by the party it was
issued against.

No feature work. No new gate work. The code under review is sound by two
independent reviews; this package changes the record and one dead test line.

## Branch and PR discipline

- Work **on `flow/drive-57e923c-08271542`** (PR #8's head). Check it out, commit
  the fixes there, push.
- **Update PR #8 in place** (`gh pr edit 8 --body-file …`). Do **not** open
  PR #9. Do **not** rebase, squash, force-push, or rewrite that branch's
  history — the review transcripts and Khaliq's comment reference its commits.
- Reply to Khaliq's blocking comment on PR #8 with a point-by-point audit of
  each item he raised, at HEAD (`gh pr comment 8`). Never silently wave.
- **Do not merge.** Charter hard rail. `ops/RUN-CONTRACT.md` §2's AUTO-MERGE
  authority belongs to Khaliq's autonomous-actor persona, not to this loop.

## Files in scope

- `ops/DRIVE-LOG.md` — in-place errata markers on the four false/superseded
  sentences (see DoD 1), plus this tick's own appended entry.
- `sdk/tests/cli.test.ts` — delete the dead `cli_unresolved` mutation (R5).
- `ops/reviews/<timestamp>-review.md` — the third review transcript, committed.
- `ops/NEXT.md` — this file, carried onto the branch (the original WP-4 package
  text stays retrievable at `git show 823e35a:ops/NEXT.md`; the review
  transcripts' line references resolve against that revision).
- `ops/SCOREBOARD.md` — only if the third review or the re-run changes a number.
  The AMBER row is already correct on the branch; do not touch its state.
- PR #8's body and a PR #8 comment (via `gh`, not files).

## Definition of done

**1. The record carries no unmarked falsehood.** `ops/DRIVE-LOG.md` is
append-only by its own stated discipline, and the errata at the end already
exist — but a reader hitting line 516 must not read a false sentence with no
signal. **Lead's ruling (this is a decision, not an open question):** keep the
original text byte-intact and annotate each of the four sentences *in place*
with a bracketed marker naming the finding and pointing forward, e.g.

```
**Review:** no independent review transcript was produced.
[ERRATA R1 — false as of 823e35a; three transcripts are committed in this
same diff. See "WP-4 review round 2 + record correction" below.]
```

Required at four sites: `:460` (R4, regenerated → byte-identical to `main`),
`:494`/`:499` (R2, the 76-test tail is pre-fix), `:516` (R1), `:524` (R3).
R4 must also be added to the errata list in the round-2 entry, which currently
covers only R1–R3. Verify with:

```
grep -n "ERRATA" ops/DRIVE-LOG.md      # >= 4 hits, one per site
grep -n "R4" ops/DRIVE-LOG.md          # R4 present in the errata list
```

**2. R5 closed.** `sdk/tests/cli.test.ts`'s `LADDER_FAULTS` entry for
`cli_unresolved` no longer contains `delete flow['cli']`. The case stays — it
is the genuine `cli_unresolved` path — but its comment names the real fault
source (the relocated empty `flows.json`), and the fault table has no no-op
mutation. `grep -n "delete flow\['cli'\]" sdk/tests/cli.test.ts` → no hits.
The suite must still refuse all three ladder flows with `cli_unresolved`; if
deleting the mutation makes that case pass instead of refuse, the test was
green for the wrong reason and **that is a finding to report, not to paper
over**.

**3. Every command below passes, executed in this tick, tails quoted verbatim
into both `ops/DRIVE-LOG.md` and PR #8's body.** Superseded tails are not
evidence — this is the R2 defect and re-committing it fails the package.

```
cd kernel && ../ops/cargo.sh test --workspace          # exit 0
cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings   # exit 0
cd kernel && ../ops/cargo.sh fmt --check               # exit 0, empty output
cd sdk && npm run build                                # exit 0
cd sdk && npm test                                     # exit 0
```

Expected on this branch: kernel **72 passed, 0 failed**; SDK **99 passed, 0
failed** (7 files) — minus any test removed by DoD 2, in which case report the
new number as measured, never as expected.

**4. The behavioral gate re-runs, from the current tree, all seven cases:**

```
node sdk/dist/cli.js check testdata/hello-ladder.flow.yaml   # exit 0, CHECK PASSED
node sdk/dist/cli.js check testdata/hello-llm.flow.yaml      # exit 0, CHECK PASSED
node sdk/dist/cli.js check testdata/hello-agent.flow.yaml    # exit 0, CHECK PASSED
node sdk/dist/cli.js check testdata/preflight/cli-missing.flow.yaml          # exit 2, REFUSED [cli_missing]
node sdk/dist/cli.js check testdata/preflight/cli-unauthenticated.flow.yaml  # exit 2, REFUSED [cli_unauthenticated]
node sdk/dist/cli.js check testdata/preflight/cli-unresolved.flow.yaml       # exit 2, REFUSED [cli_unresolved]
node sdk/dist/cli.js check testdata/preflight/no-executor.flow.yaml          # exit 2, REFUSED [no_executor]
```

**5. A third adversarial review runs and returns `REVIEW_PASSED`,** with its
transcript persisted to `ops/reviews/` and `git add`ed. The reviewer must be
told: rounds 1 and 2 are on the branch, read them; the code was already found
sound; judge whether R1–R5 are closed and whether the shipped record is true.
**If it returns `REVIEW_FAILED`, no PR update ships** — log the verdict, leave
PR #8 exactly as it is, and let the next tick continue. An honest refusal is a
result, not a failure to route around.

**6. PR #8 is updated in place** — body rebuilt from the executed evidence
(DoD 3 + 4), and a comment posted replying to Khaliq's block, item by item:
what was fixed, where, and what is left for a human. `gh pr view 8 --json
mergeable,mergeStateStatus,statusCheckRollup` re-verified live and recorded.
Per `73bdb59`'s (unreachable) intent, a **green bot check is not review
signal** — CodeRabbit was rate-limited into skipping and Devin's trial expired
on this PR. Do not cite either as external review.

**7. `ops/DRIVE-LOG.md` gains this tick's entry** with: the package, what
changed, the five verify tails verbatim, the behavioral-gate output, the third
review's verdict *as read*, PR #8's live state, and honest gate state — gate 1
**AMBER**, clause 2 unmerged.

## Explicitly OUT of scope this tick

- **Any code change to `sdk/src/**` or `kernel/**`.** Two independent reviews
  found the WP-4 implementation sound. The only source edit permitted is the
  dead-mutation deletion in `sdk/tests/cli.test.ts` (DoD 2).
- **`workflows/drive.yaml` and `ops/RUN-CONTRACT.md`** — the gate that judges
  this work. Barred by the charter's hard rails and AGENTS.md. The review-gate
  defect and the `cut -c1-60` PR-title truncation are operator items; report
  them, do not fix them. (§6 above.)
- **Restoring the three dangling operator commits.** Report the SHAs; the human
  decides. Two of the three edit the gate.
- **Rewriting `ops/DRIVE-LOG.md` history** or amending the 16:03 entry's text.
  In-place errata markers only (DoD 1) — the original text stays byte-intact.
- **Any new gate work** — gates 2, 5, 6, 7, 8. Gate selection reopens only
  after PR #8 merges. The scoreboard's gate-6 "next up" is a candidate, not a
  commitment; the next assess chooses on evidence.
- **PR #6** (`flows/relaycast-500-regression`, draft). Prior ruling stands: it
  documents a `relaycast-cloud` defect that no code here can close.
- **Merging anything.** Charter hard rail: the Lead opens PRs and reports.
- **Backlog items** — release pipeline, `f.browser`, cloud-sandbox `sync`
  remote, PR-shepherd flow. All wait behind PR #8.
- **Regenerating canonical fixtures.** They are byte-identical to `main` and
  must stay that way (this is what R4 corrects the record to say).

## Operator actions — for the human, not for this loop

1. **`main`'s scoreboard reads GREEN for gate 1 while clause 2 is unmerged.**
   The correction ships with PR #8. If it should be true on `main` *now*,
   cherry-pick `8c10321` — it is recoverable only while it survives `git gc`.
2. **Re-push the three unreachable commits** (`8c10321`, `c6c3a8b`, `73bdb59`).
   Until `c6c3a8b` is on `main`, the review gate still cannot express an honest
   refusal, and a future tick can open a PR over a `REVIEW_FAILED` again — the
   precise failure that produced this package.
3. **`docs/SURFACE.md:78` deletes the "→ platform default" rung** from the
   anonymous-resolution law. Pre-authorized by the WP-4 package and consistent
   with it, but it narrows a surface doctrine. Confirm the rung is abandoned
   rather than deferred. Non-blocking; flagged in the PR.
