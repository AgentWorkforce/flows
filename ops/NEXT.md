# NEXT — work package for this tick

**Scope (quoted from gate 3 target):**
> Wire the review-swarm to fire on PR open via GitHub Actions + `agent-relay cloud run`. CODE task, `.github/workflows/`-side.

This run is pinned to **gate 3** and must not work on any other gate.

## Objective

Create `.github/workflows/review-swarm.yml` that automatically invokes the existing `workflows/review-swarm.yaml` on PR open/synchronize/reopen events for drive-loop PRs, polls for completion, syncs artifacts back, and posts each review as a PR comment.

## Context

`workflows/review-swarm.yaml` already exists — three model-diverse reviewers (claude/codex/opencode) that read a PR diff and produce three independent transcripts + one aggregate verdict. Today it only fires when a human writes `.review-target` and runs `agent-relay cloud run` by hand. It has run zero times against a drive PR on cloud.

RFC-0001 §2 rule 7 says the review team must be OUR own. The swarm is that team, but it is not firing automatically. External bots (CodeRabbit, Devin) are rate-limited or expired.

## Files in scope

- `.github/workflows/review-swarm.yml` — the GitHub Actions workflow (NEW FILE)
- `.github/workflows/scripts/swarm-post.sh` — shell script to post comments (NEW FILE)
- `README.md` or a doc in `docs/` — add one sentence about the required `RELAY_WORKSPACE_KEY` secret

## Definition of done

ALL of the following must hold:

1. **`.github/workflows/review-swarm.yml` exists and is valid**
   - Passes `actionlint` if installed, or `yamllint` otherwise
   - Triggers on: `pull_request` events `opened`, `synchronize`, `reopened`
   - Only runs if `github.event.pull_request.user.login` is `kjgbot` or `miyaontherelay`
   - Has concurrency group per PR (cancels earlier reviews on new push)

2. **The workflow job has these steps:**
   - Checkout PR head at merge commit
   - Install `agent-relay` (check `.env.example` for method — curl the release or use mise if configured)
   - Write PR number to `.review-target`: `echo "$PR_NUMBER" > .review-target`
   - Run `agent-relay cloud run workflows/review-swarm.yaml` with `RELAY_WORKSPACE_KEY` from repo secret; capture runId
   - Poll `agent-relay cloud status <runId> --json` every 30s until `status == completed` or 45 min timeout
   - Sync artifacts: `agent-relay cloud sync <runId>`
   - Read `ops/reviews/*-pr<N>-*.md` produced by swarm; post each as a PR comment via `gh pr comment`
   - Post aggregate marker: `🎯 review-swarm: PASSED|FAILED (M:<v> H:<v> S:<v>)` — grep aggregate step stdout for `SWARM_PASSED` or `SWARM_FAILED`

3. **`.github/workflows/scripts/swarm-post.sh` exists** (or inline equivalent)
   - Takes runId and PR number as arguments
   - Posts the review comments correctly
   - Can be tested standalone against an existing completed cloud run

4. **Documentation updated**
   - README.md or docs/ contains one sentence describing `RELAY_WORKSPACE_KEY` secret requirement and what it does

5. **The author-gate expression is correct**
   - Test the expression manually: verify it evaluates `true` for `kjgbot` and `false` for `khaliqgant`
   - Literal passing command and output MUST be quoted

6. **Dry-run test shown**
   - Run `.github/workflows/scripts/swarm-post.sh <real-runId> <PR>` against a real completed cloud run
   - Quote the literal command and the posted comment URL

7. **As LAST action before commit, run and paste:**
   ```
   git status --porcelain
   ```

## What is EXPLICITLY OUT OF SCOPE for this tick

- Do NOT touch `workflows/review-swarm.yaml` — it already exists and works
- Do NOT touch `sdk/src/worker.ts` (91 lines, shipped in PR #53) — it is the delivered worker
- Do NOT touch `kernel/relayflowd/src/server/tests.rs` or `server.rs` (gate-1 race test, PR #48)
- Do NOT touch preflight (`sdk/src/work-package-validator.ts`, PR #50)
- Do NOT create or fix the `RELAY_WORKSPACE_KEY` secret if it's missing — file ops/NEEDS_HUMAN.md
- Do NOT create a workaround for auth errors — file ops/NEEDS_HUMAN.md
- SDK tests currently fail due to missing exec bits (known sandbox fault per ops/STATE.md:186-192) — this is NOT a blocker for gate 3

## Prerequisites that may require NEEDS_HUMAN

1. **`RELAY_WORKSPACE_KEY` must exist as a GitHub Actions secret** at `AgentWorkforce/flows`
   - `gh secret list --repo AgentWorkforce/flows` shows if it's there (gh not available in this environment)
   - If missing during implementation: write ops/NEEDS_HUMAN.md stating the secret needs to be added at repo settings using the workspace key from `~/.agentworkforce/relay/cloud-auth.json` on the laptop

2. **`agent-relay cloud run` must reach the same workspace from GHA**
   - If auth fails: write ops/NEEDS_HUMAN.md, do NOT invent workarounds (no scoped token, no different endpoint)

## If blocked

A working `.github/workflows/review-swarm.yml` that stalls at the auth step, plus a NEEDS_HUMAN naming the missing secret, is a complete deliverable — the runbook is the artifact.

If gate 3 is genuinely unreachable, write ops/NEEDS_HUMAN.md saying exactly why and still end with ASSESS_DONE. Do not silently substitute different work.
