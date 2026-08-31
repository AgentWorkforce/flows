# NEXT — work package for this tick

**Scope:** Track D: Cloud review-swarm redesign — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

This run is pinned to **gate 3** and must not work on any other gate.

## Objective

Build the cloud review-swarm infrastructure to enforce RFC-0001 §2 rule 7 ("every PR met by a review swarm — our own, not a vendor's"). The local `~/AgentWorkforce/review-swarm-loop.sh` currently provides this enforcement but lives on the chief's laptop. The cloud version must exist for gate 3+ work to be trustworthy.

Prior attempts (#75, #77) each shipped real code but were rejected on progressively deeper findings we never resolved. This package addresses ALL accumulated findings.

## Files in scope

- `.github/workflows/review-swarm.yml` — the GHA trigger, per requirements 1-8 below
- `.github/workflows/scripts/swarm-post.sh` — the sync + verdict + post script
- `.github/workflows/scripts/swarm-prepare.sh` — the launcher-side fetcher (per requirement 6)
- `workflows/review-swarm.yaml` — aggregate step refactored to share verdict logic (per requirement 2)
- `.gitignore` — drop the `.review-target` mask
- `README.md` — document `RELAY_WORKSPACE_KEY` secret + how to obtain

## Non-negotiable requirements (address the accumulated real findings)

Every one of these was a legitimate swarm rejection on a prior attempt. Address them or don't ship.

1. **Immutable gate** — `.github/workflows/review-swarm.yml` must checkout `main`'s copy of `workflows/review-swarm.yaml` + `.github/workflows/scripts/swarm-post.sh` SEPARATELY from the PR head. Use two `actions/checkout@v4` steps with different `path:` values. Launch the swarm using main's gate files, not the PR's. This is RFC-0001 settled decision #6.

2. **Unified verdict-extraction logic** — `workflows/review-swarm.yaml`'s aggregate step AND `.github/workflows/scripts/swarm-post.sh` currently duplicate verdict logic and can disagree. Refactor: aggregate logic lives in ONE place — either a shared bash helper file both source (`scripts/swarm-verdict.sh`) OR the yaml aggregate step becomes trivial and swarm-post.sh does all extraction. Rules that must apply uniformly:
   - Transcript selection sorts by FILENAME (`YYYYMMDD-HHMM` prefix), not mtime
   - Verdict is the LAST non-empty line's token, not a whole-file grep
   - `overall = ALL lenses PASSED, else FAILED` — fail-closed on MISSING/UNCLEAR/FAILED

3. **Auth secret validation fail-fast** — Add a preflight step that validates `RELAY_WORKSPACE_KEY` is set and non-empty BEFORE launching the cloud run. If missing, fail the job with a clear message ("secret not configured; see README §<X>"). Do NOT proceed to a 10-min interactive fallback.

4. **Sticky marker + sticky transcripts** — The marker comment uses a hidden HTML anchor and edits in place. So MUST the three lens transcript comments. A PR with 5 pushes should end with 1 marker + 3 transcripts (edited to latest), NOT 5 markers + 15 transcripts. Use `<!-- swarm-lens: <lens> -->` anchors, find-by-anchor before posting.

5. **Every PR gets reviewed** — NO author whitelist. If a rollout-scoped filter is needed later, document it as a temporary exception AND file the RFC amendment. Default: all PRs.

6. **Cloud sandbox has no `gh` auth — fetch on launching host** — GHA runner has `gh` auth. Cloud sandbox does not. The workflow must fetch PR diff + metadata on the GHA runner via `gh pr diff/view`, stage them into `.review-target/{pr-number,pr.diff,pr.json}`, `git add -f` (the `.gitignore` mask on `.review-target` must be dropped too).

7. **Job timeout > poll deadline > swarm timeoutMs** — documented invariant:
   - `workflows/review-swarm.yaml` `timeoutMs: 3600000` (60 min)
   - Wait step poll deadline: 3900s (65 min)
   - Job `timeout-minutes: 75` (65 + 10 min for install/checkout/post)
   - Add a comment where each value lives naming the ordering invariant.

8. **Wait step must record terminal status as output; post step runs on always()** — A rejecting swarm's transcripts + marker MUST reach the PR. Structure:
   ```
   wait step: records $swarm_status output, always exits 0
   post step: if: always() && steps.launch.outputs.run_id != ''
   fail step: if: steps.wait.outputs.swarm_status != 'completed'  # exit 1 gates merge
   ```

9. **Transcript-to-run-id binding** — require ALL THREE transcripts newly-produced in THIS sync; if any transcript's file mtime is older than the sync started, reject as stale.

## Definition of done

- All files parse:
  ```
  python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))"
  python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))"
  bash -n .github/workflows/scripts/swarm-post.sh
  bash -n .github/workflows/scripts/swarm-prepare.sh
  ```
- Aggregate verdict logic exists in ONE file, both callers use it
- Author whitelist absent (no `if: github.event.pull_request.user.login == ...`)
- Immutable gate: two checkout steps with different paths
- PR body explicitly documents each of the 9 requirements above and shows where each is satisfied
- SDK tests green:
  ```
  cd sdk && npm test
  ```
- As your LAST action:
  ```
  git status --porcelain
  ```

## Explicitly OUT of scope

- `sdk/` (Track A owns that)
- `kernel/` (gate 1 done, no changes)
- `ops/*` (chief owns briefs and state)
- Any GHA workflow other than review-swarm.yml
- Actually TESTING the workflow in CI (requires `RELAY_WORKSPACE_KEY` secret set which is a human step; the DoD is the workflow being correct, not proven live)

## Do not re-do these

Merged and closed; a PR redoing any will be closed:
- picker actionability (#42), unterminated backticks (#45)
- gate-1 race regression test (#48)
- ops/NEXT.md validation (#50)
- SDK agent worker (#53)
- SDK pretest hook (#69)

## If blocked

If gate 3 is genuinely unreachable from the current state, write ops/NEEDS_HUMAN.md saying exactly why and still end with ASSESS_DONE. Do not silently substitute different work: a run that reports progress on the wrong gate is worse than one that reports it is blocked.
