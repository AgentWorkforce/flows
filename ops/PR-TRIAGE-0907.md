# PR triage — 2026-09-07

Scope: AgentWorkforce/flows #234, #226, #222, #219, #214 only. No merges authorized.

Initial main: `3dc8a041d554903269a5b3c66d9a2605f0c3f9a4`. The exact fetched SHA and literal log are in [main-head](pr-triage-0907-evidence/main-head.txt) and [main-log](pr-triage-0907-evidence/main-log.txt). Initial queue: [captured inventory](pr-triage-0907-evidence/initial-queue.txt).

Verdicts: close #214 as completed-target output (#120); close #219 and #222 in favor of #226; leave #226 and #234 open as needs-human. No PR qualifies for an unconditional rebase-and-keep: the two surviving proposals require decisions about scope or assertions.

The supplied operational fact that review CI fails because production rejects CLOUD_API_KEY with 401 was accepted without re-derivation and excluded as a code-quality signal. No tests, credential changes, or production calls were performed. Merge-tree checks below are read-only three-way integration checks, not actual rebases or runtime verification. Exit 1 in #226's merge-tree output is the captured README conflict, not a test failure.

The five protected live PRs (#229, #227, #230, #231, #232) receive no comments, closes, pushes, or edits. No AgentWorkforce/cloud PR is accessed. Application code and gates are unchanged. This report and its evidence directory are local deliverables on `triage/pr-cleanup-0907`.

## PR #234

**Verdict: needs-human — leave open; no complete superseding change demonstrated.**

Actual change: only `ops/NEEDS_HUMAN.md`. It replaces the old administrator-block report with a claim that all nine review-swarm architectural requirements are satisfied and that secret storage alone remains. It adds no implementation.

Current main retains the older NEEDS_HUMAN text; the direct file diff is non-empty. There is no later drive PR among the five under triage. The earlier #226 proposes a workspace-presence assertion but does not contain this report. Accordingly I cannot show this whole change is superseded and will not close it merely because parts are stale.

Staleness: three-way integration into current main is conflict-free, but the report needs factual reconciliation. The supplied verified operational state is that an existing CLOUD_API_KEY is rejected by production with 401, not simply that a secret has yet to be stored. Its “all nine satisfied” assertion also cannot be established from the two presence tests currently on main, and the README workspace-key line citation would be stale after integration with #233. These observations do not establish that Gate 3 is complete.

**Decision required:** the gate/repository owner should choose whether to retain this as a current blocker report (rewrite it around the rejected credential, identify the credential owner, and provide evidence for any implementation-complete claims) or archive it as a historical run assessment. Approval of either disposition belongs to that owner because no complete successor is demonstrated.

The known review-check 401 is context supplied with this task, not a test executed here or evidence that this PR introduced a code defect. No credential/prod investigation was performed.

Action: leave open and preserve head; request the decision here. No rebase/push or merge.

Evidence: [full gh pr diff](pr-triage-0907-evidence/234-diff.txt), [two-endpoint diff against main](pr-triage-0907-evidence/234-against-main.txt), [metadata and prior comments](pr-triage-0907-evidence/234-metadata.txt), [unique commits](pr-triage-0907-evidence/234-commits.txt). Two-endpoint diffs also show main changes absent from an older head; they are not the patch GitHub would integrate. The three-dot diff and merge-tree output distinguish the proposed patch.

```text
$ git diff --stat origin/main...refs/triage/pr-234
 ops/NEEDS_HUMAN.md | 99 +++++++++++++++++++++++++++++++++++++++++-------------
 1 file changed, 76 insertions(+), 23 deletions(-)

[exit 0]
```

```text
$ git merge-tree --write-tree origin/main refs/triage/pr-234
5295e6134ba339826d410102b21c13ab96c066fb

[exit 0]
```

```text
$ git grep -n -A 7 'Validate cloud authentication' origin/main -- .github/workflows/review-swarm.yml
origin/main:.github/workflows/review-swarm.yml:54:      - name: Validate cloud authentication
origin/main:.github/workflows/review-swarm.yml-55-        run: |
origin/main:.github/workflows/review-swarm.yml-56-          test -n "$CLOUD_API_URL"
origin/main:.github/workflows/review-swarm.yml-57-          test -n "$CLOUD_API_KEY"
origin/main:.github/workflows/review-swarm.yml-58-          echo "CLOUD_API_URL and CLOUD_API_KEY present; interactive login is unreachable from here."
origin/main:.github/workflows/review-swarm.yml-59-
origin/main:.github/workflows/review-swarm.yml-60-      # `agent-relay cloud run` launches the swarm, but nothing installed the
origin/main:.github/workflows/review-swarm.yml-61-      # CLI, so this job failed at `Launch cloud swarm` with

[exit 0]
```

Exact posted comment: [234-comment.md](pr-triage-0907-evidence/234-comment.md).

Posted comment: [https://github.com/AgentWorkforce/flows/pull/234#issuecomment-5575838775](https://github.com/AgentWorkforce/flows/pull/234#issuecomment-5575838775).

```text
$ gh pr comment 234 --repo AgentWorkforce/flows --body-file ops/pr-triage-0907-evidence/234-comment.md
https://github.com/AgentWorkforce/flows/pull/234#issuecomment-5575838775

[exit 0]
```

```text
$ gh pr view 234 --repo AgentWorkforce/flows --json number,state,headRefOid,mergedAt,url
{"headRefOid":"0a9b69be08d2c20807f3f8ac1bd3048a7087731b","mergedAt":null,"number":234,"state":"OPEN","url":"https://github.com/AgentWorkforce/flows/pull/234"}

[exit 0]
```


## PR #226

**Verdict: needs-human — leave open; not fully superseded.**

Actual change: adds the workspace-key presence assertion to review preflight, replaces README session-token setup with API-key setup, and replaces the #174 brief in `ops/NEXT.md` with a gate-3 assignment. This is the surviving implementation for the objectives of #219 and #222.

Current main still lacks `test -n "$RELAY_WORKSPACE_KEY"`, and later drive #234 only edits `ops/NEEDS_HUMAN.md`. Therefore there is no demonstrated complete successor. The documentation part is stale: #233 (`3dc8a04`) rewrote README and removed the entire old cloud-review setup section. A three-way integration conflicts in README.md.

**Decision required:** the repository/gate owner must decide whether to retain this workspace-presence requirement as an independently owned gate change, where CI credential setup belongs after the #233 README rewrite, and whether to retain #174 as NEXT rather than intentionally reprioritize it. Then the chosen patch can be rebased with that scope. This is a policy/content conflict, not a mechanical conflict resolution I can choose without changing the proposal. AGENTS.md's “Never edit a gate that judges your own work” also precludes this triage worker repairing the review gate.

The current `review` check's known production CLOUD_API_KEY 401 is supplied context, excluded from this content verdict, and not investigated or repaired. Adding a non-empty check does not establish credential validity.

Action: leave open, preserve head, and request the above decisions here. No rebase/push, merge, gate edit, or credential change.

Evidence: [full gh pr diff](pr-triage-0907-evidence/226-diff.txt), [two-endpoint diff against main](pr-triage-0907-evidence/226-against-main.txt), [metadata and prior comments](pr-triage-0907-evidence/226-metadata.txt), [unique commits](pr-triage-0907-evidence/226-commits.txt). Two-endpoint diffs also show main changes absent from an older head; they are not the patch GitHub would integrate. The three-dot diff and merge-tree output distinguish the proposed patch.

```text
$ git diff --stat origin/main...refs/triage/pr-226
 .github/workflows/review-swarm.yml |   3 +-
 README.md                          |  26 +++-----
 ops/NEXT.md                        | 124 ++++++++++++++++++-------------------
 3 files changed, 69 insertions(+), 84 deletions(-)

[exit 0]
```

```text
$ git merge-tree --write-tree origin/main refs/triage/pr-226
f15c6678f6f2be5104c6ccad43c77c93388fc318
100644 0ea1ae575842dc566e77004a375b7fc622697e20 1	README.md
100644 1e6aa326fdf355657fffc6440e756769eeb9b143 2	README.md
100644 ec6c5e5b46d03ad1678a43c0b230bea87c6b406d 3	README.md

Auto-merging README.md
CONFLICT (content): Merge conflict in README.md

[exit 1]
```

```text
$ git grep -n -A 7 'Validate cloud authentication' origin/main -- .github/workflows/review-swarm.yml
origin/main:.github/workflows/review-swarm.yml:54:      - name: Validate cloud authentication
origin/main:.github/workflows/review-swarm.yml-55-        run: |
origin/main:.github/workflows/review-swarm.yml-56-          test -n "$CLOUD_API_URL"
origin/main:.github/workflows/review-swarm.yml-57-          test -n "$CLOUD_API_KEY"
origin/main:.github/workflows/review-swarm.yml-58-          echo "CLOUD_API_URL and CLOUD_API_KEY present; interactive login is unreachable from here."
origin/main:.github/workflows/review-swarm.yml-59-
origin/main:.github/workflows/review-swarm.yml-60-      # `agent-relay cloud run` launches the swarm, but nothing installed the
origin/main:.github/workflows/review-swarm.yml-61-      # CLI, so this job failed at `Launch cloud swarm` with

[exit 0]
```

```text
$ git show --format=short 3dc8a04 -- README.md
commit 3dc8a041d554903269a5b3c66d9a2605f0c3f9a4
Author: Khaliq <khaliq@agentrelay.com>

    docs(examples): human-friendly README + three v2 relayflow use-case examples (#233)

diff --git a/README.md b/README.md
index 0ea1ae5..1e6aa32 100644
--- a/README.md
+++ b/README.md
@@ -1,65 +1,39 @@
-# flows
+# relay(Flows)
 
-**We are taking prompting and making it reliable, with natural rails and gates.**
+**Step functions for coding agent workflows**
 
-This is the clean-slate build of Relayflows: a durable execution engine that is
-competitive with Temporal and Inngest and agentic-leading where they are
-structurally blind. A Relayflow is a deterministic script that composes agentic
-primitives — an LLM call, an agent, a virtual filesystem, memory, identity,
-authorization — into anything from a one-shot pipeline to a resident harness to
-an entire application.
+Agent Relay is building infrastructure for autonomous agents. A relayflow is a readable step function
+that runs on the relay and produces a verifiable artifact or result that can be paused
+for human input and resumed from any step wherever needed. It is an agentic pipeline
+that can load in any model + harness along with deterministic gates to generate
+reliable results.
 
-The constitution is [`docs/RFC-0001-everything-is-a-relayflow.md`](docs/RFC-0001-everything-is-a-relayflow.md).
-Nothing in this repo may contradict it; changing it is a human decision.
 
-## Layout
+```ts
+import { flow } from "@relayflows/surface";
 
-```
-kernel/     relayflowd — Rust. Journal, scheduler, leases, timers, streams. One binary.
-packages/sdk/        TypeScript-first authoring SDK. Compiles specs; speaks the journal protocol.
-packages/surface/    @relayflows/surface — the TypeScript flow-authoring contract.
-workflows/  The gates. Each gate is a relayflow; the build is orchestrated by relayflows.
-docs/       RFC-0001 and design docs.
-charter/    The Relayflow Lead.
-```
-
-## Method
-
-The rewrite is a program *of* relayflows: every capability ships as a relayflow,
-and its acceptance gate is that it supports the real use case it exists for.
-Nine gates, in `docs/RFC-0001` §3. Gate 1 first: a relayflow can run — the hello
-ladder survives `kill -9` at every boundary.
+export default flow("fix-failing-tests", async (f) => {
+  const result = await f
+    .run("npm test 2>&1; echo EXIT:$?")
+    .gate((out) => !out.includes("EXIT:0"), "tests are already green, nothing to fix");
 
-Private while we build. YC 2026-09-15 runs on this base.
+  const fix = await f
+    .agent("fixer", {
+      task: `The test suite is failing. Diagnose and fix it:\n${result}`,
+      workspace: "src/**: readwrite",
+    })
+    .gate((r) => r.artifacts.length > 0, "the agent must actually change something");
 
-## Cloud review swarm
-
-Every pull request launches the cloud review swarm. Repository administrators
-must configure three Actions secrets. The workflow fails during preflight, in
-seconds and before submitting a run, when any of them is absent.
-
-| Secret | What it is | How to obtain it |
-|---|---|---|
-| `RELAY_WORKSPACE_KEY` | Selects the messaging workspace the swarm runs in. | `agent-relay workspace key --reveal-secrets` |
-| `CLOUD_API_ACCESS_TOKEN` | The Cloud **user session** access token. | `agent-relay cloud session --json --reveal-token` after a login dedicated to CI |
-| `CLOUD_API_REFRESH_TOKEN` | That session's refresh token. | `~/.agentworkforce/relay/cloud-auth.json`, field `refreshToken`, from the same login |
+  f.done("success");
+});
+```
 
-`CLOUD_API_URL` and `CLOUD_API_ACCESS_TOKEN_EXPIRES_AT` are not secret; the
-workflow defaults them and either can be overridden with a repository variable
-of the same name.
+# Use Cases
 
-A workspace key alone cannot run the swarm. `agent-relay cloud run` authenticates
-to the Cloud API as a user session and as nothing else: the workspace key is read
-only by the resolver that picks a messaging workspace, and `POST
-/api/v1/workflows/prepare` — which `--sync-code` requires, and `--sync-code` is
-how the swarm receives the PR diff — admits only a browser session or a token
-carrying the `cli:auth` scope. Given no session, the CLI opens an interactive
-device login that no runner can approve and exits after the grant expires.
+Flows can be run locally or in production on our hosted cloud. We're built entire 
+applications using flows that are stacked to run in a sequence with review gates that
+can run autonomously over days and weeks. Every agent session is observable and replayable.
 
-**These tokens expire, and this is a stopgap.** A CLI login mints a 24-hour
-access token backed by a 90-day refresh token, and every refresh rotates the
-refresh token server-side — invalidating the copy held in the secret, which a
-job cannot write back. Expect to re-mint `CLOUD_API_ACCESS_TOKEN` and
-`CLOUD_API_REFRESH_TOKEN` roughly daily until Cloud can issue a long-lived,
-non-refreshing CI token that carries `cli:auth` (the existing CI deployment
-tokens carry only `deployments:ci:*` and cannot launch a workflow).
+- Cloud pipeline to use agents to generate a social media post. The pipeline coordinates agents who do research, verify the post, check for authenticity, generate graphics, and gate on a human approval — [`examples/social-post-pipeline/`](examples/social-post-pipeline/)
+- Pull request review pipeline with different agents looking at the pull request from different angles (security, optimization etc) and agents communicate when needed to reach consensus — [`examples/pr-review-pipeline/`](examples/pr-review-pipeline/)
+- Dependency upgrade bot: deterministic check flags a dependency out of date which fires an agent who does the upgrade in a sandbox. This upgrade is gated on another agent verifying the entire application with computer use in another sandbox. If completely verified a pull request is opened up — [`examples/dependency-upgrade-bot/`](examples/dependency-upgrade-bot/)

[exit 0]
```

Exact posted comment: [226-comment.md](pr-triage-0907-evidence/226-comment.md).

Posted comment: [https://github.com/AgentWorkforce/flows/pull/226#issuecomment-5575838623](https://github.com/AgentWorkforce/flows/pull/226#issuecomment-5575838623).

```text
$ gh pr comment 226 --repo AgentWorkforce/flows --body-file ops/pr-triage-0907-evidence/226-comment.md
https://github.com/AgentWorkforce/flows/pull/226#issuecomment-5575838623

[exit 0]
```

```text
$ gh pr view 226 --repo AgentWorkforce/flows --json number,state,headRefOid,mergedAt,url
{"headRefOid":"dffc5b5ee3742c8a6d27f078ad388fda2f1db416","mergedAt":null,"number":226,"state":"OPEN","url":"https://github.com/AgentWorkforce/flows/pull/226"}

[exit 0]
```


## PR #222

**Verdict: supersede-and-close — superseded by later drive PR #226 (`dffc5b5ee3742c8a6d27f078ad388fda2f1db416`).**

Actual change: adds `test -n "$RELAY_WORKSPACE_KEY"` to `.github/workflows/review-swarm.yml` and rewrites `ops/NEXT.md` as a 239-line audit/assignment for that same check.

Direct comparison with #226 shows the workflow files differ only in the success echo string. Both enforce exactly the same three presence checks; #226 additionally addresses the credential-documentation issue. The audit prose is not byte-identical and will remain preserved here, but adds no separate implementation to retain. #226 is still open, not merged; closure consolidates duplicate implementation into that surviving proposal.

Staleness: three-way integration into current main is conflict-free, but the work package is superseded by #226. Main still lacks the workspace presence assertion; this closure does not claim the assertion already landed. #234 changes only NEEDS_HUMAN and does not replace the implementation.

Action: close in favor of #226; no merge or branch rewrite.

Evidence: [full gh pr diff](pr-triage-0907-evidence/222-diff.txt), [two-endpoint diff against main](pr-triage-0907-evidence/222-against-main.txt), [metadata and prior comments](pr-triage-0907-evidence/222-metadata.txt), [unique commits](pr-triage-0907-evidence/222-commits.txt). Two-endpoint diffs also show main changes absent from an older head; they are not the patch GitHub would integrate. The three-dot diff and merge-tree output distinguish the proposed patch.

```text
$ git diff --stat origin/main...refs/triage/pr-222
 .github/workflows/review-swarm.yml |   3 +-
 ops/NEXT.md                        | 279 ++++++++++++++++++++++++++++---------
 2 files changed, 219 insertions(+), 63 deletions(-)

[exit 0]
```

```text
$ git merge-tree --write-tree origin/main refs/triage/pr-222
da477e0ade84886635247143e9d98a88b91ee761

[exit 0]
```

```text
$ git diff refs/triage/pr-222 refs/triage/pr-226 -- .github/workflows/review-swarm.yml
diff --git a/.github/workflows/review-swarm.yml b/.github/workflows/review-swarm.yml
index 4008e8b..c37c23b 100644
--- a/.github/workflows/review-swarm.yml
+++ b/.github/workflows/review-swarm.yml
@@ -56,7 +56,7 @@ jobs:
           test -n "$CLOUD_API_URL"
           test -n "$CLOUD_API_KEY"
           test -n "$RELAY_WORKSPACE_KEY"
-          echo "Cloud authentication secrets present; interactive login is unreachable."
+          echo "CLOUD_API_URL, CLOUD_API_KEY, and RELAY_WORKSPACE_KEY present; interactive login is unreachable from here."
 
       # `agent-relay cloud run` launches the swarm, but nothing installed the
       # CLI, so this job failed at `Launch cloud swarm` with

[exit 0]
```

```text
$ git grep -n -A 7 'Validate cloud authentication' origin/main -- .github/workflows/review-swarm.yml
origin/main:.github/workflows/review-swarm.yml:54:      - name: Validate cloud authentication
origin/main:.github/workflows/review-swarm.yml-55-        run: |
origin/main:.github/workflows/review-swarm.yml-56-          test -n "$CLOUD_API_URL"
origin/main:.github/workflows/review-swarm.yml-57-          test -n "$CLOUD_API_KEY"
origin/main:.github/workflows/review-swarm.yml-58-          echo "CLOUD_API_URL and CLOUD_API_KEY present; interactive login is unreachable from here."
origin/main:.github/workflows/review-swarm.yml-59-
origin/main:.github/workflows/review-swarm.yml-60-      # `agent-relay cloud run` launches the swarm, but nothing installed the
origin/main:.github/workflows/review-swarm.yml-61-      # CLI, so this job failed at `Launch cloud swarm` with

[exit 0]
```

Exact posted comment: [222-comment.md](pr-triage-0907-evidence/222-comment.md).

Posted comment: [https://github.com/AgentWorkforce/flows/pull/222#issuecomment-5575839730](https://github.com/AgentWorkforce/flows/pull/222#issuecomment-5575839730).

```text
$ gh pr comment 222 --repo AgentWorkforce/flows --body-file ops/pr-triage-0907-evidence/222-comment.md
https://github.com/AgentWorkforce/flows/pull/222#issuecomment-5575839730

[exit 0]
```

```text
$ gh pr close 222 --repo AgentWorkforce/flows
✓ Closed pull request AgentWorkforce/flows#222 (drive: cloud run a579a0a5)

[exit 0]
```

```text
$ gh pr view 222 --repo AgentWorkforce/flows --json number,state,headRefOid,mergedAt,url
{"headRefOid":"f7baf4e3dec56116ebe987913a41aa8dfff19b08","mergedAt":null,"number":222,"state":"CLOSED","url":"https://github.com/AgentWorkforce/flows/pull/222"}

[exit 0]
```


## PR #219

**Verdict: supersede-and-close — superseded by later drive PR #226 (`dffc5b5ee3742c8a6d27f078ad388fda2f1db416`).**

Actual change: replaces `ops/NEXT.md` with a proposal to (1) add `test -n "$RELAY_WORKSPACE_KEY"` to preflight and (2) replace README session-token instructions with `CLOUD_API_KEY` instructions. It also adds `ops/NEXT.md.backup-1788764525`; it implements neither proposed change.

#226's diff implements both listed tasks. The backup blob is byte-for-byte identical to current main's `ops/NEXT.md`, so it contains no otherwise missing material. This is objective/content supersession, not an assertion that the prose of both briefs is identical or that #226 has landed. #226 remains open for a human decision and is the surviving proposal.

Staleness: three-way integration into current main is conflict-free. The standalone planning objective is overtaken by #226's implementation; additionally #233 (`3dc8a04`) has removed the old README section, so restoring the older brief would dispatch stale documentation work. The unique run assessment remains available in the closed PR.

Action: close in favor of #226; no merge or branch rewrite.

Evidence: [full gh pr diff](pr-triage-0907-evidence/219-diff.txt), [two-endpoint diff against main](pr-triage-0907-evidence/219-against-main.txt), [metadata and prior comments](pr-triage-0907-evidence/219-metadata.txt), [unique commits](pr-triage-0907-evidence/219-commits.txt). Two-endpoint diffs also show main changes absent from an older head; they are not the patch GitHub would integrate. The three-dot diff and merge-tree output distinguish the proposed patch.

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

Exact posted comment: [219-comment.md](pr-triage-0907-evidence/219-comment.md).

Posted comment: [https://github.com/AgentWorkforce/flows/pull/219#issuecomment-5575839309](https://github.com/AgentWorkforce/flows/pull/219#issuecomment-5575839309).

```text
$ gh pr comment 219 --repo AgentWorkforce/flows --body-file ops/pr-triage-0907-evidence/219-comment.md
https://github.com/AgentWorkforce/flows/pull/219#issuecomment-5575839309

[exit 0]
```

```text
$ gh pr close 219 --repo AgentWorkforce/flows
✓ Closed pull request AgentWorkforce/flows#219 (drive: cloud run da056466)

[exit 0]
```

```text
$ gh pr view 219 --repo AgentWorkforce/flows --json number,state,headRefOid,mergedAt,url
{"headRefOid":"ce14567a413df6687102835bb1c9819ea080eea3","mergedAt":null,"number":219,"state":"CLOSED","url":"https://github.com/AgentWorkforce/flows/pull/219"}

[exit 0]
```


## PR #214

**Verdict: supersede-and-close — completed target already on main in #120 (`201542a7485d0ad6274bb5939da51535831984b9`).**

Actual change: only `ops/NEEDS_HUMAN.md` and `ops/NEXT.md`; it replaces the #174 crash-resume assignment with a report that the older hn-monitor target is already complete, and asks what to do next. It adds no hn-monitor implementation.

The shipped replacement is the CLI-inlined runner from #120, subsequently given the real analyzer in #130 (`51415d9`) and moved under packages/ in #205 (`5ca5a7a`). The current-main code still contains the error classifier, AbortSignal input, close() limitation documentation, and tests named in this report. This is supersession of the requested target, not a claim that the report text was merged or that every Gate 2 acceptance clause is green. The report's own “1 failed” result is not passing evidence; no test suite was run for this triage.

Staleness: three-way integration into current main is conflict-free, but the original target is finished. Main's #210 (`9c1aa86`) already selected the next assignment, #174; restoring a completed-target report would undo that scheduling decision.

Action: close as completed-target output superseded by #120, retaining this diff and comment as the historical record. No merge or branch rewrite.

Evidence: [full gh pr diff](pr-triage-0907-evidence/214-diff.txt), [two-endpoint diff against main](pr-triage-0907-evidence/214-against-main.txt), [metadata and prior comments](pr-triage-0907-evidence/214-metadata.txt), [unique commits](pr-triage-0907-evidence/214-commits.txt). Two-endpoint diffs also show main changes absent from an older head; they are not the patch GitHub would integrate. The three-dot diff and merge-tree output distinguish the proposed patch.

```text
$ git diff --stat origin/main...refs/triage/pr-214
 ops/NEEDS_HUMAN.md |  80 +++++++++++++++--------
 ops/NEXT.md        | 185 +++++++++++++++++++++++++++++++++--------------------
 2 files changed, 171 insertions(+), 94 deletions(-)

[exit 0]
```

```text
$ git merge-tree --write-tree origin/main refs/triage/pr-214
9814d27795e33c96765b8b6b8f05f901c6b2b9b0

[exit 0]
```

```text
$ git log origin/main --oneline -- sdk/src/cli/hn-monitor.ts packages/sdk/src/cli/hn-monitor.ts
5ca5a7a refactor(layout): move sdk/ and surface/ under packages/ (#205)
51415d9 feat(gate2): real Claude analyzer for hn-monitor, with a declared model (#130)
201542a feat(cli): flows hn-monitor start — CLI-inlined proactive workload for gate 2 (#120)

[exit 0]
```

```text
$ git merge-base --is-ancestor 201542a7485d0ad6274bb5939da51535831984b9 origin/main

[exit 0]
```

```text
$ git grep -n -E 'signal\?: AbortSignal|HnTransientFetchError|non-transient error|Not implemented: releasing|private attached|private closing|private readonly inFlight|SURVIVES a typed|terminates.*JournalProtocolError' origin/main -- packages/sdk/src/cli/hn-monitor.ts packages/sdk/src/worker.ts packages/sdk/tests/cli-hn-monitor.test.ts
origin/main:packages/sdk/src/cli/hn-monitor.ts:9: *   - `instanceof HnTransientFetchError` → log and continue next tick.
origin/main:packages/sdk/src/cli/hn-monitor.ts:17:import { pollHackerNewsOnce, HnTransientFetchError, type Fetcher } from '../hn-poller.js';
origin/main:packages/sdk/src/cli/hn-monitor.ts:59:  signal?: AbortSignal;
origin/main:packages/sdk/src/cli/hn-monitor.ts:127:function sleepInterruptible(ms: number, signal?: AbortSignal): Promise<void> {
origin/main:packages/sdk/src/cli/hn-monitor.ts:257:        if (err instanceof HnTransientFetchError) {
origin/main:packages/sdk/src/cli/hn-monitor.ts:263:          io.stderr(`hn-monitor: non-transient error, terminating: ${nameAndMessage(err)}`);
origin/main:packages/sdk/src/worker.ts:24: * Not implemented: releasing the worker registration with the kernel.
origin/main:packages/sdk/src/worker.ts:32:  private attached = false;
origin/main:packages/sdk/src/worker.ts:33:  private closing = false;
origin/main:packages/sdk/src/worker.ts:34:  private readonly inFlight: Set<Promise<void>> = new Set();
origin/main:packages/sdk/tests/cli-hn-monitor.test.ts:17:import { HnTransientFetchError } from '../src/hn-poller.js';
origin/main:packages/sdk/tests/cli-hn-monitor.test.ts:194:  it('terminates (exit 1) on a JournalProtocolError from eventSubmit', async () => {
origin/main:packages/sdk/tests/cli-hn-monitor.test.ts:213:    expect(io.stderr_lines.some((l) => l.includes('non-transient error, terminating'))).toBe(true);
origin/main:packages/sdk/tests/cli-hn-monitor.test.ts:237:    expect(io.stderr_lines.some((l) => l.includes('non-transient error, terminating'))).toBe(true);
origin/main:packages/sdk/tests/cli-hn-monitor.test.ts:240:  it('SURVIVES a typed HnTransientFetchError (continues to next tick)', async () => {
origin/main:packages/sdk/tests/cli-hn-monitor.test.ts:253:        if (call === 1) throw new HnTransientFetchError('HN fetch failed: HTTP 503');
origin/main:packages/sdk/tests/cli-hn-monitor.test.ts:262:  it('SURVIVES a fetch()-level TypeError wrapped as HnTransientFetchError by defaultFetcher', async () => {
origin/main:packages/sdk/tests/cli-hn-monitor.test.ts:265:    // Now defaultFetcher wraps them in HnTransientFetchError so the
origin/main:packages/sdk/tests/cli-hn-monitor.test.ts:279:        if (call === 1) throw new HnTransientFetchError(

[exit 0]
```

```text
$ git log origin/main --oneline -5 -- ops/NEXT.md
9c1aa86 docs(next): point drive runs at #174 instead of human-blocked credential work (#210)
7023884 docs(next): the gate has a CLI that reads an API key, and no key to read (#194)
f163806 drive: cloud run 1ffd2aee (#200)
98b6cdd drive: cloud run fb9fce40 (#164)
27b7151 ops(next): point the tick at the CI coverage gap, not finished work (#152)

[exit 0]
```

Exact posted comment: [214-comment.md](pr-triage-0907-evidence/214-comment.md).

Posted comment: [https://github.com/AgentWorkforce/flows/pull/214#issuecomment-5575838937](https://github.com/AgentWorkforce/flows/pull/214#issuecomment-5575838937).

```text
$ gh pr comment 214 --repo AgentWorkforce/flows --body-file ops/pr-triage-0907-evidence/214-comment.md
https://github.com/AgentWorkforce/flows/pull/214#issuecomment-5575838937

[exit 0]
```

```text
$ gh pr close 214 --repo AgentWorkforce/flows
✓ Closed pull request AgentWorkforce/flows#214 (drive: cloud run a81e42e3)

[exit 0]
```

```text
$ gh pr view 214 --repo AgentWorkforce/flows --json number,state,headRefOid,mergedAt,url
{"headRefOid":"f8dfbdfc646a6076d9addd690c9f658b74e1ad90","mergedAt":null,"number":214,"state":"CLOSED","url":"https://github.com/AgentWorkforce/flows/pull/214"}

[exit 0]
```


## Final queue and action boundaries

Seven PRs remain open: the five protected live PRs plus #226 and #234. The three closed targets are unmerged, and all five target heads remain unchanged (literal per-PR state receipts above). This work issued no branch push, rebase, merge, protected-PR mutation, or Cloud PR call. No test-suite verification is claimed.

```text
$ gh pr list --repo AgentWorkforce/flows --state open --limit 30 --json number,title,headRefOid
[{"headRefOid":"0a9b69be08d2c20807f3f8ac1bd3048a7087731b","number":234,"title":"drive: cloud run e8f72867"},{"headRefOid":"862ddb80adceb5a0cf65926841e8bfe134b913a2","number":232,"title":"fix(review-swarm): make the auth gate actually validate, and fingerprint the key"},{"headRefOid":"dc7a33a8a11a70196a212bcf6b68fd8425bdf533","number":231,"title":"Add local relayflow launcher and execute backlog F8b"},{"headRefOid":"bd7fda328ece342851e4ab57d6729e941e3c19a8","number":230,"title":"feat(workflows): restack-verify — the post-merge gate, as a relayflow"},{"headRefOid":"a7b23cff7f394e16a77d02bc727be958365b8ae9","number":229,"title":"fix(review-gate): derive the lens verdict from its own Blockers section"},{"headRefOid":"8bbafca34b6fb15556b67b374da0625dd65d11ea","number":227,"title":"feat: declare and journal step placement with workspace pins (#225)"},{"headRefOid":"dffc5b5ee3742c8a6d27f078ad388fda2f1db416","number":226,"title":"drive: cloud run a7041b3d"}]

[exit 0]
```
