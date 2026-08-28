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

---

## 2026-08-27 — tick on `flow/drive-f59e279-08271341` (base `f59e279`)

**Work package:** WP-3 — `agent` step + Appendix A (gate-1 ladder rung (c)),
from `ops/NEXT.md` (written by this tick's assess; `ops/DIRECTIVES.md` carried
no active directives and no PR was open at assess time, so gate work was
permitted). Delivered on this branch in two implementation commits:

- `bb38c96` — `ensure_supported`'s blanket agent refusal retired; agent steps
  dispatch over the existing out-of-band worker path. Rule 1/2:
  `step.attempt.started` carries per-surface `revision_id` and per-stream
  `read_offset`, sourced from the worker as opaque strings (no mounts — gate 6).
  Rule 4: `reset` / `inspect` / `manual` all real, `manual` parking on
  `wait.human` and never re-dispatching. Rule 5: `effect.record` is a real verb
  returning `{deduped}` from the journal-boundary unique key, and
  `step.complete` carries the kernel's own `EffectRef`s instead of the worker's
  claims (`server.rs:238`'s hardcoded `Vec::new()` is gone). Rule 6: the end-pin
  chain is enforced in the fold — a success without `end_pins` and a broken
  chain are both `StateError`s. Rule 7: a rung-(c) crash sweep over five kill
  points against the real binary. `engine.rs` split to `engine/drive.rs`,
  `state.rs` split to `state/budget.rs` per the package's own size constraint.
- `e207a71` — closes all ten findings of the first review pass (see below),
  with four more subject splits (`machine/recovery.rs`, `state/pins.rs`,
  `server/client.rs`, `server/tests/agent/{pins,contract}.rs`).

Scope held: no RFC, charter or `workflows/` edits; `PermissionsSpec` still
data-only; no live agent CLI or model call anywhere in the gate — the stub
worker speaks the real protocol over the real socket, the rung-(b)
`llm_support.rs` pattern.

**Verify (re-run by the Lead on the PR branch at log time, hermetic
`ops/cargo.sh`, no manually exported env vars):**

- `cd kernel && ../ops/cargo.sh test --workspace` — **65 passed, 0 failed**
  (16 + 0 + 18 + 23 + 3 + 5), exit 0. Baseline was 47 and the DoD floor ≥ 47;
  no suite shrank (relayflowd lib 8→16, crash_resume 13→18, core lib 19→23,
  spec_parity 2→3, journal 5). Verbatim tail:

  ```
     Doc-tests relayflowd_journal

  running 0 tests

  test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
  ```

- `cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings` — exit 0.
  Verbatim tail:

  ```
      Checking relayflowd v0.1.0 (/Users/khaliqgant/Projects/AgentWorkforce/flows/kernel/relayflowd)
      Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.72s
  ```

- `cd kernel && ../ops/cargo.sh fmt --check` — exit 0, no output (0 bytes).

- `cd sdk && npm test` — **56 passed, 0 failed** (5 files; DoD floor ≥ 54),
  exit 0. Verbatim tail:

  ```
   Test Files  5 passed (5)
        Tests  56 passed (56)
     Start at  14:55:44
     Duration  305ms (transform 118ms, setup 0ms, collect 450ms, tests 80ms, environment 0ms, prepare 224ms)
  ```

- Size constraint: `find kernel -name '*.rs' -not -path '*/target/*' | xargs wc -l`
  → largest is `relayflowd/src/server/session.rs` at **441**; nothing over 500.

**Review verdict: REVIEW_PASSED — and for the first time it is *read from a
persisted transcript*, not inferred from workflow gating.** The review step's
`ops/reviews/` wiring fired, which closes a gap this log has carried for three
ticks. Two passes are on disk:

- `ops/reviews/20260827-1415-review.md` — **REVIEW_FAILED**, ten findings
  (3× P1, 3× P2, 4× P3). Three were reproduced defects that left a run wedged
  with a raw `internal` error and no terminal journal entry — the failure class
  the package's own DoD forbids — and one of them was a regression on the
  rung-(b) path that shipped green in PR #4.
- `ops/reviews/20260827-1452-review.md` — **REVIEW_PASSED** on `e207a71`, with
  all ten findings re-checked one by one against shipped code and three of the
  new guards **mutation-verified** as load-bearing (each mutation applied, suite
  run, file restored byte-for-byte): reverting the `parked`/`waiting_worker`
  distinction reproduces the original 30.58s timeout end to end through the real
  CLI; removing the `worker_holds` decline fails its named test;
  short-circuiting `resolve_agent_pins` wedges the run so its test never
  completes. `crash_resume` was run 3× back to back (18 each, 0.77–0.82s) — no
  flake.

The red→green loop working on its own output is the notable thing this tick:
the reviewer found real defects, the package fixed them, the second pass proved
the fixes load-bearing rather than accepting them.

**PR:** [#7 — flow/drive f59e279 08271341](https://github.com/AgentWorkforce/flows/pull/7)
(OPEN, MERGEABLE, 39 files; CodeRabbit and Devin Review both SUCCESS; no human
review yet). The Lead does not merge — awaiting human review, per the charter.

**Honest state of gate 1:** still open, on two counts.

1. Rung (c) is closed **on the branch, not on `main`** — it becomes true only
   when PR #7 merges. Rungs (a) and (b) are closed on `main` (PRs #2 and #4).
2. Even with #7 merged, gate 1's done-when does **not** hold: its second clause
   is the **`flows check` preflight (covenant 2)**, which does not exist (no
   `check`/preflight symbol in `sdk/src`, no CLI binary in `sdk/package.json`).

**Process drift a human should see at merge — and the root cause is now
pinpointed.** The PR title is again the branch name and the PR body is again
the boilerplate `"Automated drive tick. Work package: see ops/NEXT.md in
diff…"` line, for the fourth consecutive tick, despite `ops/NEXT.md` requiring
the four verify tails verbatim in the PR body. This is not the agent ignoring
the instruction — it is `workflows/drive.yaml:108-115`, whose `pr` step is a
`deterministic` command that (a) hardcodes that body string, so the tails can
**never** land there, (b) builds the commit subject as
`grep -m1 -oE 'WP-[0-9]+[^\n]*' ops/NEXT.md | cut -c1-60`, which is a *byte*
cut across the multibyte em-dash and truncated `07f2a14` to the literal
`` drive: WP-3 — `age ``, and (c) calls `gh pr create --fill`, which falls back
to the branch name for the title whenever the branch has more than one commit.
Fixing the `pr` step — not re-instructing the agent — is what stops this
recurring. Commit hygiene itself is *better* than prior ticks: both
implementation commits name WP-3 and describe their work; only the log-step
commit is mangled.

Two more items for the merge reader:

- **The branch was not rebased before the PR opened**, though the 14:52 review
  asked for it. `main` moved twice after the merge base `e0d65f1` (`3ad378c`,
  `2a83a3b`, both `ops/`-only), so a local `git diff main..HEAD` reports 42
  files and shows `ops/RUN-CONTRACT.md`, `ops/SCOREBOARD.md` and part of
  `ops/BACKLOG.md` as deletions this branch never made. GitHub's own diff uses
  the merge base and is honest (39 files) — the trap is local only.
- **The review's two residual findings were not carried anywhere durable.** The
  14:52 pass said they belong in the PR body and the backlog; the PR body is
  boilerplate and `ops/BACKLOG.md` gained only the regression-suite item this
  tick. This log commit adds them to the backlog so they are not lost with the
  transcript. Neither blocks: **P2-A** — `agent_pins_available`
  (`engine.rs:316-328`) and `worker_holds` (`session.rs:353-355`) disagree once
  a step has started, so a step pinned to a surface the attached worker does not
  hold burns one journaled attempt per resume forever (`max_iterations` never
  binds, because `abandonment_actions` gates on `semantic_executions` and a
  crashed attempt consumes none); the run stays honestly `parked`, performs no
  effect and heals when a compatible worker attaches, and it is unreachable in
  the shipped rung-(c) flow. **P3-B** — a non-agent completion may still journal
  unvalidated `started_pins`/`end_pins` (the symmetric case to the `effects`
  claim that P2-6 closed); harmless today because `apply_step_completed` only
  reads `end_pins` for agent steps.

Also carried forward honestly from the review, so it is not re-discovered as
new: an undispatchable agent step parks the whole run even when an independent
deterministic step is `Runnable`. That shape is **pre-existing** on `main`
(`engine.rs:220-239` at `e0d65f1`), not a WP-3 regression. And v0's
record-before-perform effect path is **at-most-once, not exactly-once** — this
is a disclosure in `kernel/DESIGN.md` §1.9 rather than a fix, which is what
`ops/NEXT.md` prescribed; closing it needs the mount as writer (gate 4).

**Likely next package:** the **`flows check` preflight (covenant 2)** — gate
1's remaining done-when clause, explicitly named as "the package after this
one" in this tick's `ops/NEXT.md`, and now unblocked because the preflight must
be able to refuse a rung-(c) flow and rung (c) is real. *Unless* the next
tick's assess finds PR #7 awaiting review fixes, in which case the package is
fixing it (no new work over unfinished work). Note for that assess: PR #6
(`flows/relaycast-500-regression`) is open as a **DRAFT** and is not this
loop's work — decide explicitly whether a draft PR counts as unfinished work
before treating it as a blocker. Standing candidates for slack, in order:
harden `workflows/drive.yaml`'s `pr` step (title, body evidence, the `cut -c`
truncation) — four ticks of the same drift with a now-known root cause; then
the two residual WP-3 findings above.

---

## 2026-08-27 — WP-4 `flows check` preflight

**Work package:** WP-4 — covenant-2 preflight, gate 1's second done-when
clause, from `ops/NEXT.md`. The SDK now ships the `flows check` binary and a
pure preflight evaluator whose environment probes are injected. Agent CLI
resolution is step → flow header → nearest `flows.json`, with no guessed
platform default. The four required author-facing refusal kinds are distinct:
`cli_missing`, `cli_unauthenticated`, `cli_unresolved`, and `no_executor`.
Unexpected probe failures and CLI input failures also terminate in the closed
declared taxonomy. Resolved deterministic commands emit
`unprovable_effects` warnings to stderr without refusing.

The spec carries `cli` on `llm`/`agent` steps, a flow-header `cli`, and inert
root `triggers`; the SDK compiler and Rust parser preserve those fields across
the canonical boundary. No trigger matching, dispatch, provider call,
permission enforcement, or live model/agent invocation was added. Fixture
executables and injected probes make missing/auth faults hermetic. The three
ladder canonical JSON/hash fixtures were regenerated and both parity suites
pin them. The kernel regression enumerates every failed-step
`CompletionReason` and proves the failed run ends in typed `step_failed`.

[ERRATA R4 — this describes the superseded 16:03 tree. After the F3 repair,
all three canonical JSON files and their `.sha256` pins are byte-identical to
`main`; see "WP-4 review round 2 + record correction" and the WP-4-FIX tick.]

**Definition of done (hermetic `ops/cargo.sh`, no manually exported env):**

- `cd kernel && ../ops/cargo.sh test --workspace` — **72 passed, 0 failed**
  (18 + 0 + 19 + 26 + 3 + 6; doc-tests 0 ×3), exit 0. Verbatim tail:

  ```
     Doc-tests relayflowd_journal

  running 0 tests

  test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
  ```

- `cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings` — exit 0.
  Verbatim tail:

  ```
      Checking relayflowd v0.1.0 (/Users/khaliqgant/Projects/AgentWorkforce/flows/kernel/relayflowd)
      Finished `dev` profile [unoptimized + debuginfo] target(s) in 2.68s
  ```

- `cd kernel && ../ops/cargo.sh fmt --check` — exit 0, no output.

- `cd sdk && npm run build` — exit 0. Verbatim output:

  ```
  npm notice run @relayflows/sdk@0.1.0 build
  npm notice run tsc
  ```

- `cd sdk && npm test` — **76 passed, 0 failed**, 7 files, exit 0. Verbatim
  tail:

  [ERRATA R2 — this 76-test result and tail are pre-fix evidence from the 16:03
  tree, not evidence for the shipped diff. See "WP-4 review round 2 + record
  correction" and the WP-4-FIX tick for executed evidence from the final tree.]

  ```
   Test Files  7 passed (7)
        Tests  76 passed (76)
     Start at  16:03:45
     Duration  412ms (transform 179ms, setup 0ms, collect 592ms, tests 224ms, environment 1ms, prepare 329ms)
  ```

**Behavioral gate:** all three ladder flows exited 0, printed their resolved
CLI source, and emitted only warnings on unprovable deterministic effects.
The `cli-missing`, `cli-unauthenticated`, `cli-unresolved`, and `no-executor`
fixtures each exited 2 with its exact declared kind. The required JSON pipe
exited 0 through `python3 -m json.tool`; its single diagnostic carried
`"kind": "cli_missing"`. The clean warning and project-default fixtures are
also pinned by CLI tests.

**Structural gate:** the largest Rust file is
`kernel/relayflowd/src/server.rs` at **468** lines; the largest SDK source is
`sdk/src/validate.ts` at **454**. No source file reaches 500 lines.

**Review:** no independent review transcript was produced. The Veto MCP server
required by the repository wrapper was not present in this non-interactive
worker's available tools, and spawning/messaging review agents was explicitly
forbidden by the invocation. This entry does not infer `REVIEW_PASSED` from
the green gates. A local full-diff and fail-closed-path audit found and fixed
one compiled-spec issue before final verification: type-specific unknown keys
and malformed retry policies now refuse instead of being dropped.

[ERRATA R1 — false as of `823e35a`: two review transcripts and a repair note
are committed in this same diff. See "WP-4 review round 2 + record correction"
and the WP-4-FIX third-review transcript.]

**Gate state:** gate 1 is GREEN in this branch on both clauses. The scoreboard
records the correction from its premature rung-only GREEN through AMBER and
the evidence that closes preflight. It becomes repository state only when a
human merges the PR; this worker does not merge.

[ERRATA R3 — this overstates the gate. Gate 1 remains AMBER while clause 2 is
unmerged; see "WP-4 review round 2 + record correction" and the WP-4-FIX tick.]

---

## 2026-08-27 — WP-4 review round 2 + record correction (`flow/drive-57e923c-08271542`, base `57e923c`)

**Work package:** still **WP-4 — the covenant-2 `flows check` preflight** (gate
1's second done-when clause, from `ops/NEXT.md`). No new work was started over
it. This tick is the log obligation for the review round that ran *after* the
preceding entry was written at 16:03, plus the record correction that round
demanded. Two adversarial reviews and one repair pass landed in that window and
none of them are described above, because the entry above predates them.

### Errata against the 16:03 entry (it is wrong on four points)

The preceding entry's original text is left byte-for-byte intact — this log is
append-only, so the corrections are recorded here as errata, with bracketed
forward pointers inserted at each stale site. No committed claim was rewritten
or history changed to make this work look better.

- **R1 — "no independent review transcript was produced" is false as of now.**
  It was true when written. Three transcripts landed afterwards and are
  committed at `823e35a`: `ops/reviews/20260827-1611-review.md`
  (**REVIEW_FAILED**), `ops/reviews/20260827-1620-wp4-fixes.md` (the repair),
  and `ops/reviews/20260827-1627-review.md` (**REVIEW_FAILED**). The claim must
  not be read forward.
- **R2 — the `npm test` tail quoted above (76 passed, 7 files, 16:03:45) is
  superseded.** It is a pre-fix count. The current tree is **99 passed**. The
  quoted block is verbatim but no longer evidence for the shipped diff.
- **R3 — "gate 1 is GREEN in this branch on both clauses" overstates it.** It
  is AMBER, for the reasons in *Gate state* below. `ops/SCOREBOARD.md` already
  said AMBER while the entry beside it said GREEN.
- **R4 — "the three ladder canonical JSON/hash fixtures were regenerated" is
  superseded.** After the F3 repair, all three canonical JSON files and their
  `.sha256` pins are byte-identical to `main`; the final diff ships no fixture
  regeneration.
- One further stale number, found and fixed in this tick:
  `ops/SCOREBOARD.md:8` cited "SDK 95 tests" against a measured 99. Corrected
  to 99 in this commit. That is the only file besides this log that this tick
  touched.

### Review verdict: REVIEW_FAILED (second pass, 16:27) — on the record, not the code

Round 1 (16:11) returned **REVIEW_FAILED** on three findings: **F1 (HIGH)** a
fail-open — an unresolvable deterministic command passed `check` with `ok: true`
and zero diagnostics, inside the very covenant-2 clause the package exists to
close; **F2** the clause's literal subject (the *ladder* flows under induced
fault) was never tested, substituted by stand-in fixtures without disclosure;
**F3** a self-certifying behavioral gate resting on a stub committed into the
canonical gate-1 artifacts and their hash pins.

The repair (16:20) answered all three by changing code, not by re-arguing:
`sdk/src/preflight.ts:167-213` now leaves exactly one warning on **every**
deterministic step across all three knowable states (`unprovable_effects`,
`command_unresolved`, `command_unprovable`, the latter two declared in
`sdk/src/failure-kinds.ts:23-33`); warn-not-refuse was chosen because
`kernel/relayflowd/src/exec_det.rs:22-27` runs string commands through
`/bin/sh -c`, so an unresolved first word may be a builtin — the executor was
read, not assumed.

Round 2 (16:27) confirmed **F1/F2/F3 are genuinely closed**, re-ran every DoD
command on its own, and still returned **REVIEW_FAILED** — explicitly stating
"no code change is required." The remaining grounds were R1/R2/R3 above: the
`ops/DRIVE-LOG.md` deliverable denied the review that produced the fix, quoted
a superseded test count as verbatim evidence, and re-asserted a GREEN the
scoreboard beside it had already retracted. This tick's entry is the response
to that verdict. **A third review has not run, so the verdict standing on the
record is REVIEW_FAILED.** This entry does not upgrade it.

### Verify — re-executed in this tick from the current tree (hermetic `ops/cargo.sh`, no exported env)

- `cd kernel && ../ops/cargo.sh test --workspace` — exit 0, **72 passed, 0
  failed** (18 + 0 + 19 + 26 + 3 + 6; doc-tests 0 ×3). Verbatim tail:

  ```
     Doc-tests relayflowd_journal

  running 0 tests

  test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
  ```

- `cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings` — exit 0.
  Verbatim tail:

  ```
      Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.13s
  ```

- `cd kernel && ../ops/cargo.sh fmt --check` — exit 0, output 0 bytes.

- `cd sdk && npm run build` — exit 0. Verbatim output:

  ```
  > @relayflows/sdk@0.1.0 build
  > tsc
  ```

- `cd sdk && npm test` (`tsc --noEmit && vitest run`) — exit 0, **99 passed, 0
  failed**, 7 files. Verbatim tail:

  ```
   Test Files  7 passed (7)
        Tests  99 passed (99)
     Start at  16:29:31
     Duration  762ms (transform 275ms, setup 0ms, collect 818ms, tests 473ms, environment 2ms, prepare 443ms)
  ```

**Behavioral gate, re-run against `sdk/dist/cli.js` in this tick** — the three
ladder flows exit 0 (`CHECK PASSED hello-ladder|hello-llm|hello-agent`), and
each induced fault exits 2 with its exact declared kind:

```
cli-missing          exit=2  REFUSED [cli_missing] Step "answer" declares CLI "./missing-cli", but it is missing.
cli-unauthenticated  exit=2  REFUSED [cli_unauthenticated] Step "edit" declares CLI "./unauthenticated-cli", but its auth probe failed.
cli-unresolved       exit=2  REFUSED [cli_unresolved] Step "answer" has no CLI at step, flow, or project level.
no-executor          exit=2  REFUSED [no_executor] Trigger "orphaned-schedule" has no registered executor "absent-executor".
```

`check --json preflight/cli-missing.flow.yaml | python3 -m json.tool` exits 0
and carries exactly one diagnostic, `"kind": "cli_missing"`, `"ok": false`.

**Structural:** largest kernel `.rs` is `kernel/relayflowd/src/server.rs` at
**468**; largest SDK source is `sdk/src/validate.ts` at **454**. Under 500.

**PR:** https://github.com/AgentWorkforce/flows/pull/8 — *WP-4 — flows check
preflight (covenant 2)*, **OPEN**, not a draft, MERGEABLE, `reviewDecision: ""`
(no human review requested yet). Checks: CodeRabbit "pass" but rate-limited to
a skipped review; Devin Review "pass" with "Full review skipped: trial expired
and no credits remaining". **Neither bot actually reviewed this diff** — the
two green check marks on PR #8 carry no review signal and must not be read as
independent confirmation.

### Gate state — gate 1 is **AMBER**, honestly

Clause 1 (the three ladder rungs) is merged and closed on `main` (#2/#3, #4,
#7 `ca6b80a`). Clause 2's implementation is complete on this branch and was
independently re-verified by a reviewer who ran every DoD command on its own
tree. It is nevertheless **not closed**, on two counts, either of which alone
blocks GREEN:

1. **PR #8 is unmerged.** Branch state is not repository state; this worker
   does not merge, and no human has reviewed it.
2. **The standing review verdict is REVIEW_FAILED.** Round 2 said the code is
   sound and the record was not. This entry answers the record grounds, but a
   verdict is not overturned by the party it was issued against.

Residual carried forward unchanged and not re-discovered as new: v0's
record-before-perform effect path is **at-most-once, not exactly-once**
(disclosed in `kernel/DESIGN.md` §1.9, closable only with the mount as writer —
gate 4); **P2-A** the `agent_pins_available` / `worker_holds` disagreement
(`engine.rs:316-328`, `session.rs:353-355`); **P3-B** unvalidated
`started_pins`/`end_pins` on non-agent completions; and the pre-existing (on
`main` at `e0d65f1`) shape where an undispatchable agent step parks a whole run
even when an independent deterministic step is `Runnable`.

### Harness drift observed this tick (for the human, not for this worker to fix)

- **The review gate cannot express an honest refusal.**
  `workflows/drive.yaml:114-116` verifies the review step with
  `output_contains: REVIEW_PASSED` at `maxIterations: 1`, so a truthful
  `REVIEW_FAILED` reaches the harness as `failed_verification` —
  indistinguishable from a reviewer that crashed. That conflation is what
  routed a well-evidenced refusal into a repair loop. The 16:20 repair note
  deliberately left it unchanged, correctly: widening the gate to accept
  `REVIEW_FAILED` would let the `pr` step run on a refused diff, and editing
  the gate that judges your own work is what AGENTS.md forbids. The right shape
  is probably a third outcome that routes back to `build`. **Human's call.**
- **The `pr` step's commit-title truncation recurred, fifth tick running.**
  `workflows/drive.yaml`'s `cut -c1-60` produced the literal commit title of
  `823e35a`, cut mid-word and mid-parenthesis:

  ```
  drive: WP-4 — `flows check` preflight (cove
  ```

  Root cause is known; the fix keeps getting deferred behind gate work.

### Likely next package

**A third adversarial review pass on the corrected record**, since the standing
verdict is REVIEW_FAILED and R1–R3 are the only open grounds; no code work is
queued behind it. If that pass returns REVIEW_PASSED, the package after it is
**not new gate work** but the human merge of PR #8, which is what flips gate 1
to GREEN in `ops/SCOREBOARD.md`.

Only once gate 1 is merged does gate selection reopen: per the scoreboard, gate
6 (integrations via relayfile) is eligible after gate 1, with gates 2 and 5
also in the frame — that choice belongs to the next assess on current evidence,
not to this entry. Standing candidates for slack, in order: harden
`workflows/drive.yaml`'s `pr` step (title, body evidence, the `cut -c`
truncation) — five ticks of the same drift; then the review-gate third-outcome
question above; then the two residual WP-3 findings (P2-A, P3-B). PR #6
(`flows/relaycast-500-regression`) remains a **draft**, was ruled in this
tick's `ops/NEXT.md` to be neither blocking nor this loop's work, and that
ruling stands — it documents a defect in `relaycast-cloud` (filed as
AgentWorkforce/relaycast-cloud#88) that no code in this repo can close.

---

## 2026-08-27 — WP-4-FIX: PR #8 reconciled, reviewed, and made mergeable

**Work package:** WP-4-FIX from `ops/NEXT.md`: clear PR #8's standing
`REVIEW_FAILED`, reconcile it with `main`, correct the shipped record, close
R5's dead test mutation, and triage both open Codex findings without starting
new gate work.

`origin/main` at `73bdb59` was merged into the existing
`flow/drive-57e923c-08271542` branch as two-parent merge `29f681f` (parents
`6a425b6` and `73bdb59`). No rebase, squash, force-push, or history rewrite
occurred. The only conflict was `ops/SCOREBOARD.md`; its resolution keeps
main's corrective parenthetical, retains gate 1 **AMBER**, adds the branch's
preflight evidence, and uses the measured 72/99 counts below. Main's typed
`review` + deterministic `verdict` steps arrived unchanged with the merge.

**Record and R1–R5:** the four stale sites in the 16:03 entry retain their
original text and now carry in-place `[ERRATA R1]` through `[ERRATA R4]`
forward pointers. R4 is also present in the round-2 errata list. The stale
no-review claim, 76-test result, branch-GREEN claim, and fixture-regeneration
claim are therefore no longer unmarked. All six canonical JSON / `.sha256`
fixtures are byte-identical to `main`. `sdk/tests/cli.test.ts` no longer
deletes a nonexistent `flow['cli']`; its comment names relocation into the
empty `flows.json` as the actual `cli_unresolved` fault. A targeted verbose run
passed the fixture case and all three ladder cases: 4 passed, 26 skipped,
exit 0.

**Backlog:** one item records P1 and P2 together as cases where check can accept
what the kernel later refuses. No `sdk/src/**` or `kernel/**` behavior changed
in WP-4-FIX.

### Verify — executed on the merged tree in this tick

- `(cd kernel && ../ops/cargo.sh test --workspace)` — exit 0, **72 passed,
  0 failed** (18 + 0 + 19 + 26 + 3 + 6; doc-tests 0 ×3). Verbatim tail:

  ```text
     Doc-tests relayflowd_journal

  running 0 tests

  test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
  ```

- `(cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings)` — exit 0.
  Verbatim output:

  ```text
      Checking relayflowd-core v0.1.0 (/Users/khaliqgant/Projects/AgentWorkforce/flows/kernel/relayflowd-core)
      Checking relayflowd-journal v0.1.0 (/Users/khaliqgant/Projects/AgentWorkforce/flows/kernel/relayflowd-journal)
      Checking relayflowd v0.1.0 (/Users/khaliqgant/Projects/AgentWorkforce/flows/kernel/relayflowd)
      Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.75s
  ```

- `(cd kernel && ../ops/cargo.sh fmt --check)` — exit 0, empty output.

- `(cd sdk && npm run build)` — exit 0. Verbatim output:

  ```text
  > @relayflows/sdk@0.1.0 build
  > tsc
  ```

- `(cd sdk && npm test)` — exit 0, **99 passed, 0 failed**, 7 files. Verbatim
  tail:

  ```text
   Test Files  7 passed (7)
        Tests  99 passed (99)
     Start at  17:12:51
     Duration  879ms (transform 297ms, setup 0ms, collect 728ms, tests 703ms, environment 1ms, prepare 427ms)
  ```

**Structural gate, verbatim:**

```text
     465 kernel/relayflowd/src/server/session.rs
     468 kernel/relayflowd/src/server.rs
   10045 total
     370 sdk/src/cli.ts
     454 sdk/src/validate.ts
    2385 total
```

### Behavioral gate — all seven cases executed on the merged tree

```text
$ node sdk/dist/cli.js check testdata/hello-ladder.flow.yaml
WARNING [unprovable_effects] Step "greet" command "echo" resolves, but its effects cannot be proven before execution.
RESOLVED step "plan" cli "./preflight/authenticated-cli" from project
RESOLVED step "act" cli "./preflight/authenticated-cli" from project
CHECK PASSED testdata/hello-ladder.flow.yaml
exit=0

$ node sdk/dist/cli.js check testdata/hello-llm.flow.yaml
WARNING [unprovable_effects] Step "greet" command "printf" resolves, but its effects cannot be proven before execution.
WARNING [unprovable_effects] Step "finish" command "printf" resolves, but its effects cannot be proven before execution.
RESOLVED step "answer" cli "./preflight/authenticated-cli" from project
CHECK PASSED testdata/hello-llm.flow.yaml
exit=0

$ node sdk/dist/cli.js check testdata/hello-agent.flow.yaml
WARNING [unprovable_effects] Step "greet" command "printf" resolves, but its effects cannot be proven before execution.
WARNING [unprovable_effects] Step "finish" command "printf" resolves, but its effects cannot be proven before execution.
RESOLVED step "edit" cli "./preflight/authenticated-cli" from project
CHECK PASSED testdata/hello-agent.flow.yaml
exit=0

$ node sdk/dist/cli.js check testdata/preflight/cli-missing.flow.yaml
REFUSED [cli_missing] Step "answer" declares CLI "./missing-cli", but it is missing.
RESOLVED step "answer" cli "./missing-cli" from step
exit=2

$ node sdk/dist/cli.js check testdata/preflight/cli-unauthenticated.flow.yaml
REFUSED [cli_unauthenticated] Step "edit" declares CLI "./unauthenticated-cli", but its auth probe failed.
RESOLVED step "edit" cli "./unauthenticated-cli" from step
exit=2

$ node sdk/dist/cli.js check testdata/preflight/cli-unresolved.flow.yaml
REFUSED [cli_unresolved] Step "answer" has no CLI at step, flow, or project level.
exit=2

$ node sdk/dist/cli.js check testdata/preflight/no-executor.flow.yaml
WARNING [unprovable_effects] Step "ready" command "printf" resolves, but its effects cannot be proven before execution.
REFUSED [no_executor] Trigger "orphaned-schedule" has no registered executor "absent-executor".
exit=2
```

### Review verdict — read from the persisted transcript

`ops/reviews/20260827-1714-review.md` is the third adversarial review. It read
rounds 1 and 2, audited R1–R5, re-checked merge integrity and scope, and ends:

```text
REVIEW_PASSED
```

The verdict is taken from that transcript, not inferred from test or workflow
status.

### Codex inline findings — triaged at pushed HEAD `57c0c3e`

- **P1:** partly right; current warn-not-refuse behavior is defensible for a
  bare command word because `/bin/sh -c` may resolve a builtin, function, or
  assignment. The minute-zero case is real for a path-like word containing `/`
  whose path does not exist. Reply posted at HEAD; backlog follow-up says to
  refuse that narrow case and retain the warning otherwise.
- **P2:** genuine and unfixed; `flows check` can accept a version the kernel
  rejects and reject a kernel-valid spec whose optional `name` is absent.
  Reply posted at HEAD; the shared backlog follow-up requires exact
  kernel-dialect validation.

Neither finding is implemented in this fix-only package. CodeRabbit and Devin
green checks are not cited as review signal.

### PR #8 — updated in place, not merged

The PR body was rebuilt from the five executed results and all seven behavioral
outputs above. Both inline Codex comments received replies at pushed HEAD. A
point-by-point reply to Khaliq's blocking comment records the corrected log,
fresh evidence, merge reconciliation, R5 closure, third review, and the human
merge decision that remains.

Within 60 seconds of those updates, the required live query returned verbatim:

```json
{"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","reviewDecision":"","statusCheckRollup":[{"__typename":"StatusContext","context":"CodeRabbit","startedAt":"2026-08-27T21:16:24Z","state":"SUCCESS","targetUrl":""},{"__typename":"StatusContext","context":"Devin Review","startedAt":"2026-08-27T21:16:17Z","state":"SUCCESS","targetUrl":"https://app.devin.ai/review/agentworkforce/flows/pull/8"}]}
```

PR: https://github.com/AgentWorkforce/flows/pull/8 — **OPEN**, `MERGEABLE` /
`CLEAN`. This worker did not merge it.

### Gate state — gate 1 remains **AMBER**

Clause 1 is merged and closed on `main`. Clause 2 is implemented, reconciled,
verified, reviewed, and mergeable on PR #8, but remains unmerged branch state.
Only a human merge followed by a fresh run on `main` may move gate 1 off AMBER.
No new gate work begins before that action.

## 2026-08-27 17:31 EDT — WP-4-FIX tick: round-4 review verdict, re-verified at `51251c5`

**Work package:** WP-4-FIX from `ops/NEXT.md` — land PR #8 by clearing its
standing `REVIEW_FAILED`, reconciling the branch with `main`, correcting the
shipped record, and triaging the open bot findings. **No new gate work.** This
entry records the state *after* the round-4 review, which landed in `51251c5`
and is therefore not covered by the preceding entry.

Branch `flow/drive-57e923c-08271542` at `51251c5`, identical to
`origin/flow/drive-57e923c-08271542` and to PR #8's `headRefOid` (0 ahead,
0 behind origin). The only commit added since the previous entry is `51251c5`,
which adds `ops/reviews/20260827-1726-review.md` (337 lines) and **changes no
code** — `git show --stat 51251c5` lists that one file.

### Verify — re-executed in this tick on the working tree at `51251c5`

Hermetic `ops/cargo.sh`, no exported env. These are measured numbers, not
inherited ones.

- `(cd kernel && ../ops/cargo.sh test --workspace)` — **exit 0, 72 passed,
  0 failed** (18 + 0 + 19 + 26 + 3 + 6; doc-tests 0 ×3). Verbatim tail:

  ```text
     Doc-tests relayflowd_journal

  running 0 tests

  test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
  ```

- `(cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings)` — **exit 0**.
  Verbatim output (a warm target dir, so the crate lines are cached away —
  reported as it actually printed, not as the previous entry's fuller output):

  ```text
      Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.15s
  ```

- `(cd kernel && ../ops/cargo.sh fmt --check)` — **exit 0, empty output**
  (0 bytes).

- `(cd sdk && npm run build)` — **exit 0**. Verbatim output:

  ```text
  > @relayflows/sdk@0.1.0 build
  > tsc
  ```

- `(cd sdk && npm test)` — **exit 0, 99 passed, 0 failed, 7 files**. Verbatim
  tail:

  ```text
   ✓ tests/validate.test.ts (32 tests) 24ms
   ✓ tests/journal-client.test.ts (12 tests) 40ms
   ✓ tests/cli.test.ts (30 tests) 385ms

   Test Files  7 passed (7)
        Tests  99 passed (99)
     Start at  17:31:11
     Duration  877ms (transform 318ms, setup 0ms, collect 935ms, tests 517ms, environment 1ms, prepare 939ms)
  ```

Floors held: kernel 72 ≥ 70, SDK 99 ≥ 58.

### Behavioral gate — all seven cases re-run from `sdk/dist` at `51251c5`

```text
$ node sdk/dist/cli.js check testdata/hello-ladder.flow.yaml
WARNING [unprovable_effects] Step "greet" command "echo" resolves, but its effects cannot be proven before execution.
RESOLVED step "plan" cli "./preflight/authenticated-cli" from project
RESOLVED step "act" cli "./preflight/authenticated-cli" from project
CHECK PASSED testdata/hello-ladder.flow.yaml
exit=0

$ node sdk/dist/cli.js check testdata/hello-llm.flow.yaml
WARNING [unprovable_effects] Step "greet" command "printf" resolves, but its effects cannot be proven before execution.
WARNING [unprovable_effects] Step "finish" command "printf" resolves, but its effects cannot be proven before execution.
RESOLVED step "answer" cli "./preflight/authenticated-cli" from project
CHECK PASSED testdata/hello-llm.flow.yaml
exit=0

$ node sdk/dist/cli.js check testdata/hello-agent.flow.yaml
WARNING [unprovable_effects] Step "greet" command "printf" resolves, but its effects cannot be proven before execution.
WARNING [unprovable_effects] Step "finish" command "printf" resolves, but its effects cannot be proven before execution.
RESOLVED step "edit" cli "./preflight/authenticated-cli" from project
CHECK PASSED testdata/hello-agent.flow.yaml
exit=0

$ node sdk/dist/cli.js check testdata/preflight/cli-missing.flow.yaml
REFUSED [cli_missing] Step "answer" declares CLI "./missing-cli", but it is missing.
RESOLVED step "answer" cli "./missing-cli" from step
exit=2

$ node sdk/dist/cli.js check testdata/preflight/cli-unauthenticated.flow.yaml
REFUSED [cli_unauthenticated] Step "edit" declares CLI "./unauthenticated-cli", but its auth probe failed.
RESOLVED step "edit" cli "./unauthenticated-cli" from step
exit=2

$ node sdk/dist/cli.js check testdata/preflight/cli-unresolved.flow.yaml
REFUSED [cli_unresolved] Step "answer" has no CLI at step, flow, or project level.
exit=2

$ node sdk/dist/cli.js check testdata/preflight/no-executor.flow.yaml
WARNING [unprovable_effects] Step "ready" command "printf" resolves, but its effects cannot be proven before execution.
REFUSED [no_executor] Trigger "orphaned-schedule" has no registered executor "absent-executor".
exit=2
```

Three passes, four refusals, one refusal code each — unchanged from the
previous entry's run.

### Review verdict — read from the persisted transcripts, not inferred

Two passing transcripts now stand on this branch:

- `ops/reviews/20260827-1714-review.md` — round 3, judged the record repair and
  the merge with `main`. Ends `REVIEW_PASSED`.
- `ops/reviews/20260827-1726-review.md` — **round 4**, added by `51251c5` and
  **not covered by the previous log entry**. It reviewed `git diff main`
  (40 files, +3023 / −224) at `6eaac2f`, assumed all four prior transcripts
  could be wrong, and re-measured every falsifiable claim itself: kernel 72,
  SDK 99, the structural line counts, all seven behavioral outputs. It raised
  six non-blocking observations (N1–N6, provenance / record-hygiene /
  follow-up scoping; N2 the only one touching the shipped diff, predating this
  tick and repairable in a line) and ends:

  ```text
  REVIEW_PASSED
  ```

The standing `REVIEW_FAILED` in `ops/reviews/20260827-1627-review.md` is
therefore cleared by two later independent passes, on their merits and on
re-executed evidence. Neither CodeRabbit's nor Devin's SUCCESS check is cited
as review signal (`ops/RUN-CONTRACT.md` §3 bar 1); both are still green without
having reviewed.

**The round-4 transcript carries its own 17:29 errata**, worth surfacing: it
originally spelled the failing-verdict sentinel out in prose, and the
`verdict` gate's substring match read that discussion as a rejection —
`VERDICT_FAILED` on a transcript whose verdict was, and always was, a pass.
Two references were reworded; no finding, number, or verdict changed. That
sharp edge was flagged for the human rather than repaired, because
`workflows/` is a file that judges this work.

### Codex findings — still triaged, still unbuilt

Both inline `chatgpt-codex-connector` comments carry replies posted at HEAD
`57c0c3e` (21:17:44Z and 21:17:45Z): **P1** (`sdk/src/preflight.ts` — refuse a
path-like deterministic command word that does not exist; keep the warning for
a bare word that `/bin/sh -c` may resolve as a builtin) and **P2**
(`sdk/src/cli.ts` — `flows check` accepts `version: 9.9.9` that the kernel's
`RunSpec::validate` rejects). Neither is implemented here; both are filed
together in `ops/BACKLOG.md` as "check accepts what the kernel later refuses".
No new bot or human comment has arrived since 21:17:46Z.

### PR #8 — open, mergeable, unmerged by this loop

https://github.com/AgentWorkforce/flows/pull/8 — *WP-4 — `flows check`
preflight (covenant 2)*, **OPEN**, not a draft, head `51251c5`. Live query in
this tick, verbatim:

```json
{"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","mergedAt":null,"reviewDecision":"","state":"OPEN"}
```

`reviewDecision` is empty: no human approval exists. Khaliq's **BLOCKED — do
not merge** comment (20:29:24Z) was answered point by point at HEAD
(21:17:46Z) but has **not been withdrawn by its author**. An answered block is
not a lifted block. This worker did not merge, and does not hold the authority
to.

### `main` moved under this branch — three commits, no conflict

`origin/main` advanced from `73bdb59` to `f59d9cd` during this tick. The branch
is now **7 ahead, 3 behind**:

```text
f59d9cd fix(drive): verdict reads the last verdict token, not any mention of one
09f6dd5 feat(review-swarm): our own review team — three lenses, three model families
59f3680 regressions: relaycast workspace-key repair answers an untyped 500 (#6)
```

`f59d9cd` fixes exactly the `verdict`-gate sharp edge the round-4 errata
flagged, from `main`'s side, in the file this loop is barred from touching.
`59f3680` merged PR #6, so the only PR this loop tracks is now #8.
GitHub still reports `MERGEABLE` / `CLEAN` against the new `main`, so no
further reconciliation is required for the merge to be possible; the branch is
merely behind, not conflicting.

### Gate state — gate 1 remains **AMBER**, honestly

Clause 1 (the a/b/c ladder surviving `kill -9` with exact budget accounting) is
merged and closed on `main`. Clause 2 (`flows check` preflight, covenant 2) is
implemented, reconciled, verified, reviewed twice-passing, and mergeable —
**but only on PR #8's branch, which is not repository state.** Nothing in this
tick moves the gate. It flips to GREEN only after a human merges PR #8 *and* a
fresh verify runs on `main` — not on this branch's word, and not on this
entry's.

`ops/SCOREBOARD.md` reads AMBER for gate 1 on both `main` and this branch, and
is correct as written.

### Likely next package

**No new gate work opens this tick.** The drive rule binds: PR #8 is
unfinished, and the only remaining action on it — merging — is a human's.
Every DoD item WP-4-FIX assigned to this loop is now executed and evidenced.

The next tick's package is therefore contingent, and the assess should decide
by reading PR #8's live state first:

1. **If a human has merged PR #8** — the package is a gate-1 confirmation run:
   re-verify the five commands and the seven behavioral cases *on `main`*, and
   only then move the scoreboard's gate-1 row off AMBER. Gate selection among
   gates 2 / 5 / 6 reopens after that; the scoreboard names gate 6
   (integrations via relayfile) as a candidate, not a commitment.
2. **If PR #8 is still open** — there is no code work left to invent for it.
   The defensible options are to merge `origin/main` (`f59d9cd`) into the
   branch again to keep it current, and to clear the round-4 N2 record-hygiene
   observation in a line. Neither is required while GitHub reports `CLEAN`, and
   neither is a reason to manufacture new work over a PR awaiting a human.
3. **Not next, in either case:** the P1/P2 backlog item, the release pipeline,
   `f.browser`, the cloud-sandbox `sync` remote, and the PR-shepherd flow. All
   wait behind gate 1.

TICK_LOGGED

## 2026-08-27 18:34 EDT — WP-5: clear PR #8's review-swarm rejection

**Work package:** `ops/NEXT.md` WP-5. No new gate work. PR #8 remained the
only unfinished work, and gate 1 remained AMBER.

### Why this tick exists, including the evidence-loss failure

The first `workflows/review-swarm.yaml` run at 17:45 returned
**SWARM_FAILED**: structure passed; history and maintainability rejected. Its
cited `20260827-1745-pr8-*.md` transcripts were not in any branch or commit.
The reflog showed two later `reset: moving to origin/main` entries. Each lens
had been told only to `git add` its transcript; the hard resets therefore
destroyed the staged files. An uncommitted verdict was not durable evidence.

The workflow now serializes its shared Git-index writes, tells every lens to
commit only its own transcript, confirms it with `git cat-file`, and makes the
aggregate refuse an absent, empty, uncommitted, or verdict-less artifact. The
first repaired run (`d37bd96c940ab855762a6e86`) demonstrated the durability
fix: three transcript-only commits survived the run:

```text
808debd review(pr8): maintainability transcript
fc3e422 review(pr8): history transcript
6d6c817 review(pr8): structure transcript
```

That run honestly returned **SWARM_FAILED** (maintainability/history failed,
structure passed). It surfaced two product-contract gaps and a provenance gap;
no passing claim was made:

- `FlowSpec.name` still claimed `string` after validation accepted an absent
  name. `FlowSpec.name` and `KernelRunSpec.name` are now both optional;
  `compileSpec` and `toKernelSpec` omit the absent key, and a test pins it.
- The path-resolution paragraph said every relative CLI path was flow-relative,
  while a project default is correctly relative to its declaring `flows.json`.
  The wording is corrected and a nested-flow test distinguishes the bases.
- The WP-5 assess commit had lived only on the tick branch. `ops/NEXT.md` now
  carries the WP-5 package in PR #8's durable tree.

The workflow's aggregate also had the legacy runner's implicit retry count,
which attempted to turn a rejecting review into an agent repair. The run was
stopped before mutation; `aggregate.maxIterations` is now 1.

### Independent-gate discipline and review round two

The first repaired run used the branch workflow and therefore could not clear
the repository's “never edit a gate that judges your own work” rail. All
subsequent verdict runs use the immutable workflow blob already owned by
`main`, not PR #8's changed gate. Before round two, the launch verified:

```text
immutable gate blob 446d937a218751b11fdb40256f419a8e8cd4f7c9
```

That is exactly `main:workflows/review-swarm.yaml`; it was executed from
`/tmp/review-swarm-main.yaml` through `scripts/run-workflow.sh`, while the
reviewed worktree remained PR #8. Cloud-observable run
`3434ff17dd26687053d3eb55` returned **SWARM_FAILED**: structure passed;
history and maintainability rejected. Its three transcripts were committed
individually as `037d7a1`, `6228b4f`, and `db3160e`.

Round two found three aggregate defects, all repaired in the branch workflow:

- fetch used `set -u`, so failed `gh` calls could leave empty files and still
  print `FETCHED`; it now uses `set -eu` and requires non-empty metadata/diff;
- whole-transcript token matching could turn a passing review that discussed a
  prior rejection into a false failure; only the final verdict line now counts;
- `ls -t` chose by mtimes Git does not preserve; filename timestamps are now
  selected deterministically with `sort | tail -1`.

The independent gate remains the only source accepted for the next verdict.
The branch workflow is implementation under review, not its own judge.

### Original F1–F5 repairs

- **F1:** `validateSpec` accepts only schema `0.1.0`, accepts an absent optional
  name, and refuses `9.9.9` before preflight.
- **F2:** the four-rung anonymous resolution law is restored; the platform
  default is declared but honestly marked unimplemented at gate 1.
- **F3:** gate 6 again records the harness design-partner priority; the backlog
  no longer demotes it and retains only the deterministic-command P1.
- **F4:** the truncated `823e35a` subject remains untouched. `73bdb59` is the
  landed generator guard; no rebase, squash, force-push, or rewrite occurred.
- **F5:** `kernelToAuthoring` is exported beside `toKernelSpec`; all three
  ladder flows pin the normalized authoring → kernel → authoring round trip.

### Verification on the repaired tree

`(cd kernel && ../ops/cargo.sh test --workspace)` — exit 0, **72 passed,
0 failed** (18 + 19 + 26 + 3 + 6; doc-tests 0 ×3). Verbatim tail:

```text
   Doc-tests relayflowd_journal

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

`(cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings)` — exit 0.
Verbatim tail:

```text
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.17s
```

`(cd kernel && ../ops/cargo.sh fmt --check)` — exit 0, empty output.

`(cd sdk && npm run build)` — exit 0. Verbatim output:

```text
npm notice run @relayflows/sdk@0.1.0 build
npm notice run tsc
```

`(cd sdk && npm test)` — exit 0, **106 passed, 0 failed**, 7 files.
Verbatim tail:

```text
 Test Files  7 passed (7)
      Tests  106 passed (106)
   Start at  18:33:08
   Duration  769ms (transform 257ms, setup 0ms, collect 779ms, tests 587ms, environment 1ms, prepare 328ms)
```

Real-CLI version refusal, verbatim:

```text
$ node sdk/dist/cli.js check /tmp/bad-version.flow.yaml
REFUSED [invalid_spec] spec.version: unsupported version "9.9.9" (expected "0.1.0")
exit=2
```

The seven existing behavioral cases were rerun on this tree: all three ladder
flows printed `CHECK PASSED` and exited 0; `cli_missing`,
`cli_unauthenticated`, `cli_unresolved`, and `no_executor` each printed its
typed refusal and exited 2.

### Honest gate state

Gate 1 is still **AMBER**. Clause 1 is closed on `main`; clause 2 remains only
on open PR #8. A human must merge #8 and re-run verification on merged `main`
before the gate can move. This worker does not merge and has not claimed a
passing swarm verdict while any lens rejects.

Round three used the same immutable main-owned gate. History and structure
passed; maintainability rejected on two newly reproduced boundary cases. This
corrects the round-three structure transcript's claim that the dialect seam was
“lossless”: an empty `triggers` array hashed differently across SDK/kernel, and
a valid non-default kernel retry policy was silently replaced by authoring
defaults. The evidence transcript remains unchanged; this append-only record
supersedes that sentence. The repairs normalize empty triggers before hashing,
refuse non-default retry values the authoring dialect cannot represent, and pin
both cases. A direct round trip now also exercises flow/step CLI fields and a
non-empty trigger declaration. The branch swarm additionally stamps the fetched
PR head into every transcript and refuses stale evidence.

Round four, canonical run `52e3b49347c0e4c8b8e72dd4`, reviewed
`3d9b9ce` through the immutable main-owned gate. Structure and history passed;
maintainability rejected, so the aggregate returned **SWARM_FAILED** and its
legacy retry was stopped before mutation. The blocker reproduced an unwritten
nearest-`flows.json` rule: a nested config shadows outer configs as a whole,
but neither success output nor an unresolved-CLI refusal named the selected
file. The repair documents the upward search and nearest-wins-no-merge boundary,
prints the selected config path for project resolutions, names the shadowing
file on refusal, and pins a parent-CLI/child-executors layout. The same review
identified a redundant general retry-range guard: only the exact authoring
defaults are representable, so the single fail-closed equality check now owns
that refusal and its CLI test pins the specific field message.

Before round five, `origin/main` was merged normally to make PR #8 mergeable;
the add/add workflow conflict kept this branch's durable evidence semantics.
The conflict reconstruction accidentally included two local shell-startup
diagnostic lines in merge commit `06c4efe`; `3293ff3` removed exactly those
lines immediately, with no history rewrite, and the workflow dry-run passed.

Round five, canonical run `bdd2c7c9128037f70c44029c`, reviewed mergeable head
`3293ff3` through the immutable main-owned gate. Structure and history passed;
maintainability rejected and the aggregate returned **SWARM_FAILED**. Its four
blocking maintainability findings were repaired without adding gate work:

- redundant assertions that could not fail were removed; the injected-probe
  contract now states its exception boundary, auth refusal names the exact
  `auth status` contract, and SDK comments call CLI fields inert preflight data;
- the exported JSON report now has exported types and exact pass/refusal shape
  tests, including resolutions and project-config provenance;
- dialect detection now recognizes every snake-case sentinel plus kernel budget,
  verification, and permission shapes, with one CLI test per discriminator and
  an honest comment for inherently ambiguous documents;
- every temporary CLI fixture now creates its own `flows.json` boundary, so an
  ambient `/tmp/flows.json` cannot turn a refusal test green or red.

The repaired SDK suite passes **118 tests** across 7 files. Gate 1 remains
**AMBER** until a human merges PR #8 and re-verifies clause 2 on `main`.

### Retry correction — main-owned judge and durable final repairs

The timed-out build left a correction in the working tree that supersedes the
earlier instruction to change `workflows/review-swarm.yaml`. The correction is
now committed in `ops/NEXT.md`: PR #8 must not edit its own judge. The workflow
in this branch is byte-identical to `origin/main`; the unchanged main-owned
workflow stages review evidence, and this branch commits each transcript
explicitly after the run. The durability hardening belongs in a separate PR
judged by the pre-change swarm.

The main-owned review of `c8c15a0` at 19:21–19:24 produced three transcripts.
History and structure passed; maintainability rejected M1–M3. They were
preserved without product files in `a6f6afb`, closing the immediate recurrence
of F0: staged evidence is not durable, and the earlier 17:45 transcripts were
lost when later hard resets discarded the shared index.

`e074a92` then made only the retry's localized repairs:

- restored `workflows/review-swarm.yaml` to the exact `origin/main` blob;
- disclosed in the inert kernel field comment and `docs/SURFACE.md` that
  `flows check` performs preflight while direct `run.start` does not; and
- made compiled-dialect failures name the marker that selected the dialect,
  the object path, and the unknown key, with the mixed `timeoutMs` plus
  `depends_on` case pinned through the real CLI.

Main-owned run `64363bfa9c515ac2a5b744fe` reviewed `e074a92`. History and
structure passed; maintainability rejected because three new kernel validation
variants and the SDK duplicate-trigger rule survived deletion with both suites
green. The aggregate printed `SWARM_FAILED`; its legacy automatic repair retry
was stopped before mutation. The three transcripts were committed separately
as `6819ff4`, `0fd7810`, and `6111906`.

`4f8ecf8` answered that mutation evidence without widening the package. The
existing kernel test now distinguishes `EmptyCli`, both invalid-trigger fields,
`DuplicateTrigger`, the exact malformed-trigger parse variant, and
`EmptyStepCli`. The SDK suite now asserts the exact duplicate-trigger
diagnostic. The kernel test count remains the required 72 because the new
assertions extend the existing preflight test.

Verification at `4f8ecf8`:

```text
$ (cd kernel && ../ops/cargo.sh test --workspace)
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s

   Doc-tests relayflowd_journal

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

All five non-doc suites total **72 passed, 0 failed** (18 + 19 + 26 + 3 + 6).

```text
$ (cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 5.21s

$ (cd kernel && ../ops/cargo.sh fmt --check)
# exit 0, empty output

$ (cd sdk && npm run build)
> @relayflows/sdk@0.1.0 build
> tsc

$ (cd sdk && npm test)
 Test Files  7 passed (7)
      Tests  121 passed (121)
```

The real CLI still refuses the kernel-incompatible version at submit:

```text
REFUSED [invalid_spec] spec.version: unsupported version "9.9.9" (expected "0.1.0")
exit=2
```

The seven recorded behavioral cases were rerun: all three ladder flows printed
`CHECK PASSED` and exited 0; `cli_missing`, `cli_unauthenticated`,
`cli_unresolved`, and `no_executor` printed their typed refusals and exited 2.

Main-owned run `bcb3310dbf0d864d17d44319` reviewed `4f8ecf8`. Structure and
maintainability passed; history rejected because this retry correction still
lived only in the working tree and this log stopped at `c8c15a0`. The aggregate
again printed `SWARM_FAILED` and its repair retry was stopped before mutation.
Its three transcripts were committed separately as `ced536d`, `4ab656c`, and
`26cafde`. This append-only correction closes that provenance finding without
rewriting prior commits or deleting any rejection evidence.

Gate 1 remains **AMBER**. Clause 1 is closed on `main`; clause 2 exists only on
open PR #8 until a human merges it and re-verifies on merged `main`.

### Final main-owned swarm — `b242b77ed0270c99fa5be416` at `a8c9110` — SWARM_PASSED

Appended so the durable log's last word on the swarm is not the earlier
`SWARM_FAILED`. The prior rejections above stand unedited; this is an
append-only correction, not a rewrite.

The final main-owned run reviewed `a8c911043adab2e6f4882bee6b821dfefa06f3a3`
with the `workflows/review-swarm.yaml` that is byte-identical to `origin/main`
(`git diff main HEAD -- workflows/` is empty — the gate judging this branch was
never edited by it). All three lenses passed:

```text
ok: maintainability passed (ops/reviews/20260827-2002-pr8-maintainability.md)
ok: history passed (ops/reviews/20260827-1958-pr8-history.md)
ok: structure passed (ops/reviews/20260827-1958-pr8-structure.md)
SWARM_PASSED
```

Each transcript was committed alone, touching only itself, immediately after
the run: `7062800` (history, 173 lines), `497bc10` (structure, 201),
`d129750` (maintainability, 304). Each carries `REVIEW_PASSED` as its last
verdict token.

The transcripts bind to the current tree: `git diff a8c9110 HEAD -- sdk kernel
docs workflows testdata` is empty, so reviewing `a8c9110` is equivalent to
reviewing the PR head for every product file. Commits after `a8c9110` touch
only `ops/`.

A subsequent independent diff review (`ops/reviews/20260827-2011-review.md`,
commit `4ce3ff9`) returned `REVIEW_FAILED` on two documentation findings, both
now closed in this round:

- **V1 (P2)** — `ops/SCOREBOARD.md` gate-1 row claimed "Measured on this tree:
  … SDK 99 tests". The tree has **121**. The figure was written at `6a425b6`
  and never updated across the WP-5 rounds that added 22 tests. Corrected to
  121. The stale number understated, so nothing downstream was overstated, but
  a gate record carrying a stale measurement is exactly the defect this package
  exists to eliminate.
- **V2 (P3)** — this log never recorded the final passing round. Closed by this
  entry.
- **V3 (P3)** — residual undisclosed `steps: []` asymmetry (SDK refuses, kernel
  accepts). Non-blocking per the reviewer and degenerate; recorded in
  `ops/BACKLOG.md` rather than fixed here, since closing it would touch kernel
  code that is out of WP-5 scope.

Re-measured independently at this round, not copied forward:

```text
$ (cd kernel && ../ops/cargo.sh test --workspace)
72 passed, 0 failed (18 + 19 + 26 + 3 + 6; doc-tests 0)

$ (cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings)
exit 0, no warnings

$ (cd kernel && ../ops/cargo.sh fmt --check)
exit 0, empty

$ (cd sdk && npm test)
 Test Files  7 passed (7)
      Tests  121 passed (121)
```

Gate 1 remains **AMBER**. Clause 2 still lives only on open PR #8; it flips to
GREEN only after a human merges it and re-verifies on merged `main`.

### WP-6 — repair the 20:11 rejection before re-review

This 2026-08-27 20:25 EDT entry is append-only. It corrects the preceding
round's incomplete treatment of the independent review without changing that
round or any earlier rejection evidence.

The review chronology at the start of WP-6 is:

1. Main-owned swarm run `b242b77ed0270c99fa5be416` reviewed `a8c9110` and
   returned `SWARM_PASSED`. Its three separately committed transcripts are
   `ops/reviews/20260827-1958-pr8-history.md`,
   `ops/reviews/20260827-1958-pr8-structure.md`, and
   `ops/reviews/20260827-2002-pr8-maintainability.md`. At the later pre-WP-6
   head `4ce3ff9`, `git diff a8c9110 4ce3ff9 -- sdk kernel docs workflows
   testdata` was empty, so that passing review bound to the shipped product
   tree at that head.
2. The 20:11 standalone review in
   `ops/reviews/20260827-2011-review.md` reviewed `d129750` and was committed
   alone at `4ce3ff9`; it returned `REVIEW_FAILED`. It found V1, the false
   `SDK 99 tests` measurement in `ops/SCOREBOARD.md`; V2, this durable log's
   omission of the final passing swarm; and V3, the undisclosed `steps: []`
   check/kernel asymmetry.
3. The existing local repair commit `d8117b3` corrected V1 to the independently
   measured SDK count of 121 and appended the missing swarm history, but it
   described V3 as closed by a backlog entry. That was incomplete under WP-6.
   Commit `f0abdd4` carries `ops/NEXT.md` onto the PR branch and closes V3 in
   `docs/SURFACE.md`: the authoring surface deliberately refuses `steps: []`
   as `invalid_spec` while the kernel accepts it, and the document identifies
   this as an authoring-time narrowing rather than a kernel guarantee.

The changed documentation means `a8c9110` is no longer the binding commit for
the WP-6 product tree. The next review swarm must review this repaired head;
its run id, reviewed hash, separately committed transcripts, and aggregate
verdict will be appended after the run rather than predicted here.

Fresh measurements on `f0abdd4`, before writing this entry:

```text
$ (cd kernel && ../ops/cargo.sh test --workspace)
72 passed, 0 failed (18 + 19 + 26 + 3 + 6; doc-tests 0)

$ (cd sdk && npm test)
 Test Files  7 passed (7)
      Tests  121 passed (121)
```

Gate 1 remains **AMBER**. Clause 2 remains on open PR #8 until a human merges
it and re-verifies the merged `main` tree.

### WP-6 review round `39928a866198e7968bf1e15b` at `1bf885f` — SWARM_FAILED

The canonical-workspace review swarm reviewed
`1bf885f50e9c0f290e2fc7df69e72430bf3ed986`. The original three lens results
were persisted immediately, each in its own single-file commit:

```text
SWARM_FAILED: maintainability rejected — see ops/reviews/20260827-2032-pr8-maintainability.md
SWARM_FAILED: history rejected — see ops/reviews/20260827-2031-pr8-history.md
ok: structure passed (ops/reviews/20260827-2027-pr8-structure.md)
```

- Structure returned `REVIEW_PASSED`; commit `71ed9fd` contains only its
  transcript.
- History returned `REVIEW_FAILED`; commit `234f009` contains only its
  transcript. H1 found that `ops/NEXT.md` simultaneously required the old
  `a8c9110..HEAD` product diff to be empty and required the V3 disclosure that
  made it non-empty. Commit `a5e58d7` repairs the controlling record: the old
  review binds through `4ce3ff9`, while the next WP-6 review must bind to the
  repaired `f0abdd4` product tree.
- Maintainability returned `REVIEW_FAILED`; commit `011ca4d` contains only its
  transcript. Its blocking B1 is a shipped-entrypoint defect: invoking the
  built CLI through an npm-style symlink exits 0 with no output because the
  main-module guard compares the symlink URL with the realpath-resolved module
  URL. This Lead reproduced the result independently against the
  `cli-missing` fixture: no output, exit 0. The transcript also records B2-B8.

The workflow runner tried to enter its generic aggregate-repair retry after
the failed aggregate. It was stopped before mutation: this package requires a
failed lens to become a recorded repair round, not an automatic retry that
could overwrite evidence or change product code. No workflow file changed.

H1 is repaired in scope. B1 requires edits under `sdk/src/**` and `sdk/tests/**`,
which WP-6 explicitly forbids; the package says any such diff fails. The failed
round is therefore preserved rather than papered over by rerunning unchanged
product code. PR #8 remains open and Gate 1 remains **AMBER**.

### WP-7 — shipped-entrypoint and probe-contract fixes, before re-review

This 2026-08-27 21:04 EDT entry records the fixed product tree before the
required new swarm. Commit `5189e69` closes F1/F2/F4/F5/F8 in code, fixtures,
and tests; commit `9aecc41` closes F6/F7/F9/F10 in the surface contract,
backlog, and controlling work package. F11 is disclosed in the refreshed PR
body as a reviewer-forced correction caused by the WP-6 H1 transcript.

The built artifact now resolves every component of `process.argv[1]` through
`realpathSync` before comparing with `import.meta.url`. If that entry path is
absent, deleted, or unreadable, the module is treated as an import and does
not crash or guess that an unrelated host process invoked it. A signal-killed
`auth status` and a resolver process that cannot be started both reach
`probe_failed`. One `preflight()` call memoises by `(cli, source)`.

Fresh pre-review measurements on `9aecc41`:

```text
$ (cd kernel && ../ops/cargo.sh test --workspace)
test result: ok. 18 passed; 0 failed
test result: ok. 0 passed; 0 failed
test result: ok. 19 passed; 0 failed
test result: ok. 26 passed; 0 failed
test result: ok. 3 passed; 0 failed
test result: ok. 6 passed; 0 failed
doc-tests: 0 failed (72 total passed)

$ (cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings)
Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.32s

$ (cd kernel && ../ops/cargo.sh fmt --check)
exit 0, empty output

$ (cd sdk && npm run build)
> tsc
exit 0

$ (cd sdk && npm test)
Test Files  8 passed (8)
     Tests  127 passed (127)
```

The seven original behavioral cases pass through `node sdk/dist/cli.js`: all
three ladder flows print `CHECK PASSED` at exit 0, while `cli_missing`,
`cli_unauthenticated`, `cli_unresolved`, and `no_executor` print their typed
`REFUSED` kind at exit 2. Both a symlink directly to `dist/cli.js` and a
symlinked directory component now print `REFUSED [cli_missing]`, exit 2. The
signal fixture and `env PATH=` case print `REFUSED [probe_failed]`, exit 2.
The three-step shared-CLI fixture prints `CHECK PASSED` and its own log contains
exactly one `auth status` line.

Mutation verification temporarily restored the old non-realpath guard and ran
the full SDK suite. Both new symlink tests failed with received exit 0 instead
of expected exit 2 (`2 failed | 125 passed`); restoring the clause returned
`sdk/src/cli.ts` to blob `75cbefbbaabc6b50734dc8fdff9928c1f3a3eec8`,
after which all 127 tests passed.

The workflow guard is empty and the package-local kernel guard is empty:
`git diff origin/main HEAD -- workflows/` and
`git diff b43cd0f HEAD -- kernel/` print nothing. The literal work-package
command `git diff origin/main HEAD -- kernel/` still lists the three kernel
files introduced earlier by PR #8, before WP-7; reverting them would erase
the open PR's required spec-parity work and is out of scope. This baseline
contradiction is preserved rather than hidden. All ten cited commits remain
ancestors. Gate 1 remains **AMBER** and PR #8 remains open.
