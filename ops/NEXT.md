# NEXT — work package for this tick

**Scope:** Wire the review-swarm to fire on PR open via GitHub Actions + `agent-relay cloud run`. CODE task, `.github/workflows/`-side.

This run is pinned to **gate 3** and must not work on any other gate.

## Objective

Add `.github/workflows/review-swarm.yml` that automatically triggers the existing `workflows/review-swarm.yaml` on PR open/synchronize events for drive-loop PRs only.

## Status: BLOCKED

See `ops/NEEDS_HUMAN.md` for the blocking decision.

This environment is a cloud sandbox with:
- No git repository (`.git` points to nonexistent `/home/daytona/.project-git`)
- No GitHub CLI authentication
- No `agent-relay` CLI for testing
- No network to GitHub (ops/STATE.md Known environment fault #3)

The task's definition of done requires: dry-run testing against a real cloud run, git commits, and `git status --porcelain` output. These cannot be satisfied here.

## Files in scope (when unblocked)

- `.github/workflows/review-swarm.yml` — CREATE: GitHub Actions workflow
- `README.md` or `docs/review-swarm.md` — DOCUMENT: RELAY_WORKSPACE_KEY requirement
- `.github/workflows/scripts/swarm-post.sh` — CREATE: companion script for posting comments

## Definition of done (from TARGET.md)

ALL of the following must hold:

1. `.github/workflows/review-swarm.yml` exists and passes `actionlint` if installed, or `yamllint` otherwise

2. `README.md` or `docs/` describes the required repo secret (`RELAY_WORKSPACE_KEY`) and what it does — one sentence is enough

3. The workflow's `jobs.review.if` correctly gates on drive-loop author only (test the expression by hand: verify it evaluates true for kjgbot and false for khaliqgant)

4. A dry-run test that proves the shell logic works: a companion shell script `.github/workflows/scripts/swarm-post.sh` (or inline) that TAKES a runId as an argument and posts the comments. Show it working against an EXISTING completed cloud run by running:
   ```
   bash .github/workflows/scripts/swarm-post.sh <some-real-runId> <some-PR>
   ```
   and quoting the posted comment URL

5. `cd sdk && npm test` green (should be unaffected by this change)

6. EVERY new test confirmed to FAIL against current code, with the literal failing output quoted in your summary

7. As your LAST action, run `git status --porcelain` and paste it

## Explicitly OUT of scope

- Do NOT modify `workflows/review-swarm.yaml` (already complete)
- Do NOT modify `sdk/src/worker.ts` (off-limits per TARGET.md line 16-22)
- Do NOT touch preflight (`deterministic-command preflight refusal #47`)
- Do NOT touch kernel/relayflowd/src/server/tests.rs or server.rs (`gate-1 race regression test #48`)
- Do NOT touch sdk/src/work-package-validator.ts (`ops/NEXT.md validation #50`)
- Do NOT work on any gate other than gate 3

## Why this is blocked

1. Cannot verify RELAY_WORKSPACE_KEY secret exists (no `gh` CLI)
2. Cannot perform dry-run test (no `agent-relay` CLI)
3. Cannot commit work (no git repository)
4. Cannot run `git status --porcelain` (no git repository)

The task was designed for a development environment with full tooling. See ops/NEEDS_HUMAN.md for options.
