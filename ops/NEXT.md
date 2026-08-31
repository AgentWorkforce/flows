# NEXT — work package for this tick

**Scope (from ops/TARGET.md):** **Track D: Cloud review-swarm redesign** — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

## Objective

Build the cloud-hosted review swarm enforcement system that meets every PR with three independent reviewers (maintainability, history, structure), addressing all 9 non-negotiable requirements from prior PR rejections. This makes RFC-0001 §2 rule 7 ("every PR met by a review swarm") enforcement durable instead of laptop-dependent.

## Files in scope

- `.github/workflows/review-swarm.yml` — GitHub Actions trigger (create new)
- `.github/workflows/scripts/swarm-post.sh` — sync + verdict + post script (create new)
- `.github/workflows/scripts/swarm-prepare.sh` — launcher-side PR fetcher (create new)
- `.github/workflows/scripts/swarm-verdict.sh` — shared verdict extraction logic (create new)
- `workflows/review-swarm.yaml` — aggregate step refactored to use shared verdict logic
- `.gitignore` — drop the `.review-target` mask
- `README.md` — document `RELAY_WORKSPACE_KEY` secret + how to obtain it

## Definition of done

All of the following must pass:

1. **Syntax validation:**
```
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))"
python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))"
bash -n .github/workflows/scripts/swarm-post.sh
bash -n .github/workflows/scripts/swarm-prepare.sh
bash -n .github/workflows/scripts/swarm-verdict.sh
```

2. **Immutable gate verified:** `.github/workflows/review-swarm.yml` contains two separate `actions/checkout@v4` steps with different `path:` values — one for PR head, one for main's gate files.

3. **Unified verdict logic:** Either:
   - `scripts/swarm-verdict.sh` exists and both `workflows/review-swarm.yaml` aggregate step AND `.github/workflows/scripts/swarm-post.sh` source it, OR
   - `workflows/review-swarm.yaml` aggregate step is trivial and `.github/workflows/scripts/swarm-post.sh` does all extraction

4. **Auth preflight exists:** `.github/workflows/review-swarm.yml` contains a preflight step that validates `RELAY_WORKSPACE_KEY` is set and non-empty before launching cloud run.

5. **Sticky transcripts verified:** `.github/workflows/scripts/swarm-post.sh` uses `<!-- swarm-lens: <lens> -->` HTML anchors and finds-by-anchor before posting (not creating duplicate comments on every push).

6. **No author whitelist:** `.github/workflows/review-swarm.yml` contains no `if: github.event.pull_request.user.login == ...` condition.

7. **Timeout ordering documented:** Comments in the code show:
   - `workflows/review-swarm.yaml` `timeoutMs: 3600000` (60 min)
   - Wait step poll deadline: 3900s (65 min)
   - Job `timeout-minutes: 75` (65 + 10 min buffer)

8. **Wait/post structure verified:**
   - Wait step records `swarm_status` output, always exits 0
   - Post step has `if: always() && steps.launch.outputs.run_id != ''`
   - Fail step has `if: steps.wait.outputs.swarm_status != 'completed'`

9. **SDK tests green:**
```
cd sdk && npm test
```
(Must show all tests passing with exit 0)

10. **Git status clean:**
```
git status --porcelain
```
(Must show only the 7 files in scope, all staged)

## Out of scope

- `sdk/` — Track A owns that; do not modify
- `kernel/` — gate 1 done, no changes
- `ops/*` — chief owns briefs and state; do not modify
- Any GHA workflow other than review-swarm.yml
- Actually TESTING the workflow in CI (requires human to set `RELAY_WORKSPACE_KEY` secret)
- Implementing the `scripts/swarm-verdict.sh` verdict extraction (requirement #2 allows aggregate to stay in yaml)
- The `.review-target/{pr-number,pr.diff,pr.json}` fetch mechanism (requirement #6) — defer to implementation

## Requirements summary (all 9 must be satisfied)

1. **Immutable gate:** Two checkout steps with different paths — PR head vs main's gate files
2. **Unified verdict logic:** One source of truth for verdict extraction (shared script OR yaml-only)
3. **Auth preflight:** Validate `RELAY_WORKSPACE_KEY` before launch, fail-fast if missing
4. **Sticky transcripts:** HTML anchors, find-before-post, no duplicates
5. **No author whitelist:** All PRs reviewed
6. **Cloud fetch pattern:** GHA runner fetches PR diff/metadata, stages to `.review-target/`, git add -f
7. **Timeout ordering:** Job > poll > swarm, documented with comments
8. **Wait/post/fail structure:** Transcripts posted even on rejection, fail step gates merge
9. **Transcript freshness:** Sub-guard against stale transcripts (mtime check OR run-id binding)

## How this package fits gate 3

Gate 3's done-when (RFC-0001 §3): "the cloud review swarm enforces rule 7 for every PR, not just when my laptop is on." This package builds the `.github/workflows/review-swarm.yml` trigger that makes that true. The local `~/AgentWorkforce/review-swarm-loop.sh` currently enforces it, but ends when the laptop session ends. This moves enforcement to GitHub Actions + cloud sandbox.

Gate 3 will be AMBER after this lands (infrastructure exists) and GREEN when a real PR is reviewed by the cloud swarm and the transcripts + verdict reach the PR correctly.
