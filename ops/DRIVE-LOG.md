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

**Gate state:** gate 1 is GREEN in this branch on both clauses. The scoreboard
records the correction from its premature rung-only GREEN through AMBER and
the evidence that closes preflight. It becomes repository state only when a
human merges the PR; this worker does not merge.
