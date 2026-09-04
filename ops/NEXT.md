# NEXT — Work package for this tick

**Gate:** 3 (Cloud review-swarm redesign)

**Scope (quoted from TARGET.md):**

> Track D: Cloud review-swarm redesign — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

## Objective

Build the cloud-based GitHub Actions review-swarm workflow that enforces RFC-0001 §2 rule 7: every PR gets reviewed by our own swarm. The local `~/AgentWorkforce/review-swarm-loop.sh` exists but lives on the chief's laptop; the cloud version must exist for gate 3+ work to be trustworthy.

This addresses all 9 architectural findings from rejected PRs #75 and #77.

## Files in scope

- `.github/workflows/review-swarm.yml` — new GHA trigger file
- `.github/workflows/scripts/swarm-prepare.sh` — new launcher-side PR fetcher
- `.github/workflows/scripts/swarm-post.sh` — new sync + verdict + post script
- `.github/workflows/scripts/swarm-verdict.sh` — new shared verdict logic (single source of truth)
- `workflows/review-swarm.yaml` — refactor aggregate step to use shared verdict logic
- `.gitignore` — drop `.review-target` mask (line 10)
- `README.md` — document `RELAY_WORKSPACE_KEY` secret setup

## Requirements (the 9 architectural findings)

### 1. Immutable gate
The reviewed PR must NOT control its own judge. `.github/workflows/review-swarm.yml` must checkout `main`'s copy of `workflows/review-swarm.yaml` and `.github/workflows/scripts/*.sh` SEPARATELY from the PR head. Use two `actions/checkout@v4` steps with different `path:` values.

### 2. Unified verdict-extraction logic
One source of truth for verdict logic. Create `scripts/swarm-verdict.sh` that both the aggregate step and `swarm-post.sh` source. Rules:
- Transcript selection sorts by FILENAME (`YYYYMMDD-HHMM` prefix), not mtime
- Verdict is the LAST non-empty line's token, not whole-file grep
- `overall = ALL lenses PASSED, else FAILED` — fail-closed on MISSING/UNCLEAR/FAILED

### 3. Auth secret validation fail-fast
Preflight step validates `RELAY_WORKSPACE_KEY` is set and non-empty BEFORE launching cloud run. If missing, fail with clear message. Do NOT proceed to interactive fallback.

### 4. Sticky marker + sticky transcripts
Use HTML anchors to edit-in-place across pushes. A PR with 5 pushes should end with 1 marker + 3 transcripts (edited to latest), NOT 5 markers + 15 transcripts. Use `<!-- swarm-lens: <lens> -->` anchors.

### 5. Every PR gets reviewed
NO author whitelist. All PRs are reviewed.

### 6. Cloud sandbox has no `gh` auth
GHA runner has `gh` auth, cloud sandbox does not. The workflow must fetch PR diff + metadata on the GHA runner via `gh pr diff/view`, stage into `.review-target/{pr-number,pr.diff,pr.json}`, `git add -f` (drop the `.gitignore` mask on `.review-target`), then `agent-relay cloud run` uploads the working tree.

### 7. Job timeout > poll deadline > swarm timeoutMs
Documented invariant:
- `workflows/review-swarm.yaml` `timeoutMs: 3600000` (60 min)
- Wait step poll deadline: 3900s (65 min)
- Job `timeout-minutes: 75` (65 + 10 for install/checkout/post)
Add comments naming this ordering invariant.

### 8. Wait step records terminal status; post step runs on always()
Structure:
```yaml
wait step: records $swarm_status output, always exits 0
post step: if: always() && steps.launch.outputs.run_id != ''
fail step: if: steps.wait.outputs.swarm_status != 'completed'
```
A rejecting swarm's transcripts + marker MUST reach the PR.

### 9. Transcript-to-run-id binding
Require ALL THREE transcripts newly-produced in THIS sync. If any transcript's file mtime is older than when the sync started, reject as stale.

## Definition of done

ALL of the following must be true:

1. All files parse correctly:
```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))"
bash -n .github/workflows/scripts/swarm-prepare.sh
bash -n .github/workflows/scripts/swarm-post.sh
bash -n .github/workflows/scripts/swarm-verdict.sh
```

2. Aggregate verdict logic exists in ONE file (`scripts/swarm-verdict.sh`), both callers use it

3. Author whitelist absent (no `if: github.event.pull_request.user.login == ...`)

4. Immutable gate: two checkout steps with different paths in `.github/workflows/review-swarm.yml`

5. PR body explicitly documents each of the 9 requirements above and shows where each is satisfied

6. SDK tests green:
```bash
cd sdk && npm test
```

7. Final verification:
```bash
git status --porcelain
```

## Out of scope

- `sdk/` (Track A owns that)
- `kernel/` (gate 1 done, no changes)
- `ops/*` (chief owns briefs and state)
- Any GHA workflow other than review-swarm.yml
- Actually TESTING the workflow in CI (requires `RELAY_WORKSPACE_KEY` secret set, which is a human step)

The definition of done is the workflow being CORRECT, not proven live.
