/Users/khaliqgant/.zshenv:.:1: no such file or directory: /tmp/agent37-rust-0820.DWSmuv/cargo/env
# NEXT — single highest-priority work package

Written by the Relayflow Lead on 2026-08-27 (assess tick on branch
`flow/drive-45cc352-08272051`, HEAD = `45cc352` = `origin/main` byte-for-byte —
`git diff origin/main HEAD` is empty).

## Assessment snapshot (evidence)

- **Standing directives checked first** (`ops/DIRECTIVES.md`): the file carries
  **only its header — no active directive**. Directive 1 (de-vendor kernel
  deps) was satisfied and removed by PR #3. Nothing outranks the open PR this
  tick.

- **Open PRs: one, and it is blocked on review fixes.**
  `gh pr list --state open` → **PR #8 — "WP-4 — `flows check` preflight
  (covenant 2)"**, branch `flow/drive-57e923c-08271542`, OPEN, MERGEABLE/CLEAN.
  Its newest verdicts of record both reject:

  | Review of record | Head | Verdict |
  |---|---|---|
  | WP-6 swarm `39928a866198e7968bf1e15b` | `1bf885f` | **SWARM_FAILED** — maintainability FAILED, history FAILED, structure PASSED |
  | Independent diff review (`ops/reviews/20260827-2045-review.md`, commit `b43cd0f`) | `17f86e8` | **REVIEW_FAILED** — F1 (P0), F2/F3 (P1), F4–F8 (P2/P3) |

  The history lens's blocker was repaired at `a5e58d7`. The maintainability
  blocker **B1 / F1 is unrepaired**, because fixing it needs `sdk/src/**` and
  `sdk/tests/**` edits that WP-6 declared out of scope. The 20:45 reviewer's
  own words: *"the next package must be allowed to touch `sdk/src/cli.ts` and
  `sdk/tests/`, and this PR should not merge before it does."*

  **Therefore this tick starts no new work.** Per the charter and the standing
  rule, the work package is fixing the open PR.

- **The blocker, verified by me this tick — and it is worse than filed.** F1
  says `sdk/src/cli.ts:280-282` compares `pathToFileURL(process.argv[1]).href`
  to `import.meta.url`; npm installs `"bin": {"flows": "./dist/cli.js"}`
  (`sdk/package.json:8-10`) as a symlink, the ESM loader realpath-resolves
  `import.meta.url`, the two never match, and the process exits 0 having
  checked nothing. I reproduced the Node semantics from first principles in an
  isolated fixture rather than inheriting the claim:

  ```text
  $ node ~/.f1check/mod.mjs            # real path
  GUARD FIRED (would run the CLI)
  $ node ~/.f1check/bin/flows          # npm-style bin symlink to the same file
  (no output)  exit=0
  ```

  **New this tick:** the same fixture placed under `/tmp` failed the guard even
  when invoked *directly*, because macOS `/tmp` is itself a symlink to
  `/private/tmp`. The defect is therefore **not limited to npm's `.bin`
  symlink** — *any* symlinked component anywhere in `argv[1]`'s path silently
  disables the CLI. `realpathSync(argv[1])` before `pathToFileURL` restored the
  guard in both shapes. That widening must be stated in the fix and pinned by a
  test, or the fix will read as npm-specific when it is not.

- **Tests on `main` at assessment time** (this machine, hermetic `ops/cargo.sh`,
  no manually exported env):
  - `(cd kernel && ../ops/cargo.sh test --workspace)` → **70 passed, 0 failed**
    (18 + 0 + 19 + 24 + 3 + 6; doc-tests 0 ×3), exit 0.
  - `(cd sdk && npm test)` → **58 passed, 0 failed** (5 files), exit 0.
  - These are `main`'s numbers. PR #8's branch carries **72 kernel / 121 SDK**;
    both were re-measured by the 20:45 reviewer, and `ops/SCOREBOARD.md` on the
    branch matches. The preflight code does not exist on `main` — `sdk/src` here
    has no `cli.ts`, `preflight.ts` or `failure-kinds.ts`.

- **Current gate: gate 1.** RFC-0001 §3 done-when has two clauses. The ladder
  clause is closed on `main` (`ca6b80a`). The second clause — *"`flows check`
  refuses the ladder flows when a declared CLI is missing or unauthenticated or
  a trigger has no executor"* — is what PR #8 delivers, and through the shipped
  entrypoint it currently refuses **nothing**. Gate 1 stays **AMBER**;
  `ops/SCOREBOARD.md` already says so and must not move this tick.

- **Merge bar (`ops/RUN-CONTRACT.md` §3) is not met either**, independently of
  the charter's no-merge rail: item 3 requires *"an adversarial verdict whose
  text I read"* — the two newest are rejections. Items 1's caveat also applies:
  CodeRabbit and Devin report SUCCESS on PR #8 while neither reviewed
  (rate-limited / trial expired), so there is no external review signal at all.

- **Backlog** (`ops/BACKLOG.md`): every item is gate-2+ or process work. None
  outranks an open PR awaiting fixes.

- **Already closed, so it is not re-litigated:** the Codex P2 inline finding
  (`flows check` accepting `version: 9.9.9`) is fixed on the branch —
  `REFUSED [invalid_spec] spec.version: unsupported version "9.9.9"`, exit 2,
  re-executed by the 20:45 reviewer (row 8). Khaliq's 21:17 triage reply
  predates that fix and should be superseded in the PR body, not re-answered.

## Work package: WP-7 — make the shipped `flows check` binary real (PR #8 fixes)

### Objective

Close the review findings that block PR #8, in the one place WP-6 could not
touch: the artifact the SDK actually ships. When this package is done,
`flows check` refuses the same flows through `node dist/cli.js`, through an
npm-installed `bin` symlink, and through any symlinked path component — and the
probe taxonomy tells the operator the truth about which kind of failure
occurred. Then the swarm re-runs and must return `SWARM_PASSED` on the fixed
head.

**This continues PR #8 on its existing branch `flow/drive-57e923c-08271542`.
Do not open a second PR; do not branch from `main`.** Rebase or merge
`origin/main` in without rewriting history (the branch's prior commits are
review evidence and are cited by SHA in the PR body).

Required fixes, each with its finding id:

1. **F1 (P0) — the shipped entrypoint.** In `sdk/src/cli.ts`, resolve
   `process.argv[1]` through `realpathSync` before `pathToFileURL`, guarded for
   the absent-`argv[1]` case and for a `realpathSync` that throws (a deleted or
   unreadable `argv[1]` must not crash the module — decide and state the
   behavior). The comparison target `import.meta.url` is already realpath-based.
2. **F2 (P1) — the untested seam.** A test that **spawns the built artifact**
   (`sdk/dist/cli.js`) **through a symlink** and asserts exit 2 plus
   `REFUSED [cli_missing]` on `testdata/preflight/cli-missing.flow.yaml`, plus a
   case covering a symlinked *directory* component (the macOS `/tmp` shape).
   Every existing test calls `runCli()` in-process; that is why F1 survived eight
   review rounds. The test must depend on `npm run build` output — say in the
   test how the artifact is guaranteed built, or build it in the test.
3. **F4 (P2) — a signal-killed probe is not "unauthenticated".** `probeCli`
   (`sdk/src/cli.ts:189-195`) treats `{status: null, signal: 'SIGSEGV'}` as
   non-zero exit and tells the operator to authenticate a crashing binary.
   Route it to `probe_failed`, which exists for exactly this.
4. **F5 (P2) — `probe_failed` is unreachable from the resolution half.**
   `resolveExecutable` (`sdk/src/cli.ts:208-209`) discards
   `spawnSync('which', …).error`, so `env PATH= flows check` reports
   `cli_missing` for an installed `git`. `docs/SURFACE.md:80` — added by this PR
   — already promises *"a probe that cannot be executed at all is
   `probe_failed`"*. Make the code match the sentence.
5. **F6 (P2) — disclose what the probe executes.** `flows check` runs a
   flow-declared binary with `process.env` inherited wholesale
   (`sdk/src/cli.ts:189-193`, no `env` option), verified to leak an ambient
   secret into the probed script. **Fix in this package = one honest sentence in
   the Preflightable-CLI contract in `docs/SURFACE.md`** stating that checking a
   flow executes its declared CLI under the caller's environment. The scoped/
   allowlisted `env` is gate-8 work and is filed, not built, here.
6. **F7 (P2) — `docs/SURFACE.md:78` overclaims.** It says `flows check` prints
   cli, identity, workspace scopes, budget and tools; `emitReport`
   (`sdk/src/cli.ts:227-242`) prints diagnostics, `RESOLVED …` and
   `CHECK PASSED`. Narrow the sentence to what ships.
7. **F8 (P3) — probe once per CLI, not once per step.** `preflight()`
   (`sdk/src/preflight.ts:68-84`) probes inside the per-step loop: a 20-step
   flow makes 20 `auth status` subprocesses at 10s each. Memoise by
   `(cli, source)` for one `preflight()` call — a `Map`, entirely inside the
   pure module — and pin it with a probe-counting test. This also makes
   `SURFACE.md`'s "runs exactly that probe" true.
8. **F9 (P3) — document the trigger half.** `no_executor` is proven by string
   membership in the flow author's own `flows.json` (`sdk/src/cli.ts:181`);
   nothing contacts a registry or RelayCron. Write the `flows.json` schema
   (`cli`, `executors`, fail-closed on unknown keys) and that gate-1 limitation
   into `docs/SURFACE.md`, next to the CLI half.
9. **F10 (P3) — a stale citation inside the evidence record.**
   `ops/BACKLOG.md` cites `kernel/relayflowd-core/src/spec.rs:39-40` for
   `#[serde(default)] pub steps`; on the branch it is line 41. Fix the line
   numbers or cite by symbol.
10. **F11 (process) — disclose the DoD amendment.** `a5e58d7` rewrote WP-6's
    DoD item 4 in response to the history lens that judged it. The amendment is
    correct and was reviewer-forced; say so **in the PR body**, citing the H1
    transcript as its cause, so the record reads "reviewer forced a correction"
    rather than "the bar moved."
11. **PR body refresh.** Add the WP-7 round to the review table, mark F1–F10 by
    id with their fix commits, supersede the two 21:17 Codex triage replies with
    their true current state (the version finding is fixed; the deterministic
    path-like-missing tightening remains deliberately filed), and carry the
    re-executed command tails verbatim.

### Files in scope

- `sdk/src/cli.ts` — F1, F4, F5 (and nothing that grows it past its purpose;
  it is 282 lines today).
- `sdk/src/preflight.ts` — F8 only; the module must stay I/O-free.
- `sdk/tests/cli.test.ts`, `sdk/tests/preflight.test.ts`, and a **new**
  spawn-the-artifact test file (e.g. `sdk/tests/bin.test.ts`).
- `testdata/preflight/**` — new fixtures: a signal-killing probe CLI (F4), an
  empty-`PATH` case (F5), a multi-step shared-CLI flow (F8).
- `docs/SURFACE.md` — F6 disclosure, F7 narrowing, F9 trigger half.
- `ops/BACKLOG.md` — F10 citation fix; file F6's scoped-probe-env as gate-8
  work; keep the existing deterministic-command-tightening item.
- `ops/DRIVE-LOG.md`, `ops/SCOREBOARD.md` (evidence rows only — **gate 1 stays
  AMBER**), `ops/NEXT.md`, `ops/reviews/**` (new transcripts only; never edit an
  existing one).

Nothing under `kernel/` changes in this package.

### Definition of done

Every command below runs to the stated result on the branch head, and its
verbatim tail goes in the PR body.

```
(cd kernel && ../ops/cargo.sh test --workspace)      # exit 0, ≥ 72 passed, 0 failed
(cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings)   # exit 0
(cd kernel && ../ops/cargo.sh fmt --check)           # exit 0, empty output
(cd sdk && npm run build)                            # exit 0
(cd sdk && npm test)                                 # exit 0, ≥ 124 passed, 0 failed
```

Counts must not shrink: kernel **≥ 72**, SDK **≥ 121 + the new tests** (F2
needs at least two cases, F8 at least one; hence ≥ 124).

Behavioral gate — all of these, each quoted verbatim:

1. The seven recorded preflight cases still hold through `node sdk/dist/cli.js`
   (three ladder flows `CHECK PASSED` exit 0; `cli_missing`,
   `cli_unauthenticated`, `cli_unresolved`, `no_executor` each exit 2).
2. **The same refusals hold through a symlink to the built artifact** —
   `ln -s "$PWD/sdk/dist/cli.js" <dir>/flows && <dir>/flows check
   testdata/preflight/cli-missing.flow.yaml` → `REFUSED [cli_missing]`, exit 2.
3. **And through a symlinked directory component** (the macOS `/tmp` shape) —
   same refusal, exit 2.
4. **Mutation-verified**: revert the `realpathSync` clause, run the suite, show
   the new symlink test **fails**, restore the file byte-for-byte. A guard that
   would not have caught F1 is not a guard.
5. A CLI killed by a signal on `auth status` → `probe_failed`, not
   `cli_unauthenticated` (F4), with the fixture and its output shown.
6. `env PATH= node sdk/dist/cli.js check <flow with cli: git>` → `probe_failed`,
   not `cli_missing` (F5).
7. A 3-step flow sharing one flow-level `cli` produces exactly **1**
   `auth status` subprocess (F8), counted by the fixture's own log.
8. Every sentence changed in `docs/SURFACE.md` is true of the shipped code, and
   each of F6/F7/F9 is quotable from the file.

Scope and history guards (each must print nothing):

```
git diff origin/main HEAD -- workflows/     # the gate that judges this is untouched
git diff origin/main HEAD -- kernel/        # this package changes no kernel code
```

and every previously cited commit must still be an unmodified ancestor:

```
for c in a8c9110 d129750 497bc10 7062800 4ce3ff9 f0abdd4 1bf885f a5e58d7 17f86e8 b43cd0f; do
  git merge-base --is-ancestor $c HEAD && echo "$c ok" || echo "$c MISSING"; done
```

Review gate:

9. Re-run the swarm against PR #8 (`echo 8 > .review-target`, then
   `workflows/review-swarm.yaml`). **The aggregate must print `SWARM_PASSED`.**
10. Each of the three new transcripts must **name the head SHA it reviewed**,
    and that SHA must be the fixed head. The aggregate selects transcripts by
    `ls -t`, which cannot tell a fresh pass from a stale one — so this is
    asserted by reading the transcripts, not by the token. Do **not** edit
    `workflows/review-swarm.yaml` to enforce it; that file is the gate.
11. **Commit each transcript alone, immediately, as its own single-file
    commit.** The F0 evidence loss (a hard reset discarding staged, uncommitted
    transcripts) must not recur.
12. If any lens rejects again, the package is **not** done: fix or record, do
    not re-run for a better roll. An unchanged-code rerun to flip a verdict is a
    package failure.

The Lead does not merge. PR #8 stays open for a human, and `ops/SCOREBOARD.md`
keeps gate 1 **AMBER** until the second done-when clause is merged and
re-verified on `main`.

### Out of scope for this tick

- **Anything not required to clear PR #8's findings.** No new gate work opens
  while this PR is unfinished.
- **The scoped/allowlisted probe environment (F6's real fix)** — gate 8. This
  package discloses; it does not build.
- **Refusing deterministic commands whose executable is absent** (Codex P1) —
  the triage that a bare word may be a shell builtin stands; the narrow
  path-like-missing tightening remains a filed backlog item.
- **The platform-default rung** of the anonymous-resolution law, and any wider
  `flows check` ↔ `RunSpec::validate` dialect-parity work beyond what already
  ships.
- **`kernel/` changes of any kind**, including the two carried WP-3 residuals
  (P2-A pin/`worker_holds` disagreement, P3-B unvalidated non-agent pins).
- **Editing `workflows/review-swarm.yaml` or `workflows/drive.yaml`**, including
  the known `pr`-step title/body drift — a gate and a loop change do not belong
  inside the PR they would judge. File it; land it separately, judged by the
  pre-change swarm.
- **Merging**, flipping gate 1 off AMBER, RFC/charter edits, cloud schedule
  re-registration, the release pipeline, and every other `ops/BACKLOG.md` item.

### Delivery

Commits on `flow/drive-57e923c-08271542`, each naming WP-7 and the finding ids
it closes. Push updates PR #8 in place — no new PR. The PR body carries the
refreshed review table, the F1–F11 disposition, and every command tail above
verbatim. `ops/DRIVE-LOG.md` gets this tick's entry with the swarm's real
verdict, whatever it is.

ASSESS_DONE
