# NEXT — work package for this tick

**Gate:** 3

**Scope:**
> Wire the review-swarm to fire on PR open via GitHub Actions + `agent-relay cloud run`. CODE task, `.github/workflows/`-side.
> Add `.github/workflows/review-swarm.yml`. That is the only file this tick should create; the workflow it invokes already exists.

## Objective

Create a GitHub Actions workflow that automatically triggers the existing `workflows/review-swarm.yaml` relayflow on PR open/synchronize/reopened for drive-loop PRs only (authors: kjgbot, miyaontherelay). The swarm produces three independent reviews (maintainability, history, structure) and an aggregate verdict.

## Files in scope

- `.github/workflows/review-swarm.yml` (NEW) — the GHA workflow
- `.github/workflows/scripts/swarm-post.sh` (NEW) — companion script to post comments
- `README.md` or `docs/` — document RELAY_WORKSPACE_KEY secret requirement (one sentence)

## Definition of done

All of the following must be satisfied:

1. **`.github/workflows/review-swarm.yml` exists and is valid:**
   ```bash
   actionlint .github/workflows/review-swarm.yml || yamllint .github/workflows/review-swarm.yml
   ```
   Must exit 0 and produce no errors.

2. **Documentation added:**
   README.md or docs/ describes the required repo secret `RELAY_WORKSPACE_KEY` and what it does — one sentence is enough.

3. **Author gating works correctly:**
   The workflow's `jobs.review.if` expression must be tested to verify it evaluates:
   - TRUE for kjgbot
   - TRUE for miyaontherelay
   - FALSE for khaliqgant

   Test the expression manually and paste the command + output.

4. **Shell script exists and works:**
   ```bash
   bash .github/workflows/scripts/swarm-post.sh <runId> <PR-number>
   ```
   Must successfully post comments from a completed cloud run. Show it working against an EXISTING completed cloud run and quote the posted comment URL.

5. **SDK tests remain green:**
   ```bash
   cd sdk && npm test
   ```
   All tests pass (currently 197 passed).

6. **Git status clean at end:**
   ```bash
   git status --porcelain
   ```
   Paste the literal output as the LAST action.

## Workflow requirements

Trigger: `pull_request` events `opened`, `synchronize`, `reopened`
Author filter: only kjgbot or miyaontherelay
Concurrency: group per PR (cancel in-progress on new push)

Steps:
1. Checkout PR head at merge commit
2. Install agent-relay (curl release or mise)
3. `echo "$PR_NUMBER" > .review-target`
4. `agent-relay cloud run workflows/review-swarm.yaml` with RELAY_WORKSPACE_KEY from secret; capture runId
5. Poll `agent-relay cloud status <runId> --json` every 30s until status==completed or 45min timeout
6. `agent-relay cloud sync <runId>` to fetch artifacts
7. Read `ops/reviews/*-pr<N>-*.md`; post each as PR comment via `gh pr comment`
8. Post aggregate marker: `🎯 review-swarm: PASSED|FAILED (M:<v> H:<v> S:<v>)` — grep for SWARM_PASSED or SWARM_FAILED from aggregate step stdout

## Explicitly OUT of scope

- **NOT creating the GitHub secret** — if `RELAY_WORKSPACE_KEY` is missing from `AgentWorkforce/flows` repo secrets, file ops/NEEDS_HUMAN.md and report it. The secret must be added manually by a human in repo settings.
- **NOT fixing auth failures** — if `agent-relay cloud run` fails with auth errors, file ops/NEEDS_HUMAN.md. Do not invent workarounds.
- **NOT running the workflow in CI** — dry-run testing only via the companion script.
- **NOT touching any other files** — specifically do not modify preflight, kernel tests, or sdk/src/worker.ts (which is gate 3 SDK work, not workflow work).
- **NOT working on gates 1, 2, 4-9** — this run is pinned to gate 3.

## Prerequisites (block if missing)

If either prerequisite fails, file ops/NEEDS_HUMAN.md:

1. `RELAY_WORKSPACE_KEY` must exist as a repo secret in AgentWorkforce/flows
2. `agent-relay cloud run` must reach the same cloud workspace as the laptop

A working workflow that stalls at auth + a NEEDS_HUMAN is a complete deliverable.
