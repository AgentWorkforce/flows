# NEXT — gate 3: Cloud review-swarm redesign

## Scope (from TARGET.md)

**Track D: Cloud review-swarm redesign** — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

This is the cloud version of the review swarm that enforces RFC-0001 §2 rule 7 ("every PR met by a review swarm — our own, not a vendor's"). The local `~/AgentWorkforce/review-swarm-loop.sh` works but lives on a laptop. The cloud version must exist for gate 3+ work to be trustworthy.

## Objective

Build `.github/workflows/review-swarm.yml` and supporting infrastructure to run `workflows/review-swarm.yaml` in the cloud, addressing all 9 architectural findings from prior rejected attempts (#75, #77).

## Files in scope

- `.github/workflows/review-swarm.yml` — GHA trigger workflow (NEW)
- `.github/workflows/scripts/swarm-prepare.sh` — launcher-side PR fetcher (NEW)
- `.github/workflows/scripts/swarm-post.sh` — sync + verdict + post script (NEW)
- `.github/workflows/scripts/swarm-verdict.sh` — unified verdict extraction logic (NEW)
- `workflows/review-swarm.yaml` — refactor aggregate step to use shared verdict logic
- `.gitignore` — drop the `.review-target` mask (line 10)
- `README.md` — document `RELAY_WORKSPACE_KEY` secret + how to obtain

## Definition of done

All 9 requirements from TARGET.md addressed:

1. **Immutable gate**: Two `actions/checkout@v4` steps in `.github/workflows/review-swarm.yml` with different `path:` values — PR head in one location, `main`'s copy of `workflows/review-swarm.yaml` + scripts in another. Launch swarm using main's gate files.

2. **Unified verdict logic**: One source of truth for verdict extraction. Either:
   - `scripts/swarm-verdict.sh` sourced by both aggregate step and swarm-post.sh, OR
   - Aggregate step trivial, swarm-post.sh does all extraction
   Must apply: filename sort (YYYYMMDD-HHMM), last non-empty line's token for verdict, fail-closed on MISSING/UNCLEAR/FAILED

3. **Auth secret validation**: Preflight step validates `RELAY_WORKSPACE_KEY` is set and non-empty BEFORE launching cloud run. If missing, fail with clear message. No 10-min fallback.

4. **Sticky marker + sticky transcripts**: Marker comment uses HTML anchor `<!-- swarm-marker -->` and edits in place. Three lens transcripts use `<!-- swarm-lens: <lens> -->` anchors. 5 pushes = 1 marker + 3 transcripts (edited), NOT 5 markers + 15 transcripts.

5. **No author whitelist**: All PRs reviewed (default). No `if: github.event.pull_request.user.login == ...`

6. **Cloud sandbox has no gh auth**: GHA runner fetches PR diff + metadata via `gh pr diff/view`, stages into `.review-target/{pr-number,pr.diff,pr.json}`, `git add -f` (ignore mask dropped). Then `agent-relay cloud run` uploads working tree.

7. **Timeout invariant documented**:
   - `workflows/review-swarm.yaml` `timeoutMs: 3600000` (60 min)
   - Wait step poll deadline: 3900s (65 min)
   - Job `timeout-minutes: 75` (65 + 10 for install/checkout/post)
   Comment at each location naming the ordering invariant.

8. **Wait step terminal status + post on always()**:
   ```yaml
   wait step: records $swarm_status output, always exits 0
   post step: if: always() && steps.launch.outputs.run_id != ''
   fail step: if: steps.wait.outputs.swarm_status != 'completed'
   ```
   Rejecting swarm's transcripts + marker MUST reach PR.

9. **Transcript-to-run-id binding**: Require ALL THREE transcripts newly-produced in THIS sync. If any transcript mtime older than sync start, reject as stale.

**Testing:**
- All files parse: `python3 -c "import yaml; yaml.safe_load(open('...'))"` for YAML files
- All bash scripts parse: `bash -n <file>` for each `.sh` file
- Verdict logic exists in ONE file, both callers use it
- No author whitelist present in `.github/workflows/review-swarm.yml`
- Two checkout steps with different paths present
- `.review-target` NOT in `.gitignore`
- `RELAY_WORKSPACE_KEY` documented in README.md

Final verification:
```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))"
bash -n .github/workflows/scripts/swarm-prepare.sh
bash -n .github/workflows/scripts/swarm-post.sh
bash -n .github/workflows/scripts/swarm-verdict.sh
git status --porcelain
```

## Explicitly OUT of scope

- `sdk/` (Track A owns that)
- `kernel/` (gate 1 done, no changes)
- `ops/*` (chief owns briefs and state)
- Any GHA workflow other than review-swarm.yml
- Actually TESTING the workflow in CI (requires `RELAY_WORKSPACE_KEY` secret set, which is a human step)
- The local `~/AgentWorkforce/review-swarm-loop.sh` (already works, stays on laptop)
- Do not redo: picker actionability (#42), unterminated backticks (#45), gate-1 race test (#48), ops/NEXT.md validation (#50), SDK agent worker (#53), SDK pretest hook (#69)

## Success criteria

PR body must explicitly document each of the 9 requirements and show where each is satisfied. The workflow must be correct by construction — all files parse, verdict logic unified, immutable gate implemented, timeouts properly ordered, and secrets validated before use.
