# Work package — gate 3, review-swarm GitHub Actions integration

**Scope from target:** Wire the review-swarm to fire on PR open via GitHub Actions + `agent-relay cloud run`. CODE task, `.github/workflows/`-side.

## Objective

Add `.github/workflows/review-swarm.yml` that triggers the existing `workflows/review-swarm.yaml` workflow on PR events, runs it via `agent-relay cloud run`, and posts the review transcripts as PR comments. This is the only file this tick should create; the workflow it invokes already exists.

## Files in scope

- `.github/workflows/review-swarm.yml` — NEW, the GitHub Actions workflow
- `.github/workflows/scripts/swarm-post.sh` (or inline shell) — NEW, companion script to post comments
- `README.md` or `docs/` — EDIT one sentence to document `RELAY_WORKSPACE_KEY` secret

## Definition of done (ALL required)

1. `.github/workflows/review-swarm.yml` exists
2. Passes `actionlint` if installed, or `yamllint` otherwise. Literal command and output:
   ```
   actionlint .github/workflows/review-swarm.yml
   [paste exact output]
   ```
3. `README.md` or `docs/` describes the required repo secret (`RELAY_WORKSPACE_KEY`) and what it does — one sentence is enough
4. The workflow's `jobs.review.if` correctly gates on drive-loop author only. Test the expression by hand and show it evaluates true for kjgbot and false for khaliqgant:
   ```
   [paste literal test command and output showing true/false results]
   ```
5. A dry-run test proving the shell logic works against an EXISTING completed cloud run. Literal command and output:
   ```
   bash .github/workflows/scripts/swarm-post.sh <some-real-runId> <some-PR>
   [paste exact output including posted comment URL]
   ```
6. `npm test` green (unaffected by this change). Literal command and output:
   ```
   npm test
   [paste exact summary showing Test Files passed/failed counts]
   ```
   Note: tests requiring kernel binaries will fail in this sandbox environment; what matters is that core SDK tests remain green.
7. As LAST action, run `git status --porcelain` and paste it:
   ```
   git status --porcelain
   [paste exact output]
   ```

## Workflow specification

Trigger:
- `pull_request` events: `opened`, `synchronize`, `reopened`
- Only run if `github.event.pull_request.user.login` is a drive-loop author (`kjgbot`, `miyaontherelay`)
- Concurrency group per PR so a second push cancels the first review

Job steps:
1. Checkout the PR's head at the merge commit
2. Install `agent-relay` (check if this repo uses `mise` via `.mise.toml`, or curl the release)
3. `echo "$PR_NUMBER" > .review-target`
4. `agent-relay cloud run workflows/review-swarm.yaml` with `RELAY_WORKSPACE_KEY` from repo secret; capture the runId
5. Poll `agent-relay cloud status <runId> --json` every 30s until `status == completed` or 45 min elapse
6. `agent-relay cloud sync <runId>` to fetch the run's artifacts
7. Read `ops/reviews/*-pr<N>-*.md` produced by the swarm; post each as a PR comment via `gh pr comment`
8. Post one aggregate marker comment: `🎯 review-swarm: PASSED|FAILED (M:<v> H:<v> S:<v>)` — grep the aggregate step output for `SWARM_PASSED` or `SWARM_FAILED`

## Prerequisites this brief cannot satisfy

If either of these is missing, write ops/NEEDS_HUMAN.md and still end with ASSESS_DONE:

1. **`RELAY_WORKSPACE_KEY` must exist as a GitHub Actions secret** on `AgentWorkforce/flows`. Cannot be created from this sandbox.
2. **`agent-relay cloud run` invoked from GHA must reach the same cloud workspace as the laptop.** If the run fails with an auth error, DO NOT invent a workaround — file it as NEEDS_HUMAN.

## Explicitly OUT of scope

- Building the kernel
- Running kernel tests
- Modifying `workflows/review-swarm.yaml` (it already exists)
- Modifying preflight logic (`ops/preflight.sh` or SDK preflight)
- Touching `sdk/src/work-package-validator.ts` (closed by PR #50)
- Touching `kernel/relayflowd/src/server/tests.rs` or `server.rs` (closed by PR #48)
- Touching `sdk/src/worker.ts` (closed by PR #53)
- Any work on gates other than gate 3
