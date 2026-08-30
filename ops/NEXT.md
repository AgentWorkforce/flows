# NEXT — work package for this tick

**This run is pinned to gate 3.**

## Scope (quoted from ops/TARGET.md)

Wire the review-swarm to fire on PR open via GitHub Actions + `agent-relay cloud run`. CODE task, `.github/workflows/`-side.

## Objective

Create `.github/workflows/review-swarm.yml` that automatically triggers the existing `workflows/review-swarm.yaml` workflow when a PR is opened, synchronized, or reopened by a drive-loop author (`kjgbot`, `miyaontherelay`). The swarm transcripts are fetched and posted as PR comments.

## Files in scope

- `.github/workflows/review-swarm.yml` (to be created)
- `.github/workflows/scripts/swarm-post.sh` (optional helper script for posting comments)
- `README.md` or a doc in `docs/` (update to document `RELAY_WORKSPACE_KEY` secret requirement)

## Definition of done

ALL of the following must hold:

1. **`.github/workflows/review-swarm.yml` exists and is syntactically valid**
   - Must pass `actionlint` if installed, otherwise `yamllint`
   - Command to verify:
     ```
     actionlint .github/workflows/review-swarm.yml || yamllint .github/workflows/review-swarm.yml
     ```
   - Paste literal command and output

2. **Workflow triggers correctly scoped**
   - Triggers on: `pull_request` events `opened`, `synchronize`, `reopened`
   - Only runs if PR author is `kjgbot` or `miyaontherelay`
   - The job's `if` condition must correctly gate on drive-loop author only
   - Verify the expression evaluates true for `kjgbot` and false for `khaliqgant`
   - Paste the actual conditional expression from the workflow

3. **Documentation updated**
   - `README.md` or `docs/` contains a sentence describing the `RELAY_WORKSPACE_KEY` repo secret requirement
   - States what it's for (running the review swarm in GitHub Actions)
   - Command to verify:
     ```
     grep -r "RELAY_WORKSPACE_KEY" README.md docs/
     ```
   - Paste literal command and matching lines

4. **Dry-run test of the posting logic** (if applicable)
   - If a helper script is created (`.github/workflows/scripts/swarm-post.sh`), test it manually against an existing completed cloud run
   - Command format:
     ```
     bash .github/workflows/scripts/swarm-post.sh <runId> <PR-number>
     ```
   - Paste actual command and output showing posted comment URL
   - If no helper script created, describe inline posting logic in the workflow

5. **SDK tests remain green**
   - Command:
     ```
     cd sdk && npm test
     ```
   - Paste literal command and full output showing test counts

6. **Final state verification**
   - Command:
     ```
     git status --porcelain
     ```
   - Paste literal output

## Explicitly OUT of scope for this tick

- Actually running the workflow in GitHub Actions (requires the `RELAY_WORKSPACE_KEY` secret to exist in the repo)
- Modifying `workflows/review-swarm.yaml` (it already exists and is working)
- Modifying any kernel code in `kernel/`
- Modifying SDK code in `sdk/` (except to fix failures)
- Creating any tests in `kernel/` or modifying existing tests there
- Touching `ops/cargo.sh`, `sdk/src/worker.ts`, `sdk/src/work-package-validator.ts`, or any files from closed PRs listed in ops/TARGET.md
- Work on any gate other than gate 3

## Known blocker: RELAY_WORKSPACE_KEY prerequisite

Per ops/TARGET.md lines 89-94, the `RELAY_WORKSPACE_KEY` must exist as a GitHub Actions secret on `AgentWorkforce/flows`. This cannot be verified in this environment (no `gh` auth, no network to GitHub).

If the secret is missing, this is documented in ops/NEEDS_HUMAN.md and does not block creation of the workflow file itself. A working workflow that stalls at the auth step, plus documentation of the missing secret, is a complete deliverable.
