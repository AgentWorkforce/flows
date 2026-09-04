# NEXT — gate 3: cloud review-swarm (first increment)

## Scope

**Track D: Cloud review-swarm redesign** — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

This is gate 3 work as specified in ops/TARGET.md. The local review swarm (`workflows/review-swarm.yaml`) exists and works. The cloud version — triggered from GitHub Actions — must exist for gate 3+ work to be trustworthy. Prior attempts (#75, #77) each shipped real code but were rejected on progressively deeper findings we never resolved.

## Objective

Build a working cloud review-swarm system that:
1. Triggers on every PR without author whitelisting
2. Launches the swarm using main's gate files (immutable gate)
3. Fetches PR data on the GHA runner before cloud upload
4. Posts verdict + transcripts back to the PR via sticky comments
5. Fails the workflow if any lens rejects (merge gate)

## Files in scope

- `.github/workflows/review-swarm.yml` — NEW: GHA trigger workflow
- `.github/workflows/scripts/swarm-prepare.sh` — NEW: fetches PR data on GHA runner
- `.github/workflows/scripts/swarm-post.sh` — NEW: syncs, extracts verdict, posts to PR
- `.github/workflows/scripts/swarm-verdict.sh` — NEW: shared verdict extraction logic
- `workflows/review-swarm.yaml` — EDIT: refactor aggregate step to use shared verdict logic
- `.gitignore` — EDIT: drop the `.review-target` mask
- `README.md` — EDIT: document `RELAY_WORKSPACE_KEY` secret requirement

## Definition of done

All nine requirements from ops/TARGET.md addressed:

1. **Immutable gate**: `.github/workflows/review-swarm.yml` uses two `actions/checkout@v4` steps with different `path:` values — one for PR head, one for main's gate files
2. **Unified verdict logic**: exists in ONE file (`scripts/swarm-verdict.sh`), sourced by both aggregate step AND swarm-post.sh
3. **Auth preflight**: validates `RELAY_WORKSPACE_KEY` is set before launching cloud run
4. **Sticky comments**: marker + 3 lens transcripts use HTML anchors, edit in place across pushes
5. **No author whitelist**: all PRs reviewed (no `if: github.event.pull_request.user.login == ...`)
6. **Cloud sandbox has no gh auth**: `swarm-prepare.sh` fetches PR diff + metadata on GHA runner, stages into `.review-target/{pr-number,pr.diff,pr.json}`, `git add -f` before cloud upload
7. **Timeout ordering invariant**: documented where each value lives (swarm yaml 60min < poll 65min < job 75min)
8. **Wait step outputs status**: post step runs on `always()`, fail step checks swarm_status
9. **Transcript freshness check**: aggregate rejects stale transcripts (mtime older than sync start)

**Verification commands** (must pass):

```bash
# Syntax checks
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))"
bash -n .github/workflows/scripts/swarm-prepare.sh
bash -n .github/workflows/scripts/swarm-post.sh
bash -n .github/workflows/scripts/swarm-verdict.sh

# Author whitelist absent
! grep -q "pull_request.user.login" .github/workflows/review-swarm.yml

# Immutable gate: two checkout steps
grep -c "actions/checkout@v4" .github/workflows/review-swarm.yml | grep -q "^2$"

# .review-target not in .gitignore
! grep -q "^\.review-target$" .gitignore

# SDK tests still green (no cross-track damage)
cd sdk && npm test
```

**As final action**: `git status --porcelain`

## Out of scope

- `sdk/` (Track A owns that)
- `kernel/` (gate 1 done, no changes)
- `ops/*` (chief owns briefs and state)
- Any GHA workflow other than review-swarm.yml
- Actually testing the workflow in CI (requires `RELAY_WORKSPACE_KEY` secret set, which is a human step)
- Addressing findings from reviews not yet received (this is the first increment)

## Implementation strategy

Phase 1: Shared verdict logic foundation
- Create `.github/workflows/scripts/swarm-verdict.sh` implementing the three verdict rules:
  - Transcript selection sorts by FILENAME (`YYYYMMDD-HHMM` prefix), not mtime
  - Verdict is LAST non-empty line's token, not whole-file grep
  - `overall = ALL lenses PASSED, else FAILED` — fail-closed on MISSING/UNCLEAR/FAILED

Phase 2: GHA runner-side preparation
- Create `.github/workflows/scripts/swarm-prepare.sh` to fetch PR metadata via `gh` on GHA runner
- Drop `.review-target` from `.gitignore` so staged files survive `git add -f`

Phase 3: Post-swarm sync and comment logic
- Create `.github/workflows/scripts/swarm-post.sh` to:
  - Sync cloud run results back
  - Source swarm-verdict.sh for verdict extraction
  - Find or create sticky marker comment
  - Find or update 3 sticky lens transcript comments
  - Post verdict as sticky marker edit

Phase 4: Main GHA workflow
- Create `.github/workflows/review-swarm.yml` with:
  - Two checkout steps (PR head + main's gate files)
  - Auth secret preflight step
  - Prepare step (run swarm-prepare.sh)
  - Launch step (agent-relay cloud run)
  - Wait step (with status output, always exits 0)
  - Post step (if: always() && run_id != '')
  - Fail step (if: swarm_status != 'completed')
  - Documented timeout ordering

Phase 5: Refactor existing swarm aggregate
- Edit `workflows/review-swarm.yaml` aggregate step to source swarm-verdict.sh instead of duplicating logic

Phase 6: Documentation
- Add `RELAY_WORKSPACE_KEY` secret documentation to README.md with setup instructions

## Risks and mitigations

**Risk**: Verdict logic duplication despite shared script
**Mitigation**: Single source of truth in swarm-verdict.sh, both callers source it

**Risk**: Stale transcripts from prior run counted as fresh
**Mitigation**: Requirement #9 — aggregate checks mtime, rejects if older than sync start

**Risk**: Cloud sandbox can't post to PR
**Mitigation**: Requirement #6 — all PR posting happens on GHA runner in post step, not in cloud

**Risk**: Swarm rejection doesn't fail the workflow
**Mitigation**: Requirement #8 — wait step records status, separate fail step gates merge

