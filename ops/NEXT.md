# NEXT — work package for this tick

**Scope:** Wire the review-swarm to fire on PR open via GitHub Actions + `agent-relay cloud run`. CODE task, `.github/workflows/`-side.

This run is pinned to **gate 3** and must not work on any other gate.

## Objective

Create `.github/workflows/review-swarm.yml` that automatically invokes the existing `workflows/review-swarm.yaml` when a PR is opened, synchronized, or reopened. This is the only file this tick should create.

The existing review-swarm workflow already exists at `workflows/review-swarm.yaml` and works — it delivers three independent model-diverse reviews (claude/codex/opencode) with an aggregate verdict. Today it only fires when a human manually writes `.review-target` and runs `agent-relay cloud run`. This task makes it fire automatically for drive-loop PRs.

## Why this matters

From TARGET.md: "`workflows/review-swarm.yaml` already exists in this repo — three model-diverse reviewers (claude/codex/opencode) that read a PR diff and produce three independent transcripts + one aggregate verdict. Today it only fires when a human writes `.review-target` and runs `agent-relay cloud run` by hand. It has run zero times against a drive PR on cloud.

Meanwhile the reviewers this repo actually depends on (CodeRabbit, Devin) are external SaaS bots: CodeRabbit rate-limits into silence and Devin's trial expired. RFC-0001 §2 rule 7 says the review team must be OUR own — the swarm is that team, and it is not firing."

## Files in scope

- `.github/workflows/review-swarm.yml` (new)
- `.github/workflows/scripts/swarm-post.sh` (new, optional companion script)
- `README.md` or `docs/` (update to document `RELAY_WORKSPACE_KEY` secret)

## Definition of done

ALL of the following must hold:

1. **`.github/workflows/review-swarm.yml` exists and is valid**
   - Passes `actionlint` if installed, or `yamllint` otherwise
   - Command to verify: `actionlint .github/workflows/review-swarm.yml` OR `yamllint .github/workflows/review-swarm.yml`
   - Must paste the literal command and its output

2. **Workflow triggers correctly**
   - Triggers on: `pull_request` events `opened`, `synchronize`, `reopened`
   - Only runs if `github.event.pull_request.user.login` is a drive-loop author (`kjgbot`, `miyaontherelay`) — do not review human PRs
   - Concurrency group per PR so a second push cancels the first review

3. **Workflow author-gating is correct**
   - The `jobs.review.if` expression correctly gates on drive-loop author only
   - Test the expression by hand: verify it evaluates true for kjgbot and false for khaliqgant
   - Must paste the test command and output showing both cases

4. **Job steps are complete and correct**
   - 1. checkout the PR's head at the merge commit
   - 2. install `agent-relay` (curl the release, or use `mise install` if `.mise.toml` exists — check first; no .mise.toml exists, so use curl or npm)
   - 3. `echo "$PR_NUMBER" > .review-target`
   - 4. `agent-relay cloud run workflows/review-swarm.yaml` with `RELAY_WORKSPACE_KEY` from a repo secret; capture the runId
   - 5. poll `agent-relay cloud status <runId> --json` every 30s until `status == completed` or 45 min elapse
   - 6. `agent-relay cloud sync <runId>` to fetch the run's artifacts
   - 7. read `ops/reviews/*-pr<N>-*.md` produced by the swarm; post each as a PR comment via `gh pr comment`
   - 8. post one aggregate marker comment: `🎯 review-swarm: PASSED|FAILED (M:<v> H:<v> S:<v>)` — grep for `SWARM_PASSED` or `SWARM_FAILED` from stdout

5. **Documentation exists**
   - `README.md` or `docs/` describes the required repo secret `RELAY_WORKSPACE_KEY` and what it does — one sentence is enough

6. **Dry-run test proves shell logic works**
   - A companion shell script `.github/workflows/scripts/swarm-post.sh` (or inline) that TAKES a runId as an argument and posts the comments
   - Show it working against an EXISTING completed cloud run by running:
     ```
     bash .github/workflows/scripts/swarm-post.sh <some-real-runId> <some-PR>
     ```
   - Must paste the posted comment URL

7. **SDK tests remain green (unaffected by this change)**
   - Command: `cd sdk && npm test`
   - Must paste the literal output showing test counts

8. **Every new test confirmed to FAIL against current code**
   - If any tests are added, show the failing output quoted in the summary

9. **Final state verification**
   - As the LAST action, run `git status --porcelain` and paste it

## What is explicitly OUT of scope

1. **DO NOT touch the existing `workflows/review-swarm.yaml`** — it already works
2. **DO NOT try to fix missing prerequisites**:
   - If `RELAY_WORKSPACE_KEY` secret is missing: write `ops/NEEDS_HUMAN.md` and still end with ASSESS_DONE
   - If `agent-relay cloud run` fails with auth error: write `ops/NEEDS_HUMAN.md` and stop
3. **DO NOT rewrite `sdk/src/worker.ts`** — per TARGET.md, shipped as PR #53 (9681f11), do not touch it
4. **DO NOT touch preflight** — closed as PR #47
5. **DO NOT touch gate-1 race regression test** — closed as PR #48
6. **DO NOT touch `sdk/src/work-package-validator.ts`** — closed as PR #50
7. **DO NOT work on any gate other than gate 3**

## Blockers requiring NEEDS_HUMAN

If any of the following are true, write `ops/NEEDS_HUMAN.md` with the exact question and still end with ASSESS_DONE:

1. `RELAY_WORKSPACE_KEY` is missing as a GitHub Actions secret
   - The secret should be on the laptop at `~/.agentworkforce/relay/cloud-auth.json`
   - Check with: `gh secret list --repo AgentWorkforce/flows` (may fail in sandbox with no gh auth)
2. `agent-relay cloud run` invoked from GHA fails with auth error and no clear fix

## Known prerequisites

From TARGET.md section "Prerequisites this brief cannot satisfy — surface, don't try to fix":

- `RELAY_WORKSPACE_KEY` must exist as a GitHub Actions secret on `AgentWorkforce/flows`
- `agent-relay cloud run` invoked from GHA must reach the same cloud workspace as the laptop
- If missing, file NEEDS_HUMAN and stop — a working workflow that stalls at auth, plus a NEEDS_HUMAN naming the missing secret, is a complete deliverable
