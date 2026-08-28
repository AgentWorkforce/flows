# NEXT — single highest-priority work package

Written by the Relayflow Lead on 2026-08-27 (assess tick on branch
`flow/drive-6366943-08272219`, base `6366943` = `origin/main`).

## Assessment snapshot (evidence)

**1. Standing directives (`ops/DIRECTIVES.md`) — checked first, as ordered.**
The file carries only its header; **no active directive**. Directive 1
(de-vendor kernel deps) was satisfied and removed by PR #3. Nothing outranks
the PR/gate ordering this tick.

**2. Open PRs — one, and it is unfinished work.**

```
$ gh pr list --state open --json number,title,isDraft,mergeable,reviewDecision
[{"createdAt":"2026-08-27T20:06:09Z","headRefName":"flow/drive-57e923c-08271542",
  "isDraft":false,"mergeable":"UNKNOWN","number":8,"reviewDecision":"",
  "title":"WP-4 — flows check preflight (covenant 2)"}]
```

PR #8 is `OPEN` / `MERGEABLE` / `CLEAN`, 87 files, head `2701aef`. It carries
gate 1's **entire remaining done-when clause** (`flows check` preflight,
covenant 2). PR #6 (the relaycast regression draft flagged last tick) merged as
`59f3680`; it is no longer a consideration.

**The reviewed head is not the current head.** The PR body's own closing claim
is:

> Final PR head `79226ec` adds only those three transcript commits and the
> append-only swarm record after `c6d7266`;
> `git diff c6d7266 HEAD -- sdk kernel docs workflows testdata` is empty.

That claim does not reproduce at the real head:

```
$ gh pr view 8 --json headRefOid --jq .headRefOid
2701aefe25e6ab3ff3b4eade9fb95241df43d7b1

$ git diff --stat c6d7266 origin/flow/drive-57e923c-08271542 -- sdk kernel docs workflows testdata
 sdk/package.json                    | 3 ++-
 sdk/scripts/make-cli-executable.mjs | 6 ++++++
 sdk/tests/bin.test.ts               | 5 +++++
 3 files changed, 13 insertions(+), 1 deletion(-)
```

Two consequences, and they are the work:

- **Product code shipped after the last passing review.** `6fab45a`
  (`fix(wp8): make clean builds produce an executable CLI`) changes the build
  contract (`build` now chains `node scripts/make-cli-executable.mjs`, and a
  new `prepare` hook runs it on install), adds a new script file, and adds a
  test. The swarm that returned `SWARM_PASSED`
  (`6b3c9b8507d10dfeeffb2392`, transcripts `20260827-2125-pr8-structure.md`,
  `-2127-pr8-history.md`, `-2131-pr8-maintainability.md`) reviewed
  `c6d7266`. **No reviewer has seen `6fab45a`.** A `chmod`-on-`prepare` hook is
  exactly the kind of change a structure or history lens has standing to
  question; it must not merge unreviewed.
- **The PR body now narrates evidence that fails on inspection** — the precise
  failure class `AGENTS.md` "Evidence is captured, not narrated" rules 1 and 4
  were written to stop, one commit ago (`6366943`).

**Branch is one commit behind `main`, and it is the commit that judges it.**

```
$ git log --oneline origin/flow/drive-57e923c-08271542..origin/main
6366943 standards: evidence is captured, not narrated

$ git show origin/flow/drive-57e923c-08271542:AGENTS.md | grep -c "Evidence is captured"
0
```

The branch's 43 review transcripts and its PR body were written against the
*old* `AGENTS.md`. The standard they must now satisfy is not on the branch.

**Inline review threads (Codex, the only external reviewer that actually
reviewed):** two, both replied to at head `2701aef`.
- `sdk/src/cli.ts:108` (P2, kernel-dialect parity) — answered as fixed:
  `validateSpec` gates `version` against `SPEC_SCHEMA_VERSION`, `name` optional,
  pinned in `sdk/tests/validate.test.ts`. **Unverified by this assess.**
- `sdk/src/preflight.ts:181` (P1, absent deterministic executable) — answered as
  *deliberately deferred* (a bare first word is not provably absent under
  `/bin/sh -c`), with the narrower path-like case filed in `ops/BACKLOG.md`.
  A deferral is a legitimate disposition, but it is a **fail-open in a
  fail-closed preflight** and the merge reader must see it stated plainly, not
  buried in a thread reply.
- Both threads are unresolved on GitHub. CodeRabbit and Devin report SUCCESS
  and are **not** review signal — CodeRabbit's own comment on this PR says
  "Reviews paused"; per `ops/DRIVE-LOG.md` Devin's trial expired. `73bdb59`
  already settled that a green bot check is not review.

**3. Tests on `main` at assess time** (this machine, hermetic `ops/cargo.sh`,
no manually exported env vars):

```
$ cd kernel && ../ops/cargo.sh test --workspace
test result: ok. 18 passed; 0 failed  (relayflowd lib)
test result: ok.  0 passed; 0 failed  (relayflowd main)
test result: ok. 19 passed; 0 failed  (tests/crash_resume.rs)
test result: ok. 24 passed; 0 failed  (relayflowd-core lib)
test result: ok.  3 passed; 0 failed  (tests/spec_parity.rs)
test result: ok.  6 passed; 0 failed  (relayflowd-journal lib)
                                       → 70 passed, 0 failed, exit 0

$ cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings
CLIPPY_EXIT=0
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.13s

$ cd kernel && ../ops/cargo.sh fmt --check
FMT_EXIT=0
FMT_BYTES=0

$ cd sdk && npm test
 Test Files  5 passed (5)
      Tests  58 passed (58)
                                       → exit 0
```

`main` is green: kernel **70**, sdk **58**. These are the floors below.

**4. Gate 1 (RFC-0001 §3) — AMBER, one clause open.** Ladder rungs (a) PR #2,
(b) PR #4, (c) PR #7 are all merged to `main` and independently re-verified
above. The second done-when clause — *"Preflight holds (covenant 2): `flows
check` refuses the ladder flows when a declared CLI is missing or
unauthenticated or a trigger has no executor, warns on unprovable assumptions
before starting, and the failure taxonomy is closed"* — **is not on `main`.**
It exists only inside PR #8. Gate 1 cannot go GREEN until PR #8 merges and
merged `main` is re-verified.

**5. Backlog** (`ops/BACKLOG.md`): release pipeline, schedule re-registration,
PR-shepherd flow, harness design-partner asks, the two residual WP-3 findings
(P2-A pin/holds disagreement, P3-B unvalidated non-agent pins), and the
path-like missing-command refusal deferred from PR #8's Codex thread. All are
gate-2+ or non-blocking. None outranks an open PR.

---

## Work package: WP-9 — land PR #8 honestly

### Objective

Bring PR #8 to a state a human can merge on evidence that reproduces. It is
open, it holds gate 1's last clause, and it has code at head that no reviewer
has seen. **This is unfinished work; no new gate work starts over it.**

Concretely, in this order:

1. **Sync the branch with `main`.** Merge `origin/main` (`6366943`) into
   `flow/drive-57e923c-08271542`. The branch must carry the `AGENTS.md`
   "Evidence is captured, not narrated" standard it is about to be judged
   against. Resolve conflicts in favor of `main` for `AGENTS.md`; the branch
   owns `ops/` additions.
2. **Review the unreviewed head.** Run `workflows/review-swarm.yaml` against
   PR #8 at its post-sync head (write the number to `.review-target` — it
   already reads `8`; the file mechanism is `45cc352`). The three lenses must
   see `6fab45a`'s build-contract change, not `c6d7266`. Persist all three
   transcripts to `ops/reviews/` as usual. **If any lens rejects, fixing those
   findings is this package** — repair, then re-review the changed head. Do not
   re-run a lens on unchanged code to convert a rejection.
3. **Repair the PR body's stale evidence.** Replace the "final head `79226ec`
   … diff is empty" paragraph with what is true at the head being merged: the
   real head SHA, the actual `git diff <last-reviewed> <head> -- sdk kernel
   docs workflows testdata` output pasted verbatim (empty or not), and the
   swarm ID + transcript paths that reviewed **that** head. Do not delete the
   chronology; append an erratum marking the superseded claim, consistent with
   how prior rounds were corrected on this branch.
4. **State the deferred P1 where the merge reader will see it.** The
   `sdk/src/preflight.ts:181` deferral (a bare, unresolvable deterministic
   command is warned, not refused) belongs in the PR body as a named, accepted
   limitation with its backlog pointer — not only as a reply inside a
   collapsed thread. `docs/SURFACE.md` must say the same thing about what
   `flows check` does and does not refuse.
5. **Re-verify at the final head and paste the tails.** Every command below,
   captured, in the PR body.
6. **Write the tick to `ops/DRIVE-LOG.md`.** The log on `main` has no entry for
   ticks 5–8 (WP-4 … WP-8); those 1,397 lines live only on this branch and land
   with the merge. Say so, and say plainly how many ticks PR #8 has consumed.

Product code changes are permitted **only** where a review finding from step 2
demands one. This package is not an invitation to keep building inside PR #8.

### Files in scope

- `ops/reviews/` — the new swarm transcripts (three, one per lens, one commit
  each, as the branch already does).
- The PR #8 body (via `gh pr edit 8 --body-file`) — steps 3 and 4.
- `ops/DRIVE-LOG.md` — the tick entry with captured tails.
- `docs/SURFACE.md` — only the preflight refusal/warning contract, step 4.
- `ops/BACKLOG.md` — only if step 2 surfaces a finding that is legitimately
  deferred rather than fixed.
- `sdk/**`, `kernel/**` — **only** under a step-2 finding, and every such
  change re-triggers step 2 on the new head.
- `ops/SCOREBOARD.md` — **not** this package's to change. Gate 1 moves when a
  human merges and merged `main` verifies, not when a branch is ready.

### Definition of done

All of these pass on `flow/drive-57e923c-08271542` at its final head, hermetic
`ops/cargo.sh`, no manually exported env vars, tails pasted verbatim into the
PR body:

```sh
(cd kernel && ../ops/cargo.sh test --workspace)
(cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings)
(cd kernel && ../ops/cargo.sh fmt --check)
(cd sdk && npm test)
(cd sdk && rm -rf dist node_modules && npm ci && npm run build && test -x dist/cli.js)
```

Floors, from the `main` measurements above: kernel **≥ 70** passing, sdk
**≥ 58** passing (the branch reports 131 — whatever it reports must not shrink
between the reviewed head and the merged head). Plus:

- `git log --oneline origin/flow/drive-57e923c-08271542..origin/main` is
  **empty** — the branch contains `6366943`.
- Three `ops/reviews/*-pr8-{maintainability,history,structure}.md` transcripts
  exist whose stated reviewed SHA **equals the PR's `headRefOid`** at merge
  time, minus only commits that add those transcripts themselves. Verify by
  running, and pasting, `git diff <reviewed-sha> HEAD -- sdk kernel docs
  workflows testdata` — it must be empty, and this time the pasted output is
  the proof, not the sentence.
- Every lens verdict is `REVIEW_PASSED`; the aggregate is `SWARM_PASSED`.
- The PR body contains no claim that fails when re-run. Spot-check by
  executing every command quoted in it.
- Both Codex inline threads have a reply at the final head; the deferred P1 is
  named in the PR body with its backlog pointer.
- No file in `kernel/` exceeds 500 lines
  (`find kernel -name '*.rs' -not -path '*/target/*' | xargs wc -l`).

### Explicitly OUT of scope for this tick

- **Merging PR #8.** The Lead never merges (charter hard rails). The WP-8
  comment blocked on a missing `veto_diff_review` in the worker environment —
  that reasoning reached the right action for the wrong reason. Missing tooling
  is not why the Lead does not merge; the rail is why. Do not seek a tool that
  would authorize a merge.
- **Any new gate work** — gates 2–9, the harness design-partner asks, the
  release pipeline, schedule re-registration, the PR-shepherd flow.
- **The two residual WP-3 findings** (P2-A, P3-B) — backlogged, non-blocking,
  and not PR #8's diff.
- **Hardening `workflows/drive.yaml`'s `pr` step** (still `gh pr create --fill`
  with a hardcoded body at `:147-155`, five ticks of the same drift). Real, and
  the next package once PR #8 is out of the way — editing the loop while a PR
  is in flight through it changes the thing under test.
- **New product features inside PR #8.** It is 87 files across five ticks; it
  gets smaller-or-equal from here, never larger, except for a review finding.
- **RFC or charter edits**, and any history rewrite of the PR #2-era vendored
  blobs.

### Delivery

Commits go to the **existing branch** `flow/drive-57e923c-08271542` and the
**existing PR #8**. Do not open a competing PR; do not cherry-pick this work
onto a fresh `flow/` branch. Every commit message names WP-9. The Lead reports
and awaits human review and merge.

---

## For the human merge reader (proposal, not a blocker)

PR #8 has consumed five drive ticks (WP-4 → WP-8), seven review rounds, and 43
persisted transcripts to deliver ~1,300 lines of SDK preflight code. The
review-round evidence itself is now the majority of the diff. The loop is
working — round 1 caught real defects and later rounds proved the fixes
load-bearing — but the cost per landed line is high and the PR keeps acquiring
new code between review rounds, which is what re-opened the review gap this
tick.

Two options, your call, neither blocking WP-9:

1. **Merge as-is once WP-9 closes** — gate 1 goes GREEN on re-verified merged
   `main`, and the review sediment merges with it.
2. **Split before merge** — land `sdk/` + `testdata/` + `docs/SURFACE.md` as
   the reviewable preflight change, and land `ops/reviews/` + `ops/DRIVE-LOG.md`
   as a separate evidence PR. Smaller merge surface, at the cost of one more
   tick.

I will proceed on option 1 unless told otherwise.

ASSESS_DONE
