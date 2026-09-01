# NEXT — work package for this tick

**Scope (from ops/TARGET.md):** **Track D: Cloud review-swarm redesign** — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

This run is pinned to **gate 3** and must not work on any other gate.

## Objective

Build the cloud-executable GitHub Actions review swarm workflow that enforces RFC-0001 §2 rule 7 ("every PR met by a review swarm — our own, not a vendor's"). The local `~/AgentWorkforce/review-swarm-loop.sh` (chief-owned shell) is currently the only enforcement. It works, but lives on the operator's laptop. When that session ends, so does swarm enforcement. The cloud version must exist for gate 3+ work to be trustworthy.

Prior attempts (#75, #77) each shipped real code but were rejected on progressively deeper findings that were never resolved.

## Files in scope

- `.github/workflows/review-swarm.yml` — GHA trigger (create new directory and file)
- `.github/workflows/scripts/swarm-prepare.sh` — launcher-side PR fetcher (create new)
- `.github/workflows/scripts/swarm-post.sh` — sync + verdict + post script (create new)
- `.github/workflows/scripts/swarm-verdict.sh` — shared verdict logic (create new)
- `workflows/review-swarm.yaml` — aggregate step refactored to use shared verdict logic
- `.gitignore` — drop the `.review-target` mask (currently line 10)
- `README.md` — document `RELAY_WORKSPACE_KEY` secret setup

## Requirements (all 9 non-negotiable, from TARGET.md)

### 1. Immutable gate — the reviewed PR must NOT control its own judge
`.github/workflows/review-swarm.yml` must checkout `main`'s copy of `workflows/review-swarm.yaml` + `.github/workflows/scripts/swarm-post.sh` SEPARATELY from the PR head. Use two `actions/checkout@v4` steps with different `path:` values. Launch the swarm using main's gate files, not the PR's. This is RFC-0001 settled decision #6.

### 2. Unified verdict-extraction logic (one source of truth)
`workflows/review-swarm.yaml`'s aggregate step AND `.github/workflows/scripts/swarm-post.sh` currently duplicate verdict logic and can disagree. Refactor: aggregate logic lives in ONE place — either a shared bash helper file both source (`scripts/swarm-verdict.sh`) OR the yaml aggregate step becomes trivial and swarm-post.sh does all extraction. Rules that must apply uniformly:
  - Transcript selection sorts by FILENAME (`YYYYMMDD-HHMM` prefix), not mtime (`b2535aa` fixed this once)
  - Verdict is the LAST non-empty line's token, not a whole-file grep (`f59d9cd` fixed this once)
  - `overall = ALL lenses PASSED, else FAILED` — fail-closed on MISSING/UNCLEAR/FAILED

### 3. Auth secret validation fail-fast
Add a preflight step that validates `RELAY_WORKSPACE_KEY` is set and non-empty BEFORE launching the cloud run. If missing, fail the job with a clear message ("secret not configured; see README §<X>"). Do NOT proceed to a 10-min interactive fallback (per RFC covenant 2 real event: `Device login expired before it was approved` was seen on run 33364011379).

### 4. Sticky marker + sticky transcripts (edit-in-place across pushes)
The marker comment uses a hidden HTML anchor and edits in place. So MUST the three lens transcript comments. A PR with 5 pushes should end with 1 marker + 3 transcripts (edited to latest), NOT 5 markers + 15 transcripts. Use `<!-- swarm-lens: <lens> -->` anchors, find-by-anchor before posting.

### 5. Every PR gets reviewed (RFC-0001 §2 rule 7)
NO author whitelist. If a rollout-scoped filter is needed later, document it as a temporary exception AND file the RFC amendment. Default: all PRs.

### 6. Cloud sandbox has no `gh` auth — fetch on launching host
GHA runner has `gh` auth. Cloud sandbox does not. The workflow must fetch PR diff + metadata on the GHA runner via `gh pr diff/view`, stage them into `.review-target/{pr-number,pr.diff,pr.json}`, `git add -f` (the `.gitignore` mask on `.review-target` must be dropped too — it silently drops the file from `git ls-files` per PR #77's audit). Then `agent-relay cloud run` uploads the working tree.

### 7. Job timeout > poll deadline > swarm timeoutMs (documented invariant)
- `workflows/review-swarm.yaml` `timeoutMs: 3600000` (60 min)
- Wait step poll deadline: 3900s (65 min)
- Job `timeout-minutes: 75` (65 + 10 min for install/checkout/post)
Add a comment where each value lives naming the ordering invariant.

### 8. Wait step must record terminal status as output; post step runs on always()
A rejecting swarm's transcripts + marker MUST reach the PR. Structure:
```
wait step: records $swarm_status output, always exits 0
post step: if: always() && steps.launch.outputs.run_id != ''
fail step: if: steps.wait.outputs.swarm_status != 'completed'  # exit 1 gates merge
```

### 9. Transcript-to-run-id binding
Sub-guard: aggregate rejects a transcript that doesn't belong to this run (no way to prove without instrumenting review-swarm.yaml to write run-id into transcripts). For now: require ALL THREE transcripts newly-produced in THIS sync; if any transcript's file mtime is older than the sync started, reject as stale.

## Definition of done

ALL of the following must hold:

1. All files parse:
   - `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))"`
   - `python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))"`
   - `bash -n .github/workflows/scripts/swarm-prepare.sh`
   - `bash -n .github/workflows/scripts/swarm-post.sh`
   - `bash -n .github/workflows/scripts/swarm-verdict.sh`
2. Aggregate verdict logic exists in ONE file, both callers use it
3. Author whitelist absent (no `if: github.event.pull_request.user.login == ...`)
4. Immutable gate: two checkout steps with different paths
5. PR body explicitly documents each of the 9 requirements above and shows where each is satisfied
6. `cd kernel && sh ../ops/cargo.sh test --workspace` green (should be unaffected)
7. As your LAST action, `git status --porcelain`

## Out of scope

- `sdk/` (Track A owns that)
- `kernel/` (gate 1 done, no changes)
- `ops/*` (chief owns briefs and state)
- Any GHA workflow other than review-swarm.yml
- Actually TESTING the workflow in CI (requires `RELAY_WORKSPACE_KEY` secret set which is a human step; the DoD is the workflow being correct, not proven live)
- Merged and closed PRs (#42, #45, #48, #50, #53, #69) — do not redo

## Status

Gate 3 is reachable. No blockers identified. No open PRs requiring fixes. No unsatisfied directives.
