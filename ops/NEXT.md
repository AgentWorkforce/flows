# NEXT — work package for this tick

**Scope:** Build the cloud review-swarm infrastructure (gate 3, Track D) correctly, addressing all architectural findings from the walked-away #75/#77 attempts.

This run is pinned to **gate 3** per ops/TARGET.md. The scope is:

> Track D: Cloud review-swarm redesign — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

The cloud version of review-swarm must exist for gate 3+ work to be trustworthy. Prior attempts (#75, #77) shipped real code but were rejected on progressively deeper findings we never resolved.

## Objective

Create the cloud GitHub Actions workflow that enforces RFC-0001 §2 rule 7 ("every PR met by a review swarm — our own, not a vendor's") in CI, not just on the chief's laptop.

## Files in scope

- `.github/workflows/review-swarm.yml` — the GHA trigger (NEW FILE)
- `.github/workflows/scripts/swarm-post.sh` — the sync + verdict + post script (NEW FILE)
- `.github/workflows/scripts/swarm-prepare.sh` — the launcher-side fetcher (NEW FILE)
- `workflows/review-swarm.yaml` — aggregate step refactored to share verdict logic
- `.gitignore` — drop the `.review-target` mask
- `README.md` — document `RELAY_WORKSPACE_KEY` secret + how to obtain

## Definition of done

The nine non-negotiable requirements from ops/TARGET.md must all be satisfied:

1. **Immutable gate** — `.github/workflows/review-swarm.yml` must checkout `main`'s copy of `workflows/review-swarm.yaml` + `.github/workflows/scripts/swarm-post.sh` SEPARATELY from the PR head. Use two `actions/checkout@v4` steps with different `path:` values.

2. **Unified verdict-extraction logic** — aggregate logic lives in ONE place. Either a shared bash helper file both source (`scripts/swarm-verdict.sh`) OR the yaml aggregate step becomes trivial and swarm-post.sh does all extraction. Rules that must apply uniformly:
   - Transcript selection sorts by FILENAME (`YYYYMMDD-HHMM` prefix), not mtime
   - Verdict is the LAST non-empty line's token, not a whole-file grep
   - `overall = ALL lenses PASSED, else FAILED` — fail-closed on MISSING/UNCLEAR/FAILED

3. **Auth secret validation fail-fast** — Add a preflight step that validates `RELAY_WORKSPACE_KEY` is set and non-empty BEFORE launching the cloud run. If missing, fail the job with a clear message.

4. **Sticky marker + sticky transcripts** — The marker comment uses a hidden HTML anchor and edits in place. So MUST the three lens transcript comments. Use `<!-- swarm-lens: <lens> -->` anchors, find-by-anchor before posting.

5. **Every PR gets reviewed** — NO author whitelist. Default: all PRs.

6. **Cloud sandbox has no `gh` auth** — GHA runner has `gh` auth. Cloud sandbox does not. The workflow must fetch PR diff + metadata on the GHA runner via `gh pr diff/view`, stage them into `.review-target/{pr-number,pr.diff,pr.json}`, `git add -f`.

7. **Job timeout > poll deadline > swarm timeoutMs** — documented invariant:
   - `workflows/review-swarm.yaml` `timeoutMs: 3600000` (60 min)
   - Wait step poll deadline: 3900s (65 min)
   - Job `timeout-minutes: 75` (65 + 10 min for install/checkout/post)

8. **Wait step must record terminal status as output; post step runs on always()** — Structure:
   ```
   wait step: records $swarm_status output, always exits 0
   post step: if: always() && steps.launch.outputs.run_id != ''
   fail step: if: steps.wait.outputs.swarm_status != 'completed'  # exit 1 gates merge
   ```

9. **Transcript-to-run-id binding** — require ALL THREE transcripts newly-produced in THIS sync; if any transcript's file mtime is older than the sync started, reject as stale.

Additionally:
- All files parse (`python3 -c "import yaml; yaml.safe_load(open('...'))"` ; `bash -n scripts/*.sh`)
- Author whitelist absent (no `if: github.event.pull_request.user.login == ...`)
- PR body explicitly documents each of the 9 requirements above and shows where each is satisfied
- `cd sdk && npm test` green (should be unaffected)
- as your LAST action, `git status --porcelain`

## Explicitly OUT of scope

- `sdk/` (Track A owns that)
- `kernel/` (gate 1 done, no changes)
- `ops/*` (chief owns briefs and state)
- Any GHA workflow other than review-swarm.yml
- Actually TESTING the workflow in CI (requires `RELAY_WORKSPACE_KEY` secret set which is a human step; the DoD is the workflow being correct, not proven live)

## Current state

**Tests passing:**

SDK tests (237 passed):
```
 Test Files  17 passed (17)
      Tests  237 passed (237)
   Start at  21:50:37
   Duration  45.96s
```

Kernel tests still running in background task bb58cfc.

**Gate status:** Gate 1 is GREEN. Gate 2 is AMBER. Gate 3 is the target — this work package moves gate 3 forward.

**Open PRs:** None listed in ops/STATE.md (last updated 2026-09-01). No open PR review work awaiting fixes.

**Standing directives:** ops/DIRECTIVES.md is empty — no standing human directives block this work.

**Existing infrastructure:**
- `workflows/review-swarm.yaml` exists and defines the three-lens review workflow (maintainability, history, structure)
- `.github/workflows/cloud-runtime-artifact.yml` exists but review-swarm.yml does NOT exist yet
- The local `~/AgentWorkforce/review-swarm-loop.sh` is the only enforcement of RFC-0001 §2 rule 7 currently

This work package creates the missing cloud infrastructure to enforce the review-swarm requirement in CI, not just on the chief's laptop.

## If blocked

If gate 3 is genuinely unreachable from the current state, write ops/NEEDS_HUMAN.md saying exactly why and still end with ASSESS_DONE. Do not silently substitute different work: a run that reports progress on the wrong gate is worse than one that reports it is blocked.
