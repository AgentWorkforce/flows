# NEXT — work package for this tick

**Date:** 2026-08-31
**Gate:** 3
**Scope from TARGET.md:**

> Track D: Cloud review-swarm redesign — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

## Objective

Build `.github/workflows/review-swarm.yml` and supporting infrastructure to enforce RFC-0001 §2 rule 7 ("every PR met by a review swarm — our own, not a vendor's") in CI, addressing all nine non-negotiable requirements from prior rejected attempts #75 and #77.

## Files in scope

1. `.github/workflows/review-swarm.yml` — NEW, the GHA trigger that fires on pull_request events
2. `.github/workflows/scripts/swarm-prepare.sh` — NEW, fetches PR metadata on GHA runner (has `gh` auth)
3. `.github/workflows/scripts/swarm-post.sh` — NEW, syncs cloud run, extracts verdict, posts transcripts
4. `.github/workflows/scripts/swarm-verdict.sh` — NEW, unified verdict extraction logic (shared between aggregate step and post script)
5. `workflows/review-swarm.yaml` — EDIT, refactor aggregate step to use shared verdict logic
6. `.gitignore` — EDIT, drop the `.review-target` mask so staged PR metadata propagates through cloud upload
7. `README.md` — EDIT, document `RELAY_WORKSPACE_KEY` secret requirement and how to obtain it

## Definition of done

All of the following must hold and be verified with captured output:

### Parsing and syntax
```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))"
python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))"
bash -n .github/workflows/scripts/swarm-prepare.sh
bash -n .github/workflows/scripts/swarm-post.sh
bash -n .github/workflows/scripts/swarm-verdict.sh
```
All five commands must exit 0.

### Requirements addressed (verify by source read)

1. **Immutable gate (RFC-0001 decision #6):** `.github/workflows/review-swarm.yml` must checkout `main`'s copy of `workflows/review-swarm.yaml` + swarm scripts SEPARATELY from PR head using two `actions/checkout@v4` steps with different `path:` values
2. **Unified verdict logic:** aggregate logic lives in `.github/workflows/scripts/swarm-verdict.sh` and both `workflows/review-swarm.yaml` aggregate step AND `swarm-post.sh` source it
3. **Auth preflight:** workflow validates `RELAY_WORKSPACE_KEY` is set and non-empty BEFORE launching cloud run; fails job with clear message if missing
4. **Sticky transcripts:** lens transcript comments use `<!-- swarm-lens: <lens> -->` anchors and edit-in-place (not append) across pushes
5. **No author whitelist:** no `if: github.event.pull_request.user.login ==` filter
6. **Fetch on launching host:** `swarm-prepare.sh` runs `gh pr diff`/`gh pr view` on GHA runner, stages into `.review-target/{pr-number,pr.diff,pr.json}`, and `git add -f`s them before cloud upload
7. **Timeout invariant:** `workflows/review-swarm.yaml` `timeoutMs: 3600000` (60 min) < wait poll deadline 3900s (65 min) < job `timeout-minutes: 75`, with comment documenting ordering
8. **Wait/post/fail structure:** wait step records `swarm_status` output and always exits 0; post step runs `if: always() && steps.launch.outputs.run_id != ''`; fail step runs `if: steps.wait.outputs.swarm_status != 'completed'`
9. **Transcript freshness guard:** aggregate rejects any transcript whose mtime predates sync start (guards stale-transcript binding)

### Tests green
```bash
cd kernel && sh ../ops/cargo.sh test --workspace
```
Must show "test result: ok. N passed; 0 failed" and exit 0.

### Final state verification
```bash
git status --porcelain
```
Run as the LAST action to show what changed.

## Out of scope

- `sdk/` (Track A owns that; no sdk/ directory exists in this tree)
- `kernel/` (gate 1 done, no changes)
- `ops/*` briefs and state (chief owns those)
- Any GHA workflow other than review-swarm.yml
- Actually TESTING the workflow live in CI (requires `RELAY_WORKSPACE_KEY` secret configured, which is a human step; DoD is correctness-by-construction)
- Pushing to remote or opening a PR (no git history / no gh auth in this sandbox per STATE.md)

## Architectural context

This sandbox has **no `.git` history, no `gh` auth, and no network to GitHub** (STATE.md known fault #1-3). This is normal for cloud runs. The `verify` step will invoke scripts via `sh` and the exec bit is not preserved (fault #2), which is why all commands use `sh scriptname` rather than `./scriptname`.

Prior attempts #75 and #77 each shipped code but were rejected progressively:
- #75: basic structure wrong
- #77: immutable gate violation, duplicate verdict logic, no auth preflight, transcript spam across pushes

This package addresses ALL nine findings or it does not ship.

## If blocked

If this work cannot proceed, write `ops/NEEDS_HUMAN.md` with the exact question and options, commit the partial work, and still end with ASSESS_DONE.

Do not silently substitute different work — a run reporting progress on the wrong gate is worse than one reporting it is blocked.
