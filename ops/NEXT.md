# NEXT — gate 3: Cloud review-swarm redesign

## Scope (quoted from TARGET.md)

**Track D: Cloud review-swarm redesign** — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

The local `~/AgentWorkforce/review-swarm-loop.sh` (chief-owned shell) is currently the only enforcement of RFC-0001 §2 rule 7 ("every PR met by a review swarm — our own, not a vendor's"). It works, but it lives on my laptop. When my session ends, so does swarm enforcement.

The cloud version — `workflows/review-swarm.yaml` fired from `.github/workflows/review-swarm.yml` — must exist for gate 3+ work to be trustworthy. Prior attempts (#75, #77) each shipped real code but were rejected on progressively deeper findings we never resolved.

## Objective

Build a GitHub Actions workflow that triggers the review swarm on every PR, addressing all 9 non-negotiable requirements from prior swarm rejections, so that RFC-0001 §2 rule 7 enforcement moves from Khaliq's laptop to the cloud.

## Files in scope

- `.github/workflows/review-swarm.yml` — the GHA trigger (create/rewrite)
- `.github/workflows/scripts/swarm-post.sh` — sync + verdict + post script (create)
- `.github/workflows/scripts/swarm-prepare.sh` — launcher-side fetcher (create)
- `.github/workflows/scripts/swarm-verdict.sh` — unified verdict extraction logic (create)
- `workflows/review-swarm.yaml` — aggregate step refactored to share verdict logic
- `.gitignore` — drop the `.review-target` mask
- `README.md` — document `RELAY_WORKSPACE_KEY` secret + how to obtain

## Definition of done

All files parse and implement the 9 requirements from TARGET.md:

1. **Immutable gate** — two checkout steps with different paths (main's gate files judging PR head)
2. **Unified verdict logic** — ONE source of truth for transcript selection + verdict extraction
3. **Auth preflight** — validate `RELAY_WORKSPACE_KEY` before launching cloud run
4. **Sticky transcripts** — edit-in-place using HTML anchors (1 marker + 3 transcripts, not 5 markers + 15 transcripts)
5. **No author whitelist** — all PRs reviewed (no `if: github.event.pull_request.user.login == ...`)
6. **Cloud sandbox fetch workaround** — GHA runner fetches PR diff/metadata, stages to `.review-target/`, `git add -f`
7. **Timeout ordering** — job timeout > poll deadline > swarm timeoutMs (documented invariant)
8. **Terminal status capture** — wait step records status output, post step runs on `always()`, fail step gates merge
9. **Transcript freshness guard** — reject stale transcripts (mtime older than sync start)

### Passing commands required

```bash
# Parse checks
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))"
python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))"
bash -n .github/workflows/scripts/swarm-post.sh
bash -n .github/workflows/scripts/swarm-prepare.sh
bash -n .github/workflows/scripts/swarm-verdict.sh

# Aggregate verdict logic exists in ONE file
grep -l "REVIEW_PASSED\|REVIEW_FAILED" .github/workflows/scripts/swarm-verdict.sh

# No author whitelist
! grep -q "github.event.pull_request.user.login" .github/workflows/review-swarm.yml

# Immutable gate: two checkout steps
grep -c "actions/checkout@v4" .github/workflows/review-swarm.yml
# ^ must output: 2

# SDK tests still green
cd sdk && npm test
# ^ must show: Test Files  1 failed | 16 passed (17)
#              Tests  1 failed | 236 passed (237)

# Final status
git status --porcelain
```

## Out of scope

- `sdk/` (Track A owns that; tests must stay green but no changes)
- `kernel/` (gate 1 done, no changes)
- `ops/*` (chief owns briefs and state)
- Any GHA workflow other than review-swarm.yml
- Actually TESTING the workflow in CI (requires `RELAY_WORKSPACE_KEY` secret set which is a human step)

## Current state assessment

**Repository state:**
- Gate 1: GREEN (closed on PR #48)
- Gate 2: AMBER (see STATE.md)
- Gate 3: RED (this work package)
- SDK tests: 236/237 passing (1 known flaky test in cli-hn-monitor.test.ts)
- Open PRs: NONE (per STATE.md last updated 2026-09-01 10:16 UTC)
- Known sandbox faults: no git history, no gh auth, exec bit not preserved (all documented in STATE.md)

**Current files:**
- `workflows/review-swarm.yaml` exists and is complete with 3-lens swarm definition
- `.github/workflows/review-swarm.yml` does NOT exist (this is the work)
- `.github/workflows/scripts/` does NOT exist (create directory + 3 scripts)
- `.github/workflows/cloud-runtime-artifact.yml` exists but is out of scope

**Critical constraints from prior PR rejections (#75, #77):**
All 9 requirements listed above are non-negotiable and were real findings from prior attempts. Each requirement addresses a specific architectural failure that caused a PR to be rejected. Do not ship without addressing all 9.

**This is gate 3 work only.** Several drive runs execute in parallel, each pinned to a different gate. Working outside this target collides with sibling runs. If gate 3 is unreachable, write ops/NEEDS_HUMAN.md and still end with ASSESS_DONE.
