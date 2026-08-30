# NEXT — Work package for this tick

**Gate:** 3 (review-swarm automation)

**Scope (from TARGET.md):** Wire the review-swarm to fire on PR open via GitHub Actions + `agent-relay cloud run`. CODE task, `.github/workflows/`-side.

## Objective

Create `.github/workflows/review-swarm.yml` that automatically triggers the existing `workflows/review-swarm.yaml` on PR open/synchronize for drive-loop PRs, fetches the review transcripts, and posts them as PR comments.

## Files in scope

- `.github/workflows/review-swarm.yml` (NEW) — the GitHub Actions workflow
- `.github/workflows/scripts/swarm-post.sh` (NEW, optional) — companion script for posting comments
- `README.md` or `docs/` (EDIT) — document the `RELAY_WORKSPACE_KEY` repo secret requirement

## Definition of done

ALL of the following must be satisfied:

1. **`.github/workflows/review-swarm.yml` exists** and passes `actionlint` if installed, or `yamllint` otherwise
   - Verified by running: `actionlint .github/workflows/review-swarm.yml || yamllint .github/workflows/review-swarm.yml`
   - Must show: `(no errors)` or `PASS`

2. **Documentation updated** — `README.md` or `docs/` describes the required repo secret `RELAY_WORKSPACE_KEY` and what it does (one sentence minimum)
   - Verified by: `grep -r "RELAY_WORKSPACE_KEY" README.md docs/ | head -5`
   - Must show: at least one match explaining the secret

3. **Drive-loop author gate is correct** — the workflow's `jobs.review.if` correctly gates on drive-loop authors only (kjgbot, miyaontherelay)
   - Test expression by hand:
     ```bash
     # Test that kjgbot evaluates to true
     [ "kjgbot" = "kjgbot" ] || [ "kjgbot" = "miyaontherelay" ] && echo "TRUE for kjgbot" || echo "FALSE for kjgbot"
     # Test that khaliqgant evaluates to false
     [ "khaliqgant" = "kjgbot" ] || [ "khaliqgant" = "miyaontherelay" ] && echo "TRUE for khaliqgant" || echo "FALSE for khaliqgant"
     ```
   - Must show: `TRUE for kjgbot` and `FALSE for khaliqgant`

4. **SDK tests pass** — `cd sdk && npm test` must be green (currently FAILING with 19 failures)
   - Verified by running: `cd sdk && npm test 2>&1 | tail -20`
   - Must show: `Test Files  X passed (X)` with 0 failed, full output quoted

5. **Final git status** — as the LAST action, run `git status --porcelain` and paste it
   - Verified by: `git status --porcelain`
   - Must show: all new/modified files listed

## Out of scope for this tick

- **Actually firing the workflow** — this is a code task; testing against real GitHub Actions requires the `RELAY_WORKSPACE_KEY` secret to exist in the repo, which is a human prerequisite per ops/TARGET.md lines 88-98
- **Fixing SDK test failures** — the 19 SDK test failures appear to be related to CLI resolution and kernel protocol, NOT to this GitHub Actions workflow. They are pre-existing and should be filed separately if blocking.
- **Implementing the shell posting logic** — if a companion script is created, it only needs to demonstrate the structure; actual cloud run integration depends on the secret existing
- **Any other gates** — this run is pinned to gate 3 only

## Blockers identified

**BLOCKER: SDK tests are failing** (19 failures out of 197 tests). The definition of done requires SDK tests to pass. These failures appear unrelated to the GitHub Actions workflow and are likely pre-existing.

**BLOCKER: Cannot verify RELAY_WORKSPACE_KEY exists** — this is a cloud sandbox with no `gh` CLI auth and no git remote. Per ops/TARGET.md lines 88-98, if the secret is missing, this should be filed in ops/NEEDS_HUMAN.md and is NOT a blocker to writing the workflow code.

The workflow code can be written and validated with linting, but cannot be tested end-to-end without the secret.

## Assessment

This work package is **BLOCKED** on SDK test failures. The gate 3 task (create `.github/workflows/review-swarm.yml`) can be completed, but the definition of done includes "SDK tests green," which is currently false.

The SDK test failures are unrelated to the GitHub Actions work and appear to be kernel/CLI integration issues. They should be investigated separately or the definition of done should be revised to exclude them from this gate's scope.

**Recommendation:** File ops/NEEDS_HUMAN.md asking whether to:
- Option A: Fix the 19 SDK test failures first (out of gate 3 scope), then complete gate 3
- Option B: Revise gate 3's definition of done to remove the SDK test requirement, since it's unrelated to the GitHub Actions workflow
- Option C: Complete the workflow code despite the SDK failures, and file the SDK failures as a separate work package
