# NEXT — gate 3 review-swarm cloud implementation

## Scope (TARGET.md gate 3)

**Track D: Cloud review-swarm redesign** — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

## Objective

Implement the cloud GitHub Actions workflow that enforces RFC-0001 §2 rule 7: "every PR met by a review swarm — our own, not a vendor's". The local `~/AgentWorkforce/review-swarm-loop.sh` currently enforces this but lives on the chief's laptop. The cloud version must exist for gate 3+ work to be trustworthy.

## Files in scope

- `.github/workflows/review-swarm.yml` — the GHA trigger workflow (NEW)
- `.github/workflows/scripts/swarm-prepare.sh` — fetches PR data on launcher (NEW)
- `.github/workflows/scripts/swarm-post.sh` — syncs transcripts, extracts verdict, posts to PR (NEW)
- `.github/workflows/scripts/swarm-verdict.sh` — unified verdict extraction logic (NEW)
- `workflows/review-swarm.yaml` — refactor aggregate step to use shared verdict logic
- `.gitignore` — drop the `.review-target` mask
- `README.md` — document `RELAY_WORKSPACE_KEY` secret requirement

## Definition of done

All 9 requirements from TARGET.md §"Non-negotiable requirements" must be satisfied:

1. **Immutable gate** — `.github/workflows/review-swarm.yml` must checkout `main`'s copy of `workflows/review-swarm.yaml` + swarm scripts SEPARATELY from PR head using two `actions/checkout@v4` steps with different `path:` values

2. **Unified verdict-extraction logic** — aggregate logic exists in ONE file (`scripts/swarm-verdict.sh`), both `workflows/review-swarm.yaml` aggregate step AND `.github/workflows/scripts/swarm-post.sh` source it. Rules:
   - Transcript selection sorts by FILENAME (`YYYYMMDD-HHMM` prefix), not mtime
   - Verdict is the LAST non-empty line's token, not whole-file grep
   - `overall = ALL lenses PASSED, else FAILED` — fail-closed on MISSING/UNCLEAR/FAILED

3. **Auth secret validation fail-fast** — preflight step validates `RELAY_WORKSPACE_KEY` is set and non-empty BEFORE launching cloud run. If missing, fail with clear message

4. **Sticky marker + sticky transcripts** — marker comment uses hidden HTML anchor and edits in place. Three lens transcript comments MUST also edit in place using `<!-- swarm-lens: <lens> -->` anchors. A PR with 5 pushes ends with 1 marker + 3 transcripts (edited), NOT 5 markers + 15 transcripts

5. **Every PR gets reviewed** — NO author whitelist. Default: all PRs

6. **Cloud sandbox has no `gh` auth** — workflow must fetch PR diff + metadata on GHA runner via `gh pr diff/view`, stage into `.review-target/{pr-number,pr.diff,pr.json}`, `git add -f` (drop `.review-target` mask from `.gitignore`), then `agent-relay cloud run` uploads the working tree

7. **Job timeout > poll deadline > swarm timeoutMs** — documented invariant:
   - `workflows/review-swarm.yaml` `timeoutMs: 3600000` (60 min)
   - Wait step poll deadline: 3900s (65 min)
   - Job `timeout-minutes: 75` (65 + 10 min for install/checkout/post)
   - Add comments where each value lives naming the ordering invariant

8. **Wait step records terminal status; post step runs on always()** — structure:
   ```
   wait step: records $swarm_status output, always exits 0
   post step: if: always() && steps.launch.outputs.run_id != ''
   fail step: if: steps.wait.outputs.swarm_status != 'completed'
   ```

9. **Transcript-to-run-id binding** — aggregate rejects a transcript whose file mtime is older than the sync started (stale transcript guard)

### Passing commands (verification)

```bash
# Syntax validation
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))"
python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))"
bash -n .github/workflows/scripts/swarm-prepare.sh
bash -n .github/workflows/scripts/swarm-post.sh
bash -n .github/workflows/scripts/swarm-verdict.sh

# No author whitelist
! grep -r "github.event.pull_request.user.login" .github/workflows/

# Immutable gate: two checkouts present
grep -c "uses: actions/checkout@v4" .github/workflows/review-swarm.yml | grep -q "2"

# Verdict logic unified: both callers source swarm-verdict.sh
grep -q "source.*swarm-verdict.sh" workflows/review-swarm.yaml
grep -q "source.*swarm-verdict.sh" .github/workflows/scripts/swarm-post.sh

# .review-target not masked
! grep -q "^\.review-target" .gitignore

# SDK tests still pass (should be unaffected)
cd sdk && npm test
```

The final output must be:
```bash
git status --porcelain
```

## Out of scope

- `sdk/` (Track A owns that)
- `kernel/` (gate 1 done, no changes)
- `ops/*` (chief owns briefs and state)
- Any GHA workflow other than review-swarm.yml
- Actually TESTING the workflow in CI (requires `RELAY_WORKSPACE_KEY` secret set, which is a human step; DoD is the workflow being correct, not proven live)
- Prior closed work: picker actionability (#42), unterminated backticks (#45), gate-1 race test (#48), ops/NEXT.md validation (#50), SDK agent worker (#53), SDK pretest hook (#69)

## Current state

- No .github/ directory exists (needs to be created)
- workflows/review-swarm.yaml exists (the relayflow spec)
- No open PRs
- Tests passing:
  - kernel: 17 passed, 0 failed
  - SDK: 234 passed, 0 failed
- Gate 2 is AMBER (unattended trigger-plane proven but missing liveness check + analyze-agent execution)
- Gate 1 is GREEN
