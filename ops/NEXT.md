# NEXT — work package WP-003: Cloud review-swarm infrastructure

This run is pinned to **gate 3** and must not work on any other gate.

**Scope:** **Track D: Cloud review-swarm redesign** — build `.github/workflows/review-swarm.yml` correctly, addressing every architectural finding from the walked-away #75/#77 attempts.

## Objective

Build cloud review-swarm infrastructure that enforces RFC-0001 §2 rule 7 ("every PR met by a review swarm") reliably from GitHub Actions, not just from the local laptop shell.

## Context

The local `~/AgentWorkforce/review-swarm-loop.sh` works but lives on a laptop. When that session ends, swarm enforcement ends. The cloud version must exist for gate 3+ work to be trustworthy. Prior attempts (#75, #77) shipped real code but were rejected on progressively deeper findings that were never resolved.

## Files in scope

- `.github/workflows/review-swarm.yml` — the GHA trigger
- `.github/workflows/scripts/swarm-post.sh` — sync + verdict + post script
- `.github/workflows/scripts/swarm-prepare.sh` — launcher-side PR fetcher
- `workflows/review-swarm.yaml` — aggregate step refactored for shared verdict logic
- `.gitignore` — drop the `.review-target` mask
- `README.md` — document `RELAY_WORKSPACE_KEY` secret

## Requirements (all 9 must be addressed)

### 1. Immutable gate
`.github/workflows/review-swarm.yml` must checkout `main`'s copy of `workflows/review-swarm.yaml` + `.github/workflows/scripts/swarm-post.sh` SEPARATELY from the PR head. Use two `actions/checkout@v4` steps with different `path:` values.

### 2. Unified verdict-extraction logic
Aggregate logic lives in ONE place — either a shared bash helper (`scripts/swarm-verdict.sh`) OR the yaml aggregate step becomes trivial and swarm-post.sh does all extraction. Rules:
- Transcript selection sorts by FILENAME (`YYYYMMDD-HHMM` prefix), not mtime
- Verdict is the LAST non-empty line's token, not a whole-file grep
- `overall = ALL lenses PASSED, else FAILED` — fail-closed

### 3. Auth secret validation fail-fast
Preflight step validates `RELAY_WORKSPACE_KEY` is set and non-empty BEFORE launching cloud run. If missing, fail with clear message.

### 4. Sticky marker + sticky transcripts
Marker comment uses hidden HTML anchor and edits in place. Three lens transcript comments MUST also edit in place using `<!-- swarm-lens: <lens> -->` anchors. A PR with 5 pushes should end with 1 marker + 3 transcripts, NOT 5 markers + 15 transcripts.

### 5. Every PR gets reviewed
NO author whitelist. Default: all PRs.

### 6. Cloud sandbox has no `gh` auth
GHA runner fetches PR diff + metadata via `gh pr diff/view`, stages into `.review-target/{pr-number,pr.diff,pr.json}`, `git add -f`. Then `agent-relay cloud run` uploads the working tree.

### 7. Job timeout > poll deadline > swarm timeoutMs
- `workflows/review-swarm.yaml` `timeoutMs: 3600000` (60 min)
- Wait step poll deadline: 3900s (65 min)
- Job `timeout-minutes: 75` (65 + 10 min for install/checkout/post)

### 8. Wait step records terminal status; post step runs on always()
```
wait step: records $swarm_status output, always exits 0
post step: if: always() && steps.launch.outputs.run_id != ''
fail step: if: steps.wait.outputs.swarm_status != 'completed'
```

### 9. Transcript-to-run-id binding
Require ALL THREE transcripts newly-produced in THIS sync; if any transcript's file mtime is older than sync started, reject as stale.

## Definition of done

- All files parse (`python3 -c "import yaml; yaml.safe_load(open('...'))"` ; `bash -n scripts/*.sh`)
- Aggregate verdict logic exists in ONE file, both callers use it
- Author whitelist absent (no `if: github.event.pull_request.user.login == ...`)
- Immutable gate: two checkout steps with different paths
- Requirements 1-9 addressed (see above)
- `git status --porcelain` as final action

**Note:** `cd sdk && npm test` requirement removed from DoD. Gate 3 scope (`.github/workflows/` + `workflows/review-swarm.yaml`) does NOT touch `sdk/`. The SDK is explicitly out of scope per TARGET.md line 86 ("Track A owns that"). Track isolation is the mechanism that makes parallel execution safe.

## Out of scope

- `sdk/` (Track A owns that) — including its tests
- `kernel/` (gate 1 done, no changes)
- `ops/*` (chief owns briefs and state)
- Any GHA workflow other than review-swarm.yml
- Actually TESTING the workflow in CI (requires human-set secret)

Work outside this target collides with sibling runs. Staying inside scope is what makes parallel execution safe.
