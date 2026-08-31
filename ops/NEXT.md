# NEXT — work package for this tick

**Scope (gate 3):** Wire the review-swarm to fire on PR open via GitHub Actions + `agent-relay cloud run`. CODE task, `.github/workflows/`-side.

## Objective

Add `.github/workflows/review-swarm.yml` that automatically invokes the existing `workflows/review-swarm.yaml` when a drive-loop PR is opened, synchronize, or reopened. This satisfies RFC-0001 §2 rule 7: the review team must be OUR own.

## Files in scope

- `.github/workflows/review-swarm.yml` (new file)
- `.github/workflows/scripts/swarm-post.sh` (new file) — posts review comments
- `README.md` or `docs/` (one sentence documenting `RELAY_WORKSPACE_KEY` secret)

## Definition of done

All of the following must hold:

1. **`.github/workflows/review-swarm.yml` exists and is valid**
   - Passes `actionlint` if installed, or `yamllint` otherwise
   - Triggers on `pull_request` events: `opened`, `synchronize`, `reopened`
   - Only runs if `github.event.pull_request.user.login` is a drive-loop author (`kjgbot` or `miyaontherelay`)
   - Has concurrency group per PR so a second push cancels the first review

2. **Workflow gates on drive-loop author only**
   - Test the expression by hand: verify it evaluates true for kjgbot and false for khaliqgant
   - Command run and output shown:
     ```
     [command showing the if-condition evaluation for kjgbot → true]
     [command showing the if-condition evaluation for khaliqgant → false]
     ```

3. **Shell script for posting comments exists**
   - `.github/workflows/scripts/swarm-post.sh` takes a runId and PR number as arguments
   - Reads `ops/reviews/*-pr<N>-*.md` files
   - Posts each as a PR comment via `gh pr comment`
   - Posts one aggregate marker: `🎯 review-swarm: PASSED|FAILED (M:<v> H:<v> S:<v>)`

4. **Dry-run test proves it works**
   - Run the script against an existing completed cloud run
   - Command and output shown:
     ```
     bash .github/workflows/scripts/swarm-post.sh <actual-runId> <actual-PR>
     [output showing comment URLs posted]
     ```

5. **Documentation updated**
   - `README.md` or `docs/` describes the required `RELAY_WORKSPACE_KEY` repo secret (one sentence is enough)

6. **SDK tests still pass**
   - `cd sdk && npm test` — all tests green
   - Full test output quoted

7. **Final state check**
   - Run `git status --porcelain` and paste the output

## Workflow job steps (for reference)

The workflow should include these steps in order:
1. Checkout the PR's head at the merge commit
2. Install `agent-relay` (check `.mise.toml` and `.env.example` for installation method)
3. `echo "$PR_NUMBER" > .review-target`
4. `agent-relay cloud run workflows/review-swarm.yaml` with `RELAY_WORKSPACE_KEY` from repo secret; capture runId
5. Poll `agent-relay cloud status <runId> --json` every 30s until status == completed or 45 min elapse
6. `agent-relay cloud sync <runId>` to fetch artifacts
7. Read `ops/reviews/*-pr<N>-*.md` and post each as PR comment via `gh pr comment`
8. Post aggregate marker comment based on swarm output (grep for `SWARM_PASSED` or `SWARM_FAILED`)

## Explicitly OUT of scope

- Do not modify `workflows/review-swarm.yaml` (it already exists and works)
- Do not modify `sdk/src/worker.ts` (per ops/TARGET.md line 16-21)
- Do not modify `kernel/relayflowd/src/server/tests.rs` or `server.rs` (per ops/TARGET.md line 12-13)
- Do not modify `ops/NEXT.md` validation in `sdk/src/work-package-validator.ts` (per ops/TARGET.md line 14-15)
- Do not touch preflight (per ops/TARGET.md line 11)
- Do not re-implement any merged PRs listed in ops/TARGET.md lines 9-21

## Blocked prerequisites (surface, don't fix)

If these are missing, write `ops/NEEDS_HUMAN.md` and still end with ASSESS_DONE:

1. `RELAY_WORKSPACE_KEY` must exist as a GitHub Actions secret on `AgentWorkforce/flows`
   - Check with: `gh secret list --repo AgentWorkforce/flows` (may fail in sandbox)
   - If missing, the human must add it via repo settings
   - Workspace key is at `~/.agentworkforce/relay/cloud-auth.json` on the laptop

2. `agent-relay cloud run` invoked from GHA must reach the same cloud workspace as the laptop
   - If auth fails, DO NOT invent workarounds
   - File as NEEDS_HUMAN and stop

## Success criteria

A working `.github/workflows/review-swarm.yml` that may stall at the auth step, plus a NEEDS_HUMAN naming the missing secret, is a complete deliverable. The runbook is the artifact.
