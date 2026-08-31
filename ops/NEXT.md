# NEXT — gate 3 work package

**Scope:** Wire the review-swarm to fire on PR open via GitHub Actions + `agent-relay cloud run`. CODE task, `.github/workflows/`-side.

This run is pinned to **gate 3** and must not work on any other gate.

## Objective

Add `.github/workflows/review-swarm.yml` that automatically invokes the existing `workflows/review-swarm.yaml` workflow on PR open/synchronize/reopened events for drive-loop authored PRs. The swarm produces three independent review transcripts (maintainability/history/structure) plus an aggregate verdict, which are synced back and posted as PR comments.

## Context

`workflows/review-swarm.yaml` already exists in this repo — three model-diverse reviewers (claude/codex/opencode) that read a PR diff and produce three independent transcripts + one aggregate verdict. Today it only fires when a human writes `.review-target` and runs `agent-relay cloud run` by hand. It has run zero times against a drive PR on cloud.

Meanwhile the reviewers this repo actually depends on (CodeRabbit, Devin) are external SaaS bots: CodeRabbit rate-limits into silence and Devin's trial expired. RFC-0001 §2 rule 7 says the review team must be OUR own — the swarm is that team, and it is not firing.

The fix is one GitHub Actions workflow: on PR open/synchronize, write `.review-target`, invoke `agent-relay cloud run workflows/review-swarm.yaml`, poll for completion, `agent-relay cloud sync` the transcripts back, and post each as a PR comment with an aggregate marker.

## Files in scope

- `.github/workflows/review-swarm.yml` (CREATE) — the only file this tick should create
- `README.md` or a `docs/*.md` file (EDIT) — document the RELAY_WORKSPACE_KEY secret requirement (one sentence)

## Definition of done

ALL of the following must pass:

1. **`.github/workflows/review-swarm.yml` exists and passes lint**
   ```bash
   test -f .github/workflows/review-swarm.yml && echo "exists"
   ```
   Output: `exists`

   ```bash
   which actionlint >/dev/null 2>&1 && actionlint .github/workflows/review-swarm.yml || yamllint .github/workflows/review-swarm.yml
   ```
   Output: Must pass with no errors (actionlint preferred, yamllint fallback)

2. **The workflow's `jobs.review.if` correctly gates on drive-loop author only**
   Test the expression by hand:
   ```bash
   node -e "console.log(['kjgbot', 'miyaontherelay'].includes('kjgbot'))"
   ```
   Output: `true`

   ```bash
   node -e "console.log(['kjgbot', 'miyaontherelay'].includes('khaliqgant'))"
   ```
   Output: `false`

3. **README.md or docs/ describes the required repo secret**
   ```bash
   grep -l RELAY_WORKSPACE_KEY README.md docs/*.md 2>/dev/null | head -1
   ```
   Output: Must show at least one file path containing the documentation

4. **A dry-run test proves the shell logic works**
   A companion shell script `.github/workflows/scripts/swarm-post.sh` (or inline) that TAKES a runId as an argument and posts the comments. Show it working against an EXISTING completed cloud run:
   ```bash
   bash .github/workflows/scripts/swarm-post.sh <some-real-runId> <some-PR>
   ```
   Output: Must show posted comment URL or confirmation

5. **SDK tests remain green** (unaffected by this change)
   ```bash
   cd sdk && npm test 2>&1 | grep "Test Files"
   ```
   Output: `Test Files  14 passed (14)` or similar all-green

6. **EVERY new test confirmed to FAIL against current code**
   With the literal failing output quoted in the summary.

7. **Final file status**
   ```bash
   git status --porcelain
   ```
   Output: Must show the created/modified files

## Workflow requirements

Scope it small and honest:

- **Trigger:** `pull_request` events `opened`, `synchronize`, `reopened`
- **Author filter:** Only run if `github.event.pull_request.user.login` is a drive-loop author (`kjgbot`, `miyaontherelay`) — do not review human PRs
- **Concurrency:** Group per PR so a second push cancels the first review
- **Job steps:**
  1. Checkout the PR's head at the merge commit
  2. Install `agent-relay` (curl the release, or use `mise install` if that's how this repo does it — check `.mise.toml` and `.env.example`)
  3. `echo "$PR_NUMBER" > .review-target`
  4. `agent-relay cloud run workflows/review-swarm.yaml` with `RELAY_WORKSPACE_KEY` from a repo secret; capture the runId
  5. Poll `agent-relay cloud status <runId> --json` every 30s until `status == completed` or 45 min elapse
  6. `agent-relay cloud sync <runId>` to fetch the run's artifacts
  7. Read `ops/reviews/*-pr<N>-*.md` produced by the swarm; post each as a PR comment via `gh pr comment`
  8. Post one aggregate marker comment: `🎯 review-swarm: PASSED|FAILED (M:<v> H:<v> S:<v>)` — the aggregate step of review-swarm.yaml prints `SWARM_PASSED` or `SWARM_FAILED` on stdout; grep for that.

## Prerequisites this brief cannot satisfy

- **`RELAY_WORKSPACE_KEY` must exist as a GitHub Actions secret** on `AgentWorkforce/flows`. `gh secret list --repo AgentWorkforce/flows` will show if it's there. If it is missing, write ops/NEEDS_HUMAN.md saying so and STILL end with ASSESS_DONE — this is a human step.
- **`agent-relay cloud run` invoked from GHA must reach the same cloud workspace as the laptop.** If the run fails with an auth error, DO NOT invent a workaround; file it as a NEEDS_HUMAN and stop.

## Explicitly OUT of scope

- **Creating or verifying the RELAY_WORKSPACE_KEY secret** — document the requirement; human creates it if missing
- **Auth troubleshooting beyond documentation** — if auth fails, document it in NEEDS_HUMAN.md
- **Modifying workflows/review-swarm.yaml** — it already exists and works
- **Reviewing human PRs** — filter ensures only drive-loop PRs trigger
- **Any changes to kernel/, sdk/, testdata/, or other code** — only .github/workflows/ and docs
- **Work on any gate other than gate 3**

## If blocked

If gate 3 is genuinely unreachable from the current state, write ops/NEEDS_HUMAN.md saying exactly why and still end with ASSESS_DONE. Do not silently substitute different work: a run that reports progress on the wrong gate is worse than one that reports it is blocked.

A working `.github/workflows/review-swarm.yml` that stalls at the auth step, plus a NEEDS_HUMAN naming the missing secret, is a complete deliverable — the runbook is the artifact.
