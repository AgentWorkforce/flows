# DRIVE-LOG — honest per-tick record of the flows drive loop

Append-only. One dated entry per tick. A tick that failed verification or
review is logged as failed — never reported as completed (fail closed).

---

## 2026-08-27 — tick on `flow/drive-9f07ffc-08270827` (base `9f07ffc`)

**Work package:** WP-1 — close gate-1 ladder rung (a) (from `ops/NEXT.md`,
consumed by this tick; source: `docs/bootstrap-report.md` §"Next three work
packages"). Exhaustive SIGKILL sweep for the pure deterministic hello flow
(before step 1, between every step pair, after the final effect, mid-step),
resume through the real `relayflowd resume` CLI, kill-under-`serve`,
journal-derived budget-exactness assertion, explained dead-attempt
`completionReason`s, plus the three bootstrap review observations
(`JournalClient.runStart` typed at the kernel dialect; `next_actions`
returns timers for all backing-off steps; `sdk/dist/` untracked) and a
repo-local cargo setup (`kernel/.cargo/config.toml` + vendored sources) so
the test gate runs despite the machine's broken `~/.cargo/registry` symlink.

**Verify (re-run by the Lead on the PR branch at log time, no manually
exported env vars):**

- `cd kernel && cargo test --workspace` — **33 passed, 0 failed** (suites:
  5+3+19+1+5, exit 0). Verbatim tail of the run:

  ```
     Doc-tests relayflowd_journal

  running 0 tests

  test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
  ```

- `cd kernel && cargo clippy --workspace -- -D warnings` — exit 0, tail:
  `Finished `dev` profile [unoptimized + debuginfo] target(s) in 4.08s`
- `cd kernel && cargo fmt --check` — exit 0, no output.
- `cd sdk && npm test` — exit 0, verbatim tail:

  ```
   Test Files  5 passed (5)
        Tests  50 passed (50)
     Start at  09:07:44
     Duration  364ms (transform 171ms, setup 0ms, collect 448ms, tests 74ms, environment 0ms, prepare 240ms)
  ```

**Review verdict:** REVIEW_PASSED — inferred from workflow gating (the `pr`
step only runs after the adversary step's `output_contains: REVIEW_PASSED`
verification, and the PR exists); the review transcript itself was not
persisted to the repo.

**PR:** [#2 — Close Gate 1 deterministic crash-resume rung](https://github.com/AgentWorkforce/flows/pull/2)
(open, awaiting human review/merge).

**Honest state of gate 1:** rung (a) is closed *on the branch*, not on
`main` — it becomes true only when PR #2 merges. Rung (b) (the `llm` step +
protocol verbs `worker.attach`, `step.heartbeat`, `step.complete`,
`run.watch`, `stream.*`, `event.emit`) and rung (c) (the `agent` step +
Appendix A pins) do not exist yet, so gate 1's done-when does not hold.
Two things a human should weigh at merge: (1) the cargo-registry fix
vendors all locked crate sources into `kernel/vendor/` — ~2.9M inserted
lines of third-party code in the PR diff; deliberate, but it is a repo-size
trade-off worth ratifying explicitly. (2) The tick's `ops/NEXT.md` commit
(`7dd08f6`) landed directly on `origin/main` rather than only on the flow
branch — harmless (docs-only) but off-process; the drive workflow's
sync/pr steps should be checked so drive commits stay on `flow/` branches.

**Likely next package:** WP-2 — gate-1 rung (b): implement the `llm` step
kind and the missing protocol verbs, per the bootstrap report's queue —
*unless* the next tick's assess finds PR #2 awaiting review fixes, in which
case the package is fixing it (no new work over unfinished work).

---

## 2026-08-27 — tick on `flow/de-vendor-wrapper-e715601` (base `e715601`)

**Work package:** WP-DIR-1 — de-vendor kernel deps (standing directive 1,
from `ops/NEXT.md`; directives outrank the backlog, so WP-2 waited).
Delivered on this branch: hermetic cargo wrapper `ops/cargo.sh` (execs
`env CARGO_HOME="<repo-root>/.cargo-home" cargo "$@"`), both workflow test
gates (`workflows/drive.yaml` verify, `workflows/bootstrap-gate1.yaml`
kernel-tests) rewired to invoke cargo through the wrapper, the
`!kernel/vendor/**` rule dropped from `.gitignore`, `kernel/README.md`
documenting the wrapper and the broken `~/.cargo/registry` symlink it
routes around, and directive 1 removed from `ops/DIRECTIVES.md` (satisfied
by this PR's own evidence). The vendor tree, `kernel/.cargo/config.toml`,
and the gitattributes rule were already deleted on main in `e715601`.

**Verify (re-run by the Lead on the PR branch at log time, no manually
exported env vars — including the full clean-checkout proof from the
definition of done):**

- Clean-checkout proof: `git clone --no-local` into a mktemp dir (branch
  `flow/de-vendor-wrapper-e715601` checked out), `kernel/vendor` absent
  (`NO VENDOR DIR: ok`), then `../ops/cargo.sh test --workspace` from the
  clone — crates fetched over the network into the clone's own
  `.cargo-home/`, exit 0. Verbatim tail:

  ```
  test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

  CLEAN_TEST_EXIT=0
  ```

  Clean-clone `clippy --workspace -- -D warnings` exit 0 (tail:
  `Finished `dev` profile [unoptimized + debuginfo] target(s) in 4.39s`);
  clean-clone `fmt --check` exit 0; clean-clone `sdk` `npm ci && npm test`
  → **50 passed, 0 failed** (5 files), exit 0.
- Working-tree `cd kernel && ../ops/cargo.sh test --workspace` — **33
  passed, 0 failed** across the workspace (test counts did not shrink vs
  the PR #2 baseline), exit 0. Verbatim tail:

  ```
     Doc-tests relayflowd_journal

  running 0 tests

  test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
  ```

- Working-tree clippy exit 0; `fmt --check` exit 0, no output.
- Working-tree `cd sdk && npm test` — exit 0, verbatim tail:

  ```
   Test Files  5 passed (5)
        Tests  50 passed (50)
     Start at  12:22:44
     Duration  416ms (transform 170ms, setup 0ms, collect 548ms, tests 93ms, environment 1ms, prepare 306ms)
  ```

- Plumbing checks on the branch: `git ls-files kernel/vendor` → 0 files;
  `git ls-files kernel/.gitattributes` → 0; no `vendored-sources` under
  `kernel/.cargo`; no `kernel/vendor` rule in `.gitignore`. All hold.

**Review verdict:** REVIEW_PASSED — again inferred from workflow gating
(the `pr` step runs only after the adversary step's
`output_contains: REVIEW_PASSED`, and PR #3 exists); the review transcript
was again not persisted (open backlog item "Persist review transcripts").

**PR:** [#3 — flow/de vendor wrapper e715601](https://github.com/AgentWorkforce/flows/pull/3)
(open, mergeable, awaiting human review/merge).

**Honest state:** directive 1 is satisfied *on the branch* — it becomes
true on `main` only when PR #3 merges. Current gate is still **gate 1**
(RFC-0001 §3): rung (a) closed on `main` via PR #2 (`74a3639`); rungs (b)
(`llm` step + protocol verbs `worker.attach`, `step.heartbeat`,
`step.complete`, `run.watch`, `stream.*`, `event.emit`) and (c) (`agent`
step + Appendix A pins) do not exist, so gate 1's done-when does not hold.
Process deviations a human should see at merge: (1) the PR body is
boilerplate — the definition of done required the clean-checkout evidence
pasted verbatim into the PR body, and it is not there (this log entry now
carries that evidence); (2) commit hygiene is off — `ops/cargo.sh` landed
inside the unrelated `docs(surface)` commit `0eb5f96`, and the rest of the
package (.gitignore, README, workflows, DIRECTIVES) inside the `drive: #
NEXT` commit `a7dfe7a`, so no commit names the work package; (3) the
branch carries two docs commits out of WP-DIR-1's scope, including an RFC
edit (`e346a2a`, gate-4 context answer) despite "any RFC or charter edits"
being explicitly out of scope — the adversary step passed the diff anyway;
(4) the PR title is just the branch name. None of these change the
verification result, but (1)–(3) are the kind of drift the drive
workflow's pr/adversary steps should be tightened against. Also note: the
vendored blobs from the PR #2 era remain in git history (history rewrite
stays a human decision, per NEXT.md's out-of-scope list).

**Likely next package:** WP-2 — gate-1 rung (b): implement the `llm` step
kind and the missing protocol verbs, per the bootstrap report's queue —
*unless* the next tick's assess finds PR #3 awaiting review fixes, in
which case the package is fixing it (no new work over unfinished work).

---

## 2026-08-27 — tick on `flow/drive-0ba6c88-08271225` (base `0ba6c88`)

**Work package:** WP-2 — `llm` step end to end (gate-1 ladder rung (b)),
from `ops/NEXT.md` (written by this tick's assess; directives were empty
and no PRs were open, so gate work was permitted). Delivered on this
branch: the seven missing protocol verbs (`worker.attach`,
`step.heartbeat`, `step.complete`, `run.watch`, `stream.append`,
`stream.read`, `event.emit`) implemented in
`kernel/relayflowd/src/server.rs` + new `server/session.rs` and
`server/wire.rs`; `ensure_deterministic`'s blanket refusal retired in
`engine.rs` in favor of real `llm` dispatch through new `engine/model.rs`
and `engine/remote.rs` (`agent` steps still fail closed at dispatch —
engine.rs:434 — that is rung (c)); out-of-band worker lease/heartbeat/
complete path with dead-worker attempts explained and re-leased;
verification-gated durable retry on llm output; rung-(b) fixture
`testdata/hello-llm.flow.yaml` with canonical spec + sha256 pinned on both
sides and parity tests extended; SDK client methods for the new verbs with
scripted-server coverage; and the crash sweep extended in
`tests/crash_resume/llm.rs` (+`llm_support.rs` deterministic stub worker —
no live model calls). The eight rung-(b) tests are named for what they
prove, including `sigkill_sweep_covers_before_and_between_the_rung_b_steps`,
`failing_llm_verification_schedules_a_durable_retry_and_succeeds`,
`llm_verification_exhaustion_is_a_declared_failure_kind`,
`worker_killed_while_holding_a_lease_is_explained_and_released_on_cli_resume`,
`sigkill_under_serve_mid_llm_releases_the_lease_and_finishes_via_cli_resume`,
`completed_llm_output_is_memoized_when_serve_dies_during_the_next_step`,
and `sigkill_after_the_final_rung_b_effect_resumes_without_redispatching_llm`,
with a journal-derived `assert_run_budget` helper backing the
budget-exactness claim.

**Verify (re-run by the Lead on the PR branch at log time, hermetic
wrapper, no manually exported env vars):**

- `cd kernel && ../ops/cargo.sh test --workspace` — **42 passed, 0
  failed** (suites 5+0+11+19+2+5, exit 0). Counts did not shrink vs the
  33-test baseline: crash_resume grew 3→11, spec_parity 1→2. Verbatim
  tail of the run:

  ```
     Doc-tests relayflowd_journal

  running 0 tests

  test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
  ```

- `cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings` — exit
  0, tail: `Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.26s`
- `cd kernel && ../ops/cargo.sh fmt --check` — exit 0, no output.
- `cd sdk && npm test` — **54 passed, 0 failed** (5 files; ≥ 50 baseline
  held, journal-client suite grew to 10 with the new verb tests), exit 0.
  Verbatim tail:

  ```
   Test Files  5 passed (5)
        Tests  54 passed (54)
     Start at  13:05:27
     Duration  355ms (transform 159ms, setup 0ms, collect 428ms, tests 64ms, environment 1ms, prepare 299ms)
  ```

**Review verdict:** REVIEW_PASSED — for the third consecutive tick this
is *inferred* from workflow gating (`workflows/drive.yaml`'s pr step runs
only after the adversary step's `output_contains: REVIEW_PASSED`, and PR
#4 exists); the review transcript was again not persisted. This gap is
now three ticks old (backlog item "Persist review transcripts").

**PR:** [#4 — drive: # NEXT — single highest-priority work package](https://github.com/AgentWorkforce/flows/pull/4)
(open, mergeable, awaiting human review/merge).

**Honest state of gate 1:** rung (b) is closed *on the branch*, not on
`main` — it becomes true only when PR #4 merges. Rung (a) is closed on
`main` (PR #2, `74a3639`). Rung (c) (`agent` step + Appendix A pins)
remains parse-only and fail-closed at dispatch, so gate 1's done-when
still does not hold. Process deviations a human should see at merge —
and these are *repeats* of exactly what `ops/NEXT.md`'s Delivery section
ordered fixed after PR #3: (1) the entire 2,199-line WP-2 implementation
rode inside the single `drive: # NEXT` commit (`8c9b5f5`) alongside the
assess's NEXT.md rewrite — no commit names WP-2; (2) the PR title is that
commit subject, not a statement of the work; (3) the PR body is the
boilerplate "Automated drive tick…" line — the definition of done
required the four verbatim verify tails pasted into the PR body, and they
are not there (this log entry now carries them). The verification results
themselves are clean; the drift is in the pr step, which evidently does
not read the Delivery constraints from NEXT.md. That step (or the
adversary's checklist) should be tightened before the next tick, or this
will recur a third time. Test-side caveat, stated honestly: the sweep's
"before and between every step pair" coverage is a single parameterized
test rather than one test per boundary, and mid-llm kills are exercised
via serve-death and worker-death paths; no boundary from the definition
of done is uncovered, but reviewers should read `llm.rs` rather than take
the count as one-test-per-kill-site.

**Likely next package:** WP-3 — gate-1 rung (c): `agent` step execution +
Appendix A pin semantics, per RFC-0001 §3 — *unless* the next tick's
assess finds PR #4 awaiting review fixes, in which case the package is
fixing it (no new work over unfinished work). Two standing candidates for
any slack: persist review transcripts (three ticks flagged), and harden
the drive workflow's pr step so commit hygiene / PR title / PR-body
evidence stop drifting.
