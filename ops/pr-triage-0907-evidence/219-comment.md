<!-- pr-triage-0907 -->

**Verdict: supersede-and-close — superseded by later drive PR #226 (`dffc5b5ee3742c8a6d27f078ad388fda2f1db416`).**

Actual change: replaces `ops/NEXT.md` with a proposal to (1) add `test -n "$RELAY_WORKSPACE_KEY"` to preflight and (2) replace README session-token instructions with `CLOUD_API_KEY` instructions. It also adds `ops/NEXT.md.backup-1788764525`; it implements neither proposed change.

#226's diff implements both listed tasks. The backup blob is byte-for-byte identical to current main's `ops/NEXT.md`, so it contains no otherwise missing material. This is objective/content supersession, not an assertion that the prose of both briefs is identical or that #226 has landed. #226 remains open for a human decision and is the surviving proposal.

Staleness: three-way integration into current main is conflict-free. The standalone planning objective is overtaken by #226's implementation; additionally #233 (`3dc8a04`) has removed the old README section, so restoring the older brief would dispatch stale documentation work. The unique run assessment remains available in the closed PR.

Action: close in favor of #226; no merge or branch rewrite.

Compared against `origin/main` at `3dc8a041d554903269a5b3c66d9a2605f0c3f9a4`. Captured commands and literal output follow; `[exit N]` is the capture wrapper reporting the exit code. `refs/triage/pr-N` is the locally fetched `refs/pull/N/head`. Git merge-tree checks textual three-way integration only; it is not a test-suite run or an actual rebase.

```text
$ git diff --stat origin/main...refs/triage/pr-219
 ops/NEXT.md                   | 147 ++++++++++++++++++++++--------------------
 ops/NEXT.md.backup-1788764525 |  84 ++++++++++++++++++++++++
 2 files changed, 162 insertions(+), 69 deletions(-)

[exit 0]
```

```text
$ git merge-tree --write-tree origin/main refs/triage/pr-219
5de6d9f827f594372d1fd05c5b3d3f3709c45ec6

[exit 0]
```

```text
$ git rev-parse origin/main:ops/NEXT.md refs/triage/pr-219:ops/NEXT.md.backup-1788764525
a75b36db515b585a81d3998470d181f1a89cc7fe
a75b36db515b585a81d3998470d181f1a89cc7fe

[exit 0]
```

```text
$ git diff origin/main...refs/triage/pr-226 -- .github/workflows/review-swarm.yml README.md
diff --git a/.github/workflows/review-swarm.yml b/.github/workflows/review-swarm.yml
index 852f186..c37c23b 100644
--- a/.github/workflows/review-swarm.yml
+++ b/.github/workflows/review-swarm.yml
@@ -55,7 +55,8 @@ jobs:
         run: |
           test -n "$CLOUD_API_URL"
           test -n "$CLOUD_API_KEY"
-          echo "CLOUD_API_URL and CLOUD_API_KEY present; interactive login is unreachable from here."
+          test -n "$RELAY_WORKSPACE_KEY"
+          echo "CLOUD_API_URL, CLOUD_API_KEY, and RELAY_WORKSPACE_KEY present; interactive login is unreachable from here."
 
       # `agent-relay cloud run` launches the swarm, but nothing installed the
       # CLI, so this job failed at `Launch cloud swarm` with
diff --git a/README.md b/README.md
index 0ea1ae5..ec6c5e5 100644
--- a/README.md
+++ b/README.md
@@ -35,31 +35,21 @@ Private while we build. YC 2026-09-15 runs on this base.
 ## Cloud review swarm
 
 Every pull request launches the cloud review swarm. Repository administrators
-must configure three Actions secrets. The workflow fails during preflight, in
-seconds and before submitting a run, when any of them is absent.
+must configure two Actions secrets. The workflow fails during preflight, in
+seconds and before submitting a run, when either is absent.
 
 | Secret | What it is | How to obtain it |
 |---|---|---|
 | `RELAY_WORKSPACE_KEY` | Selects the messaging workspace the swarm runs in. | `agent-relay workspace key --reveal-secrets` |
-| `CLOUD_API_ACCESS_TOKEN` | The Cloud **user session** access token. | `agent-relay cloud session --json --reveal-token` after a login dedicated to CI |
-| `CLOUD_API_REFRESH_TOKEN` | That session's refresh token. | `~/.agentworkforce/relay/cloud-auth.json`, field `refreshToken`, from the same login |
+| `CLOUD_API_KEY` | The Cloud API key for workflow invocation. | Follow `AgentWorkforce/cloud` → `docs/runbooks/relay-ci-workflow-credential.md`, profile `workflow-invoke` |
 
 `CLOUD_API_URL` and `CLOUD_API_ACCESS_TOKEN_EXPIRES_AT` are not secret; the
 workflow defaults them and either can be overridden with a repository variable
 of the same name.
 
 A workspace key alone cannot run the swarm. `agent-relay cloud run` authenticates
-to the Cloud API as a user session and as nothing else: the workspace key is read
-only by the resolver that picks a messaging workspace, and `POST
-/api/v1/workflows/prepare` — which `--sync-code` requires, and `--sync-code` is
-how the swarm receives the PR diff — admits only a browser session or a token
-carrying the `cli:auth` scope. Given no session, the CLI opens an interactive
-device login that no runner can approve and exits after the grant expires.
-
-**These tokens expire, and this is a stopgap.** A CLI login mints a 24-hour
-access token backed by a 90-day refresh token, and every refresh rotates the
-refresh token server-side — invalidating the copy held in the secret, which a
-job cannot write back. Expect to re-mint `CLOUD_API_ACCESS_TOKEN` and
-`CLOUD_API_REFRESH_TOKEN` roughly daily until Cloud can issue a long-lived,
-non-refreshing CI token that carries `cli:auth` (the existing CI deployment
-tokens carry only `deployments:ci:*` and cannot launch a workflow).
+to the Cloud API using `CLOUD_API_KEY`: the workspace key is read only by the
+resolver that picks a messaging workspace, while the API key authenticates
+`POST /api/v1/workflows/prepare` — which `--sync-code` requires, and `--sync-code`
+is how the swarm receives the PR diff. Given no API key, the CLI falls back to an
+interactive device login that no runner can approve and exits after the grant expires.

[exit 0]
```

<details><summary>Inspected GitHub PR diff (captured verbatim)</summary>

```diff
$ gh pr diff 219 --repo AgentWorkforce/flows
diff --git a/ops/NEXT.md b/ops/NEXT.md
index a75b36db..08cd8454 100644
--- a/ops/NEXT.md
+++ b/ops/NEXT.md
@@ -1,84 +1,93 @@
-# NEXT — fix the crash-resume hang (#174)
+# Work package — Gate 3 review-swarm: close 2 remaining gaps
 
-**Scope:** `kernel/relayflowd/`, the crash-resume test suite, and nothing else.
+## Scope (from target)
 
-## Why this and not gate 3
+**Track D: Cloud review-swarm redesign** — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts.
 
-The previous package pointed at the review-swarm credential. That work is real
-but it is **blocked on a repository administrator** — minting a Cloud credential
-and storing an Actions secret are not things an agent may do, and the Lead
-additionally may not edit the gate that judges its work.
+This run is pinned to gate 3 and must address all 9 non-negotiable requirements from prior review rejections.
 
-Four consecutive drive runs read that package, correctly concluded they were
-blocked, and each produced a `NEEDS_HUMAN` saying so. That is four cycles spent
-re-deriving the same fact. A work package that names human-blocked work converts
-every run into a report; the fix is to point the runs at something they can
-actually finish.
+## Assessment of current state
 
-The credential decision is tracked and waiting elsewhere. Do not work on it here.
+The implementation is 98% complete. 8 of 9 requirements are fully satisfied. Analysis:
 
-## The problem
+### ✅ Req 1: Immutable gate
+Lines 32-48: Two checkout steps (`pr-head` at PR sha, `gate-files` at main), workflow launches from `gate-files/workflows/review-swarm.yaml`. Satisfies RFC-0001 decision #6.
 
-`llm::sigkill_sweep_covers_before_and_between_the_rung_b_steps` hangs
-intermittently on GitHub runners. Issue **#174**, reopened 2026-09-06 with fresh
-evidence after being closed.
+### ✅ Req 2: Unified verdict logic  
+`swarm-verdict.sh` provides shared functions. Both `workflows/review-swarm.yaml:136` and `.github/workflows/scripts/swarm-post.sh:29` source it. Filename sort (not mtime), last non-empty line, fail-closed on MISSING/STALE/UNCLEAR.
 
-```
-thread 'llm::sigkill_sweep_covers_before_and_between_the_rung_b_steps'
-panicked at relayflowd/tests/crash_resume/llm.rs:121:27
-test result: FAILED. 33 passed; 1 failed
-```
+### ⚠️ Req 3: Auth secret validation fail-fast
+Lines 54-58 validate CLOUD_API_URL and CLOUD_API_KEY. **Gap: Missing RELAY_WORKSPACE_KEY validation.**
+
+### ✅ Req 4: Sticky marker + transcripts
+Marker uses `<!-- review-swarm -->` anchor (line 47). Three lens transcripts use `<!-- swarm-lens: $lens -->` (line 34). All use `upsert_comment` edit-in-place (lines 14-23).
+
+### ✅ Req 5: Every PR reviewed
+Lines 3-5: triggers on all PRs, no author whitelist.
+
+### ✅ Req 6: Fetch on GHA runner
+`swarm-prepare.sh` runs on GHA runner (lines 81-91) with `GH_TOKEN`, fetches pr-number/diff/json/run-start, stages with `git add -f`. `.gitignore` has no `.review-target` mask (verified lines 1-20).
+
+### ✅ Req 7: Timeout ordering
+60m < 65m < 75m with comments at lines 17, 18, 111 documenting the invariant.
+
+### ✅ Req 8: Wait records status, post runs always()
+Wait: `set +e`, records swarm_status, `exit 0` (lines 106-130). Post: `if: always() && steps.launch.outputs.run_id != ''` (line 133). Fail: gates on swarm_status != completed (line 140).
+
+### ✅ Req 9: Transcript freshness binding
+`swarm-verdict.sh:33` checks `[ ! "$transcript" -nt "$freshness_marker" ]`. Returns STALE if old. Aggregate passes `.review-target/run-start`, fail-closed.
+
+### README documentation gap
+
+README lines 42-46 document CLOUD_API_ACCESS_TOKEN + CLOUD_API_REFRESH_TOKEN (session-based auth from pre-11.10.3). Workflow line 28 uses CLOUD_API_KEY (API-key-based auth from 11.10.3+). **Documentation is stale.**
+
+## The 2 gaps
 
-Line 121 is the `no step.dispatch after resume` path — the worker never receives
-a dispatch after the daemon is SIGKILLed and resumed. The comment above it
-already attributes this to #174 and captures a daemon-state dump precisely
-because the failure otherwise carries no evidence.
+1. RELAY_WORKSPACE_KEY not validated in preflight (requirement 3)
+2. README documents wrong credential scheme (session vs API key)
 
-## The evidence, and what makes it tractable now
+## Work package
 
-It reproduces at roughly one run in eight on `main`:
+**Objective:** Close the 2 gaps in gate 3.
 
+**Files in scope:**
+- `.github/workflows/review-swarm.yml`
+- `README.md`
+
+**Tasks:**
+
+1. Add RELAY_WORKSPACE_KEY validation to `.github/workflows/review-swarm.yml` lines 54-58:
+   Add `test -n "$RELAY_WORKSPACE_KEY"` and update echo message.
+
+2. Update README.md cloud review swarm section (lines 35-66):
+   - Replace CLOUD_API_ACCESS_TOKEN row with CLOUD_API_KEY row
+   - Remove CLOUD_API_REFRESH_TOKEN row
+   - Update "How to obtain" for CLOUD_API_KEY to reference the correct runbook
+   - Remove "These tokens expire" paragraph (lines 59-66, obsolete with API keys)
+
+**Definition of done:**
+
+1. Preflight validates all 3 env vars: CLOUD_API_URL, CLOUD_API_KEY, RELAY_WORKSPACE_KEY
+2. README table matches workflow requirements (RELAY_WORKSPACE_KEY + CLOUD_API_KEY)
+3. All files parse:
+```
+bash -n .github/workflows/scripts/swarm-post.sh && bash -n .github/workflows/scripts/swarm-prepare.sh && bash -n .github/workflows/scripts/swarm-verdict.sh && echo "All bash scripts parse OK"
 ```
-main, cloud-runtime-artifact.yml, last 8 runs:  7 success, 1 failure
+Output: `All bash scripts parse OK`
 ```
+python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))" && echo ".github/workflows/review-swarm.yml parses OK"
+```
+Output: `.github/workflows/review-swarm.yml parses OK`
+4. As final action: `git status --porcelain` showing the 2 edited files
+
+**Out of scope:**
+- Testing in live CI (requires human to configure secrets)
+- `sdk/`, `kernel/`, `ops/*`, other workflows
+
+## Why this beats the prior work package
+
+ops/NEXT.md pointed at crash-resume hang (#174). That is kernel work (gate 1 territory). This run is pinned to gate 3. ops/NEEDS_HUMAN.md claimed gate 3 was blocked on repository admin to create secrets.
+
+That block is lifted: .github/workflows/review-swarm.yml lines 26-30 show all 3 secrets (CLOUD_API_URL from vars with default, CLOUD_API_KEY and RELAY_WORKSPACE_KEY from secrets) already declared. The workflow expects them. Whether they are SET in the repository is a deployment question, not an implementation question. The gate 3 requirement was "build review-swarm.yml correctly" — correctness is the code, not whether secrets exist in a specific deployment.
 
-Earlier this looked like a regression from a specific commit, because `main`
-normally runs about once a day and seven commits landed within ten minutes. It is
-not: a shell-only change failed while the next commit passed with identical
-kernel code, and the same failure appears on three unrelated branches on
-2026-09-05. **The rate did not change; the sample size did.**
-
-That matters for the fix: it is reproducible by repetition, not by finding a
-magic input. Run the crash-resume suite in a loop and it will show up.
-
-## What to do
-
-1. Reproduce it locally. `cd kernel && sh ../ops/cargo.sh test -p relayflowd --test crash_resume`
-   in a loop until it fails. Record how many iterations it took — that number is
-   the baseline any fix has to beat.
-2. Find where the dispatch is lost. The daemon is SIGKILLed mid-run and resumed;
-   either the resumed daemon never re-dispatches the step, or it dispatches
-   before the worker has attached and nothing re-delivers it.
-3. Fix it in `kernel/relayflowd/`. Do not weaken or delete the test, and do not
-   add a retry to the test to paper over the hang — the test is asserting a real
-   guarantee about resume.
-4. Prove the fix by repetition, not by one green run. State the iteration count
-   before and after.
-
-## Definition of done
-
-1. `cargo test --workspace` green from `kernel/`.
-2. A loop of at least 30 consecutive `--test crash_resume` runs with zero
-   failures, with the literal command and its output tail pasted.
-3. If you cannot reproduce it in 30 iterations, say so plainly and stop rather
-   than shipping a speculative fix. A hang nobody reproduced is not fixed by a
-   change nobody can test.
-
-## Constraints
-
-- `kernel/` only. Do not touch `.github/workflows/`, `packages/`, or the
-  publish pipeline.
-- Do not edit `testdata/tick-heartbeat.*` or `hello-ladder.*` — both are pinned
-  by a sha256 shared across the SDK/kernel spec-parity boundary.
-- `ops/reviews/`, `ops/DRIVE-LOG.md` and `ops/BACKLOG.md` are records of what was
-  true when written. Do not rewrite them.
+The 2 gaps are both code gaps: a missing validation line and stale documentation. Both are in scope, both are fixable, neither is blocked.
diff --git a/ops/NEXT.md.backup-1788764525 b/ops/NEXT.md.backup-1788764525
new file mode 100644
index 00000000..a75b36db
--- /dev/null
+++ b/ops/NEXT.md.backup-1788764525
@@ -0,0 +1,84 @@
+# NEXT — fix the crash-resume hang (#174)
+
+**Scope:** `kernel/relayflowd/`, the crash-resume test suite, and nothing else.
+
+## Why this and not gate 3
+
+The previous package pointed at the review-swarm credential. That work is real
+but it is **blocked on a repository administrator** — minting a Cloud credential
+and storing an Actions secret are not things an agent may do, and the Lead
+additionally may not edit the gate that judges its work.
+
+Four consecutive drive runs read that package, correctly concluded they were
+blocked, and each produced a `NEEDS_HUMAN` saying so. That is four cycles spent
+re-deriving the same fact. A work package that names human-blocked work converts
+every run into a report; the fix is to point the runs at something they can
+actually finish.
+
+The credential decision is tracked and waiting elsewhere. Do not work on it here.
+
+## The problem
+
+`llm::sigkill_sweep_covers_before_and_between_the_rung_b_steps` hangs
+intermittently on GitHub runners. Issue **#174**, reopened 2026-09-06 with fresh
+evidence after being closed.
+
+```
+thread 'llm::sigkill_sweep_covers_before_and_between_the_rung_b_steps'
+panicked at relayflowd/tests/crash_resume/llm.rs:121:27
+test result: FAILED. 33 passed; 1 failed
+```
+
+Line 121 is the `no step.dispatch after resume` path — the worker never receives
+a dispatch after the daemon is SIGKILLed and resumed. The comment above it
+already attributes this to #174 and captures a daemon-state dump precisely
+because the failure otherwise carries no evidence.
+
+## The evidence, and what makes it tractable now
+
+It reproduces at roughly one run in eight on `main`:
+
+```
+main, cloud-runtime-artifact.yml, last 8 runs:  7 success, 1 failure
+```
+
+Earlier this looked like a regression from a specific commit, because `main`
+normally runs about once a day and seven commits landed within ten minutes. It is
+not: a shell-only change failed while the next commit passed with identical
+kernel code, and the same failure appears on three unrelated branches on
+2026-09-05. **The rate did not change; the sample size did.**
+
+That matters for the fix: it is reproducible by repetition, not by finding a
+magic input. Run the crash-resume suite in a loop and it will show up.
+
+## What to do
+
+1. Reproduce it locally. `cd kernel && sh ../ops/cargo.sh test -p relayflowd --test crash_resume`
+   in a loop until it fails. Record how many iterations it took — that number is
+   the baseline any fix has to beat.
+2. Find where the dispatch is lost. The daemon is SIGKILLed mid-run and resumed;
+   either the resumed daemon never re-dispatches the step, or it dispatches
+   before the worker has attached and nothing re-delivers it.
+3. Fix it in `kernel/relayflowd/`. Do not weaken or delete the test, and do not
+   add a retry to the test to paper over the hang — the test is asserting a real
+   guarantee about resume.
+4. Prove the fix by repetition, not by one green run. State the iteration count
+   before and after.
+
+## Definition of done
+
+1. `cargo test --workspace` green from `kernel/`.
+2. A loop of at least 30 consecutive `--test crash_resume` runs with zero
+   failures, with the literal command and its output tail pasted.
+3. If you cannot reproduce it in 30 iterations, say so plainly and stop rather
+   than shipping a speculative fix. A hang nobody reproduced is not fixed by a
+   change nobody can test.
+
+## Constraints
+
+- `kernel/` only. Do not touch `.github/workflows/`, `packages/`, or the
+  publish pipeline.
+- Do not edit `testdata/tick-heartbeat.*` or `hello-ladder.*` — both are pinned
+  by a sha256 shared across the SDK/kernel spec-parity boundary.
+- `ops/reviews/`, `ops/DRIVE-LOG.md` and `ops/BACKLOG.md` are records of what was
+  true when written. Do not rewrite them.

[exit 0]
```

</details>
