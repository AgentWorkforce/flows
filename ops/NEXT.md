# NEXT — work package for this tick

**Scope:** Wire the review-swarm to fire on PR open via GitHub Actions + `agent-relay cloud run`. CODE task, `.github/workflows/`-side.

This run is pinned to **gate 3** and must not work on any other gate.

## Objective

Create `.github/workflows/review-swarm.yml` that automatically triggers the existing `workflows/review-swarm.yaml` workflow when drive-loop PRs are opened, synchronized, or reopened. The swarm produces three independent reviews (maintainability/history/structure) and posts them as PR comments with an aggregate verdict.

## Context

`workflows/review-swarm.yaml` already exists in this repo — three model-diverse reviewers (claude/codex/opencode) that read a PR diff and produce three independent transcripts + one aggregate verdict. Today it only fires when a human writes `.review-target` and runs `agent-relay cloud run` by hand. It has run zero times against a drive PR on cloud.

Meanwhile the reviewers this repo actually depends on (CodeRabbit, Devin) are external SaaS bots: CodeRabbit rate-limits into silence and Devin's trial expired. RFC-0001 §2 rule 7 says the review team must be OUR own — the swarm is that team, and it is not firing.

The fix is one GitHub Actions workflow: on PR open/synchronize, write `.review-target`, invoke `agent-relay cloud run workflows/review-swarm.yaml`, poll for completion, `agent-relay cloud sync` the transcripts back, and post each as a PR comment with an aggregate marker.

## Files in scope

1. `.github/workflows/review-swarm.yml` — NEW, the GitHub Actions workflow (the only file this tick should create)
2. `README.md` OR `docs/` — ADD one sentence documenting the required `RELAY_WORKSPACE_KEY` secret

## Definition of done (all required, with captured output)

1. **`.github/workflows/review-swarm.yml` exists and passes `actionlint` if installed, or `yamllint` otherwise**
   - Trigger: `pull_request` events `opened`, `synchronize`, `reopened`
   - Only run if `github.event.pull_request.user.login` is a drive-loop author (`kjgbot`, `miyaontherelay`) — do not review human PRs
   - Concurrency group per PR so a second push cancels the first review
   - Job steps:
     1. checkout the PR's head at the merge commit
     2. install `agent-relay` (curl the release, or use `mise install` if that's how this repo does it — check `.mise.toml` and `.env.example`)
     3. `echo "$PR_NUMBER" > .review-target`
     4. `agent-relay cloud run workflows/review-swarm.yaml` with `RELAY_WORKSPACE_KEY` from a repo secret; capture the runId
     5. poll `agent-relay cloud status <runId> --json` every 30s until `status == completed` or 45 min elapse
     6. `agent-relay cloud sync <runId>` to fetch the run's artifacts
     7. read `ops/reviews/*-pr<N>-*.md` produced by the swarm; post each as a PR comment via `gh pr comment`
     8. post one aggregate marker comment: `🎯 review-swarm: PASSED|FAILED (M:<v> H:<v> S:<v>)` — the aggregate step of review-swarm.yaml prints `SWARM_PASSED` or `SWARM_FAILED` on stdout; grep for that.
   - Run validation and paste output:
     ```
     actionlint .github/workflows/review-swarm.yml
     ```
     OR if actionlint not available:
     ```
     yamllint .github/workflows/review-swarm.yml
     ```

2. **The workflow's `jobs.review.if` correctly gates on drive-loop author only**
   - Test the expression by hand: verify it evaluates true for kjgbot and false for khaliqgant
   - Paste the test commands and output showing both cases

3. **A dry-run test that proves the shell logic works**
   - A companion shell script `.github/workflows/scripts/swarm-post.sh` (or inline) that TAKES a runId as an argument and posts the comments
   - Show it working against an EXISTING completed cloud run by running:
     ```
     bash .github/workflows/scripts/swarm-post.sh <some-real-runId> <some-PR>
     ```
     and quoting the posted comment URL

4. **`README.md` or `docs/` describes the required repo secret**
   - `RELAY_WORKSPACE_KEY` and what it does — one sentence is enough

5. **`cd sdk && npm test` green (should be unaffected by this change)**
   - Paste the final test summary line showing test counts

6. **EVERY new test confirmed to FAIL against current code**
   - If any new tests are added, show the literal failing output quoted

7. **As your LAST action, run `git status --porcelain` and paste it**

## Explicitly OUT of scope

- Actually configuring the `RELAY_WORKSPACE_KEY` secret in GitHub repo settings (requires human access)
- Running the workflow end-to-end against a real PR (requires the secret to be configured)
- Modifying `workflows/review-swarm.yaml` (already exists and works)
- Modifying the SDK agent worker (`sdk/src/worker.ts` is shipped per PR #53 — do NOT rewrite it)
- Changes to `ops/NEXT.md` validation, preflight, or kernel code
- Work on any gate other than gate 3

## Prerequisites this brief cannot satisfy — surface, don't try to fix

- **`RELAY_WORKSPACE_KEY` must exist as a GitHub Actions secret** on `AgentWorkforce/flows`. `gh secret list --repo AgentWorkforce/flows` will show if it's there. If it is missing, write ops/NEEDS_HUMAN.md saying so and STILL end with ASSESS_DONE — this is a human step (add the secret in repo settings; workspace key is on the laptop at `~/.agentworkforce/relay/cloud-auth.json`).
- **`agent-relay cloud run` invoked from GHA must reach the same cloud workspace as the laptop.** If the run fails with an auth error, DO NOT invent a workaround (a scoped token, a different endpoint); file it as a NEEDS_HUMAN and stop.

## If you cannot finish

Say so and file what you learned. A working `.github/workflows/review-swarm.yml` that stalls at the auth step, plus a NEEDS_HUMAN naming the missing secret, is a complete deliverable — the runbook is the artifact.

Several drive runs execute in parallel, each pinned to a different gate. Work outside this target collides with a sibling run, so staying inside it is not a preference — it is what makes parallel execution safe.

If gate 3 is genuinely unreachable from the current state, write ops/NEEDS_HUMAN.md saying exactly why and still end with ASSESS_DONE. Do not silently substitute different work: a run that reports progress on the wrong gate is worse than one that reports it is blocked.
