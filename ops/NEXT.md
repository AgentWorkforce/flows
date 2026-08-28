# NEXT — single highest-priority work package

Written by the Relayflow Lead on 2026-08-27 (assess tick on branch
`flow/drive-45cc352-08272018`, HEAD = `45cc352`, identical to `origin/main`).

---

## Assessment snapshot (evidence, measured this tick)

### 1. Standing directives — checked first, none active

`ops/DIRECTIVES.md` carries only its header paragraph; there is no numbered
directive in the file. Directive 1 (de-vendor kernel deps) was satisfied and
removed by PR #3. **Nothing outranks the gate/PR work this tick.**

### 2. Open PRs — one, and it is rejected at its own head

`gh pr list --state open` → exactly one:

| PR | Title | Head branch | Head OID | State |
|---|---|---|---|---|
| #8 | WP-4 — `flows check` preflight (covenant 2) | `flow/drive-57e923c-08271542` | `4ce3ff9` | OPEN, not draft, MERGEABLE / CLEAN |

**PR #8's own review of record at its current head is `REVIEW_FAILED`.**
The head commit `4ce3ff9` *is* the rejection: `review(pr8): independent diff
review at d129750 — REVIEW_FAILED`, persisting
`ops/reviews/20260827-2011-review.md`, whose last line is `REVIEW_FAILED`.
Nothing has been committed since to answer it.

The PR body currently advertises a passing swarm and does **not** mention this
rejection:

| Run | Reviewed head | Maintainability | History | Structure | Aggregate |
|---|---|---|---|---|---|
| Initial swarm, 17:45 EDT | earlier head | FAILED | FAILED | PASSED | **SWARM_FAILED** |
| Final main-owned swarm `b242b77ed0270c99fa5be416` | `a8c9110` | PASSED | PASSED | PASSED | **SWARM_PASSED** |
| *(absent from the body)* standalone diff review, 20:11 EDT | `d129750` | — | — | — | **REVIEW_FAILED** |

The swarm's `SWARM_PASSED` is real and I am not disputing it — it reviewed
`a8c9110`, and `git diff a8c9110 HEAD -- sdk kernel docs workflows testdata` is
empty, so it binds to the current product tree. But a *later*, independent
reviewer read the same diff against `ops/NEXT.md`, re-ran every gate itself, and
rejected on evidence-integrity grounds. A PR whose newest review says
`REVIEW_FAILED` is awaiting fixes. **Per the charter and the run contract, that
makes fixing PR #8 the work package. No new gate work starts over it.**

The three findings, each verified by me as still true at `4ce3ff9`:

- **V1 (P2) — a false measured fact in the gate-state record.**
  `ops/SCOREBOARD.md` line 8 on the PR branch reads
  *"Measured on this tree: kernel 72 tests, SDK 99 tests, 0 failed, clippy/fmt
  clean."* Kernel 72 is right; **SDK 99 is wrong — that tree has 121.** The
  figure was written at `6a425b6` and never updated across the WP-5 rounds that
  added 22 tests. This is the one file that records gate state, the diff edits
  exactly this line, and "Measured on this tree" makes it a claim about the
  current tree. It understates rather than overstates, so nothing downstream is
  inflated — but a stale measurement in the gate record is precisely the defect
  class this whole package exists to eliminate.
- **V2 (P3) — the durable log never records the passing round.**
  `ops/DRIVE-LOG.md` on the PR branch stops at the `4f8ecf8` round and its last
  word on the swarm is `SWARM_FAILED` (7 occurrences; verified
  `grep -n "SWARM_PASSED\|a8c9110" ops/DRIVE-LOG.md` on that branch returns
  **nothing**). The verdict survives in the PR body and the three committed
  transcripts, so this is a freshness gap and not a false claim — but a human
  reading only the in-repo log concludes PR #8 is still rejected.
- **V3 (P3) — an undisclosed check/kernel asymmetry.** `sdk/src/validate.ts`
  refuses `steps: []` (`REFUSED [invalid_spec] spec.steps: expected a non-empty
  array`, exit 2) while the kernel accepts it — `RunSpec.steps` is
  `#[serde(default)]` (`kernel/relayflowd-core/src/spec.rs:39-40`) and
  `RunSpec::validate` (`:64-127`) has no empty-steps check. Same false-red class
  as F1's `name` case. Degenerate and defensible, but **undisclosed**: I
  confirmed `docs/SURFACE.md` on the PR branch says nothing about it.

The reviewer's own remediation estimate: *"two documentation edits (V1 one line;
V2 one appended paragraph). No product code needs to change."*

### 3. Tests on `main` at assessment time

This machine, hermetic `ops/cargo.sh`, no manually exported env vars:

| Command | Result |
|---|---|
| `(cd kernel && ../ops/cargo.sh test --workspace)` | **70 passed, 0 failed** (18 + 19 + 24 + 3 + 6; doc-tests 0 ×3), exit 0 |
| `(cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings)` | exit 0, no warnings |
| `(cd kernel && ../ops/cargo.sh fmt --check)` | exit 0, empty output |
| `(cd sdk && npm test)` | **58 passed, 0 failed** (5 files), exit 0 |

These are the `main` baselines and they match `ops/SCOREBOARD.md`'s gate-1 row
on `main` (kernel 70 / SDK 58). The 72/121 figures belong to the PR #8 branch.

### 4. Gate state — gate 1, still AMBER, correctly

RFC-0001 §3 gate 1's done-when has two clauses:

- **Clause 1 — the hello ladder** (a) deterministic, (b) + `llm` with a
  verification gate, (c) + `agent`, each surviving `kill -9` at every step
  boundary with exact budget accounting. **Closed on `main`** (PRs #2/#3, #4,
  #7 / `ca6b80a`).
- **Clause 2 — preflight holds (covenant 2):** `flows check` refuses the ladder
  flows when a declared CLI is missing or unauthenticated or a trigger has no
  executor, warns on unprovable assumptions before starting, and the failure
  taxonomy is closed. **Implemented only on PR #8's branch — not on `main`.**

So gate 1 is AMBER and stays AMBER. It flips to GREEN only after a human merges
PR #8 and the result is re-verified on merged `main`. Closing PR #8's review is
therefore not a detour from gate 1 — it is the shortest remaining path to it.

Gates 2–9: RED, not started (per `ops/SCOREBOARD.md`).

---

## Work package: WP-6 — close the 20:11 review's findings on PR #8

### Objective

Take PR #8 from `REVIEW_FAILED` to a clean, re-reviewed head that a human can
merge, **without touching product code and without rewriting history**. The
substance of the preflight is done and independently confirmed; what is
outstanding is that the branch's evidence record contradicts the branch's own
measurements, and that the newest review verdict is not represented in the PR.

Three sub-objectives:

1. Make `ops/SCOREBOARD.md`'s measured claim true (V1).
2. Make `ops/DRIVE-LOG.md` the honest, complete, append-only record of every
   review round on this PR — **including the 20:11 rejection and this repair**
   (V2, extended).
3. Disclose the `steps: []` asymmetry in `docs/SURFACE.md` (V3), so it is a
   stated narrowing rather than a hidden one.

Then re-run the review swarm against the repaired head and update the PR body's
review-of-record table so the rejection is visible, not quietly superseded.

### Branch discipline — read this before the first command

- **Work on `flow/drive-57e923c-08271542`** — PR #8's existing head branch.
  Do **not** open a new branch and do **not** open a second PR. Fixing the
  open PR means adding commits to it.
- **Copy this `ops/NEXT.md` onto that branch** as part of the first fix commit,
  so the PR carries the package it is judged against. (This file was written on
  the assess branch `flow/drive-45cc352-08272018`.)
- **Append only.** No rebase, no squash, no `--amend`, no force-push, no
  deletion or edit-in-place of any prior rejection evidence. The `20260827-2011`
  transcript stays byte-intact; corrections are made by *appending* errata and
  new rounds. Prior rounds' `SWARM_FAILED` records stay.
- **Never edit the gate that judges you.** `workflows/review-swarm.yaml` must
  remain byte-identical to `origin/main` on this branch. Any hardening of the
  swarm is a separate PR judged by the pre-change swarm.
- The branch's merge-base is `origin/main` @ `45cc352`, which is `main`'s tip,
  so two-dot and three-dot diffs agree today. Verify both anyway before
  reporting a file count.

### Files in scope

Editable by this package:

- `ops/SCOREBOARD.md` — V1: the gate-1 row's measured-counts sentence only.
- `ops/DRIVE-LOG.md` — V2: **appended** text only.
- `docs/SURFACE.md` — V3: one short disclosure of the `steps: []` narrowing.
- `ops/NEXT.md` — carry this file onto the branch.
- `ops/BACKLOG.md` — optional: record V3 as a durable item if you additionally
  want the kernel-side symmetry fix tracked (the fix itself is out of scope).
- `ops/reviews/` — new transcripts only, each committed alone.
- PR #8's body, via `gh pr edit 8 --body-file` (not a repo file, but in scope).

**Not editable by this package** (any diff here fails the package):

- `kernel/**`, `sdk/src/**`, `sdk/tests/**`, `testdata/**` — product code and
  fixtures are done and confirmed; changing them re-opens the whole review.
- `workflows/**` — especially `review-swarm.yaml`.
- Any existing file under `ops/reviews/`.

### Definition of done

Every item must hold, and every command below must be run on the branch and its
verbatim tail pasted into the PR body.

**1. V1 closed and true.** `ops/SCOREBOARD.md`'s gate-1 row states SDK and
kernel test counts that equal what `npm test` and `cargo test` print on that
tree *at the time you write it*. Measure first, then write the measured number —
do not copy `121` from this file. Expected `72` kernel / `121` SDK; if either
differs, the measured value wins and the discrepancy is disclosed in the log.

```
grep -c 'SDK 99 tests' ops/SCOREBOARD.md   # must be 0
```

**2. V2 closed.** `ops/DRIVE-LOG.md` gains an appended section that records, in
order and by hash:

- the final main-owned swarm run `b242b77ed0270c99fa5be416` at `a8c9110` →
  `SWARM_PASSED`, naming its three committed transcripts
  (`20260827-1958-pr8-history.md`, `20260827-1958-pr8-structure.md`,
  `20260827-2002-pr8-maintainability.md`) and the fact that
  `git diff a8c9110 4ce3ff9 -- sdk kernel docs workflows testdata` is empty, so
  the passing review bound to the pre-WP-6 product tree at that head;
- the 20:11 standalone review at `d129750` → **`REVIEW_FAILED`**, with V1/V2/V3
  stated plainly — this rejection must appear in the durable log, not only in a
  transcript;
- this WP-6 repair round and its own re-review verdict.

```
grep -c 'SWARM_PASSED' ops/DRIVE-LOG.md      # must be >= 1
grep -c 'a8c9110'      ops/DRIVE-LOG.md      # must be >= 1
grep -c 'REVIEW_FAILED' ops/DRIVE-LOG.md     # must be >= 1
```

**3. V3 closed by disclosure.** `docs/SURFACE.md` states that the authoring
surface deliberately narrows `steps: []` — refused at `flows check` with
`invalid_spec`, accepted by the kernel — and that this is a chosen
authoring-time narrowing, not a kernel guarantee. One short paragraph. **Do not
change the kernel to match**; that is out of scope (see below).

**4. Product-tree bindings are explicit.** PR #8 of course changes product code
relative to `main` — that is the package. Before WP-6, the product tree was
unchanged since the commit the passing swarm reviewed, so `a8c9110`'s
`SWARM_PASSED` bound through the rejected pre-repair head `4ce3ff9`. The V3
disclosure then changes `docs/SURFACE.md` at `f0abdd4`, so the WP-6 re-review
must bind to that repaired product tree instead. All three guards must print
nothing:

```
git diff a8c9110 4ce3ff9 -- kernel sdk testdata workflows docs
git diff f0abdd4 HEAD     -- kernel sdk testdata workflows docs
git diff main    HEAD     -- workflows/
```

The first two guards include `docs/`: the first preserves the historical
binding claim and the second proves that no product path changed after the V3
repair. Make the disclosure **before** the re-review in item 8. State explicitly
in the PR body that after WP-6 the new review binds to the `f0abdd4` product
tree, not to `a8c9110`.

**5. History intact.** `a8c9110`, `d129750`, `497bc10`, `7062800`, `4ce3ff9`
are all still ancestors of the head, unmodified:

```
for c in a8c9110 d129750 497bc10 7062800 4ce3ff9; do
  git merge-base --is-ancestor $c HEAD && echo "$c ok" || echo "$c MISSING"; done
```

**6. Gates re-run green on the repaired head**, verbatim tails in the PR body:

```
(cd kernel && ../ops/cargo.sh test --workspace)          # exit 0, expect 72 passed / 0 failed
(cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings)  # exit 0
(cd kernel && ../ops/cargo.sh fmt --check)               # exit 0, empty
(cd sdk && npm run build)                                # exit 0
(cd sdk && npm test)                                     # exit 0, expect 121 passed / 0 failed
```

Because this package changes no product code, any movement in these numbers is
itself a finding and must be investigated before the PR is updated.

**7. The preflight behavioral cases still pass on the repaired head** — the same
set the PR body records, re-run, not copied:

```
node sdk/dist/cli.js check testdata/hello-ladder.flow.yaml   # CHECK PASSED, exit 0
node sdk/dist/cli.js check testdata/hello-llm.flow.yaml      # CHECK PASSED, exit 0
node sdk/dist/cli.js check testdata/hello-agent.flow.yaml    # CHECK PASSED, exit 0
```

plus the four typed refusals, each exiting 2 with its declared kind named:

```
node sdk/dist/cli.js check testdata/preflight/cli-missing.flow.yaml          # cli_missing
node sdk/dist/cli.js check testdata/preflight/cli-unauthenticated.flow.yaml  # cli_unauthenticated
node sdk/dist/cli.js check testdata/preflight/cli-unresolved.flow.yaml       # cli_unresolved
node sdk/dist/cli.js check testdata/preflight/no-executor.flow.yaml          # no_executor
```

and the kernel-version refusal through the real CLI (`spec.version: unsupported
version "9.9.9" (expected "0.1.0")`, exit 2).

**8. Re-reviewed and passing.** Run the review swarm against the repaired head
using the **`origin/main` copy of the workflow**:

```
echo 8 > .review-target
# run workflows/review-swarm.yaml with PR_NUMBER=8
```

The aggregate must print `SWARM_PASSED`. Each lens's transcript is committed in
**its own commit touching only that file** — the F0 evidence-loss failure (two
hard resets discarded staged, uncommitted transcripts) must not recur. If any
lens rejects, that rejection is the next round's work: fix, re-run, and record
both rounds. Do not paper over a rejection by re-running until it passes.

**9. The PR body tells the whole truth.** `gh pr edit 8` so the review-of-record
table includes **all** rounds in order — the 17:45 `SWARM_FAILED`, the
`a8c9110` `SWARM_PASSED`, the 20:11 `REVIEW_FAILED` with V1/V2/V3, and the WP-6
repair round with its verdict — plus the verbatim DoD tails from items 6 and 7.
The existing F0 disclosure and the standalone-review errata stay. Deleting or
softening the 20:11 rejection is a package failure.

**10. Gate 1 stays AMBER.** `ops/SCOREBOARD.md` continues to say gate 1 flips to
GREEN only after a human merges PR #8 and re-verifies on merged `main`. **The
Lead does not merge** (charter, Hard rails). This package ends with an updated,
re-reviewed, still-open PR #8 and an honest report.

### Explicitly OUT of scope for this tick

- **Merging PR #8.** A human merges. Do not merge, do not enable auto-merge.
- **Any product-code change** — kernel, `sdk/src`, `sdk/tests`, `testdata`.
  Including: making the kernel refuse `steps: []` to close V3 symmetrically.
  V3 is closed *by disclosure* this tick; the kernel-side fix is backlog-sized
  and belongs to a later package.
- **Editing `workflows/review-swarm.yaml`** in any way on this branch, including
  the durability hardening the F0 disclosure proposes. Separate PR, judged by
  the pre-change swarm.
- **Hardening `workflows/drive.yaml`'s `pr` step** (hardcoded body, the
  `cut -c1-60` byte cut across the em-dash, `--fill` falling back to the branch
  name for the title). Five ticks of the same drift with a pinpointed root
  cause — it is the strongest standing candidate for the *next* package, and it
  is still not a reason to add a workflow change to a PR under review.
- **The two residual WP-3 findings** (P2-A `agent_pins_available` vs
  `worker_holds`; P3-B unvalidated `started_pins`/`end_pins` on non-agent
  completions). Recorded in `ops/BACKLOG.md`; neither fails open.
- **Gate 2+ work of any kind** — triggers, dispatch, provider integration,
  permission enforcement, live model calls, live agent CLI invocation, slack /
  notion helpers.
- **The cloud-sandbox `origin` gap** and the regression suite. Backlog.
- **Rebasing this branch onto `main`.** The merge-base is `main`'s tip; there is
  nothing to gain and a history-rewrite rail to lose.

### Why this and not the preflight follow-on

Because the charter's rule is unconditional: an open PR awaiting fixes from
review is the work package, and new work never starts over unfinished work.
PR #8 is that PR. The countervailing argument — that the swarm already returned
`SWARM_PASSED` on an equivalent tree, so the branch is really done — is exactly
the reasoning that produced two of the last three process failures on this
repo: a verdict was treated as settled while a later, more specific check said
otherwise. The 20:11 reviewer re-ran every gate itself and found a false
measured claim in the gate-state record. It is a two-line fix. It costs one
short tick and it leaves gate 1's second clause standing on a PR whose evidence
record is true — which is the whole point of covenant 2.
