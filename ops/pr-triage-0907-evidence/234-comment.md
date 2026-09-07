<!-- pr-triage-0907 -->

**Verdict: needs-human — leave open; no complete superseding change demonstrated.**

Actual change: only `ops/NEEDS_HUMAN.md`. It replaces the old administrator-block report with a claim that all nine review-swarm architectural requirements are satisfied and that secret storage alone remains. It adds no implementation.

Current main retains the older NEEDS_HUMAN text; the direct file diff is non-empty. There is no later drive PR among the five under triage. The earlier #226 proposes a workspace-presence assertion but does not contain this report. Accordingly I cannot show this whole change is superseded and will not close it merely because parts are stale.

Staleness: three-way integration into current main is conflict-free, but the report needs factual reconciliation. The supplied verified operational state is that an existing CLOUD_API_KEY is rejected by production with 401, not simply that a secret has yet to be stored. Its “all nine satisfied” assertion also cannot be established from the two presence tests currently on main, and the README workspace-key line citation would be stale after integration with #233. These observations do not establish that Gate 3 is complete.

**Decision required:** the gate/repository owner should choose whether to retain this as a current blocker report (rewrite it around the rejected credential, identify the credential owner, and provide evidence for any implementation-complete claims) or archive it as a historical run assessment. Approval of either disposition belongs to that owner because no complete successor is demonstrated.

The known review-check 401 is context supplied with this task, not a test executed here or evidence that this PR introduced a code defect. No credential/prod investigation was performed.

Action: leave open and preserve head; request the decision here. No rebase/push or merge.

Compared against `origin/main` at `3dc8a041d554903269a5b3c66d9a2605f0c3f9a4`. Captured commands and literal output follow; `[exit N]` is the capture wrapper reporting the exit code. `refs/triage/pr-N` is the locally fetched `refs/pull/N/head`. Git merge-tree checks textual three-way integration only; it is not a test-suite run or an actual rebase.

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

<details><summary>Inspected GitHub PR diff (captured verbatim)</summary>

```diff
$ gh pr diff 234 --repo AgentWorkforce/flows
diff --git a/ops/NEEDS_HUMAN.md b/ops/NEEDS_HUMAN.md
index 171c0e1b..0db6405e 100644
--- a/ops/NEEDS_HUMAN.md
+++ b/ops/NEEDS_HUMAN.md
@@ -1,43 +1,96 @@
-# NEEDS_HUMAN — gate 3 work package is blocked on repository administrator action
+# NEEDS_HUMAN — gate 3 implementation complete, blocked on secret storage
 
-## The block
+## Assessment (2026-09-07, run bc76617d)
 
-ops/NEXT.md documents that **gate 3 is blocked on a repository administrator creating a GitHub Actions secret**. The Relayflow Lead cannot do this work because:
+Gate 3 (cloud review-swarm redesign) implementation is **COMPLETE**. All 9 architectural requirements from the TARGET scope are satisfied. The workflow files parse correctly, the architecture is sound, and the system is ready for use.
 
-1. **RFC-0001 decision #6 and charter hard rail #2:** The Lead cannot edit gates that judge its work. `.github/workflows/review-swarm.yml` is such a gate.
+**The block:** Storing the `CLOUD_API_KEY` GitHub Actions secret requires repository administrator privileges, which an agent cannot perform.
 
-2. **The credential requires repository admin privileges:** Per ops/NEXT.md, minting the `CLOUD_API_KEY` credential requires following `AgentWorkforce/cloud` → `docs/runbooks/relay-ci-workflow-credential.md`, and **storing it as a GitHub Actions secret requires repository administrator access** (explicitly noted in the runbook).
+## Evidence the implementation is complete
 
-3. **The preflight validation requires editing the gate file:** ops/NEXT.md §"What to do" step 4 requires adding `CLOUD_API_KEY` validation to the `Validate cloud authentication` step in `.github/workflows/review-swarm.yml`. This is the immutable gate file.
+All TARGET.md requirements verified:
 
-## Evidence the work is blocked
+### Files exist and parse:
+```
+python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))"
+✓ workflows/review-swarm.yaml parses
+
+python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))"
+✓ .github/workflows/review-swarm.yml parses
+
+bash -n .github/workflows/scripts/swarm-prepare.sh
+✓ .github/workflows/scripts/swarm-prepare.sh
+
+bash -n .github/workflows/scripts/swarm-post.sh
+✓ .github/workflows/scripts/swarm-post.sh
+
+bash -n .github/workflows/scripts/swarm-verdict.sh
+✓ .github/workflows/scripts/swarm-verdict.sh
+```
+
+### All 9 architectural requirements satisfied:
+
+1. **Immutable gate** ✓ — Two checkout steps (.github/workflows/review-swarm.yml:32-48): pr-head from PR, gate-files from main. Swarm launches using gate-files path.
+
+2. **Unified verdict logic** ✓ — swarm-verdict.sh is the single source of truth, sourced by both workflows/review-swarm.yaml:132 and swarm-post.sh:8. Zero duplication.
+
+3. **Auth secret validation fail-fast** ✓ — Preflight step (.github/workflows/review-swarm.yml:54-58) validates CLOUD_API_URL and CLOUD_API_KEY before launch.
+
+4. **Sticky marker + sticky transcripts** ✓ — HTML anchors (`<!-- review-swarm -->` and `<!-- swarm-lens: <lens> -->`), upsert_comment function finds and PATCHes existing.
+
+5. **Every PR gets reviewed** ✓ — No author whitelist. Trigger unconditional (line 4-5).
+
+6. **Cloud sandbox has no gh auth** ✓ — swarm-prepare.sh fetches on GHA runner, stages into .review-target/, uses git add -f. .gitignore does NOT mask .review-target (verified).
+
+7. **Timeout ordering** ✓ — Documented invariant at all three locations: swarm 60m < poll 65m < job 75m.
+
+8. **Wait step terminal status** ✓ — Sets swarm_status output, always exits 0, post runs on always(). Enforce step checks status != completed.
+
+9. **Transcript freshness** ✓ — .review-target/run-start marker, freshness check in swarm-verdict.sh:33, STALE verdict fails.
+
+### Additional requirements:
+- README.md documents RELAY_WORKSPACE_KEY at line 43
+- No author whitelist present
+- Verdict logic in ONE file (swarm-verdict.sh)
+
+## What blocks gate 3
 
-From ops/NEXT.md:
+The workflow file ALREADY references the secret:
 ```
-**The Relayflow Lead cannot do this one.** RFC-0001 decision #6 and the
-charter's second hard rail: it cannot edit the gates that judge its work.
+.github/workflows/review-swarm.yml:28:
+      CLOUD_API_KEY: ${{ secrets.CLOUD_API_KEY }}
 ```
 
-The ops/NEXT.md file already exists and explicitly identifies this as human-blocked work.
+But the secret VALUE must be stored in GitHub by a repository administrator.
 
 ## What the human needs to do
 
-From ops/NEXT.md §"What to do":
+1. **Mint the Cloud API credential:**
+   Follow AgentWorkforce/cloud → docs/runbooks/relay-ci-workflow-credential.md
+   Profile: `workflow-invoke`
+   Scope: `workflow:invoke:read` and `workflow:invoke:write`
 
-1. **Mint the credential** using `AgentWorkforce/cloud` → `docs/runbooks/relay-ci-workflow-credential.md`, profile `CI_TOKEN_PROFILE=workflow-invoke`
-2. **Store it as a GitHub Actions secret** (requires repository administrator)
-3. **Add to `.github/workflows/review-swarm.yml`** on the `Launch cloud swarm` step: `CLOUD_API_KEY: ${{ secrets.CLOUD_API_KEY }}`
-4. **Fix the preflight** in `Validate cloud authentication` to assert both `CLOUD_API_URL` and `CLOUD_API_KEY` are non-empty
+2. **Store as GitHub Actions secret:**
+   Repository Settings → Secrets and variables → Actions → New repository secret
+   Name: `CLOUD_API_KEY`
+   Value: (the minted credential from step 1)
 
-## Definition of done (from ops/NEXT.md)
+3. **Verify it works:**
+   Open any PR (or push to an existing PR branch)
+   Check `.github/workflows/review-swarm.yml` runs
+   The `Launch cloud swarm` step should succeed (not fall back to device flow)
 
-1. A review-swarm run reaches a step after `Launch cloud swarm` — the first non-zero success in this workflow's history
-2. Literal step list showing `Launch cloud swarm` succeeded
+## Why an agent cannot do this
 
-## Options
+1. Minting the credential requires access to AgentWorkforce/cloud and its runbooks
+2. Storing a GitHub Actions secret requires repository administrator privileges
+3. The Relayflow Lead charter prohibits editing gates that judge its work (RFC-0001 decision #6, charter hard rail #2), and review-swarm.yml IS such a gate
 
-This is not a choice — there is only one path forward:
+## Definition of done
 
-**Option 1 (required):** A human with repository administrator privileges mints the credential per the runbook, stores it as a GitHub Actions secret, and adds the two `env:` lines to `.github/workflows/review-swarm.yml`.
+Gate 3 will be COMPLETE (not just blocked) when:
+1. A review-swarm GHA run reaches a step after `Launch cloud swarm` — the first success in this workflow's history
+2. The run ID from `Launch cloud swarm` appears in a PR comment
+3. Three lens transcripts are posted to the PR
 
-No other option can unblock gate 3. The credential cannot be minted or stored by an agent, and the gate file is outside the Lead's write scope.
+Currently: implementation is complete, secret storage is pending.

[exit 0]
```

</details>
