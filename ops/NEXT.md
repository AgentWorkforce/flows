# NEXT — work package for this tick

**Scope (gate 3, Track D):** Build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

## Objective

Build the GitHub Actions integration for the review swarm system that enforces RFC-0001 §2 rule 7 ("every PR met by a review swarm — our own, not a vendor's"). The local `~/AgentWorkforce/review-swarm-loop.sh` works but lives on a laptop. The cloud version must exist for gate 3+ work to be trustworthy.

## Current state

**What exists:**
- `workflows/review-swarm.yaml` — the cloud workflow spec defining three lenses (maintainability, history, structure)
- No `.github/` directory at all — verified
- No GHA trigger workflow
- No scripts to prepare PR context or post results

**Test status verified:**

Kernel tests: 77 passed, 0 failed
```
$ cd kernel && sh ../ops/cargo.sh test --workspace 2>&1 | grep "test result:"
test result: ok. 19 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.82s
test result: ok. 19 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.30s
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
test result: ok. 26 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
```

SDK tests: 203 passed, 0 failed
```
$ cd sdk && npm test 2>&1 | tail -5
 Test Files  15 passed (15)
      Tests  203 passed (203)
   Start at  22:14:22
   Duration  43.93s
```

## Files in scope

CREATE (all new):
- `.github/workflows/review-swarm.yml` — GHA trigger with immutable gate per requirement 1
- `.github/workflows/scripts/swarm-prepare.sh` — fetch PR diff/metadata on GHA runner per requirement 6
- `.github/workflows/scripts/swarm-post.sh` — sync transcripts, extract verdict, post comments per requirement 4
- `.github/workflows/scripts/swarm-verdict.sh` — unified verdict extraction logic per requirement 2

MODIFY:
- `.gitignore` — drop the `.review-target` mask per requirement 6
- `README.md` — document `RELAY_WORKSPACE_KEY` secret + how to obtain
- `workflows/review-swarm.yaml` — refactor aggregate step to use shared verdict logic per requirement 2

## Nine non-negotiable requirements from walked-away #75/#77

Every one was a legitimate swarm rejection on a prior attempt.

### 1. Immutable gate
`.github/workflows/review-swarm.yml` must checkout `main`'s copy of `workflows/review-swarm.yaml` + scripts SEPARATELY from PR head. Two `actions/checkout@v4` steps with different `path:` values. RFC-0001 settled decision 6.

### 2. Unified verdict-extraction logic
One source of truth for verdict logic. Shared bash helper `.github/workflows/scripts/swarm-verdict.sh` that both aggregate step and swarm-post.sh source. Rules:
- Transcript selection sorts by FILENAME (`YYYYMMDD-HHMM` prefix), not mtime
- Verdict is LAST non-empty line's token, not whole-file grep
- `overall = ALL lenses PASSED, else FAILED` (fail-closed on MISSING/UNCLEAR/FAILED)

### 3. Auth secret validation fail-fast
Preflight validates `RELAY_WORKSPACE_KEY` is set and non-empty BEFORE cloud run. Clear failure message if missing. No 10-min interactive fallback.

### 4. Sticky marker + sticky transcripts
Marker comment edits in place via hidden HTML anchor. THREE lens transcript comments MUST also edit in place using `<!-- swarm-lens: <lens> -->` anchors. 5 pushes = 1 marker + 3 transcripts, NOT 5 markers + 15 transcripts.

### 5. Every PR gets reviewed
NO author whitelist. If rollout-scoped filter needed later, document as temporary exception AND file RFC amendment. Default: all PRs.

### 6. Cloud sandbox has no gh auth
GHA runner has `gh` auth, cloud sandbox does not. Workflow fetches PR diff + metadata on GHA runner via `gh pr diff/view`, stages into `.review-target/{pr-number,pr.diff,pr.json}`, `git add -f` (drop `.gitignore` mask on `.review-target`). Then `agent-relay cloud run` uploads tree.

### 7. Job timeout > poll deadline > swarm timeoutMs
Documented invariant:
- `workflows/review-swarm.yaml` `timeoutMs: 3600000` (60 min)
- Wait step poll deadline: 3900s (65 min)
- Job `timeout-minutes: 75` (65 + 10 for install/checkout/post)
Comment at each location naming the ordering.

### 8. Wait step records terminal status; post step runs on always()
Rejecting swarm's transcripts MUST reach the PR. Structure:
```
wait step: records $swarm_status output, always exits 0
post step: if: always() && steps.launch.outputs.run_id != ''
fail step: if: steps.wait.outputs.swarm_status != 'completed'
```

### 9. Transcript-to-run-id binding
Sub-guard: aggregate rejects transcript not belonging to this run. Require ALL THREE transcripts newly-produced in THIS sync; if any mtime older than sync start, reject as stale.

## Definition of done

1. All shell scripts parse: `bash -n .github/workflows/scripts/*.sh` exits 0
2. YAML parses: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))"` succeeds
3. `workflows/review-swarm.yaml` parses: `python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))"` succeeds
4. Aggregate verdict logic exists in ONE file (swarm-verdict.sh), both aggregate step and swarm-post.sh source it
5. Immutable gate verified: two `actions/checkout@v4` steps with different `path:` values in review-swarm.yml
6. No author whitelist: `grep -q "github.event.pull_request.user.login" .github/workflows/review-swarm.yml` exits non-zero
7. Preflight auth check exists: `grep -q "RELAY_WORKSPACE_KEY" .github/workflows/review-swarm.yml` exits 0
8. Sticky markers + transcripts: `grep -q "swarm-lens:" .github/workflows/scripts/swarm-post.sh` exits 0
9. Timeout ordering documented: comments exist at all three timeout locations
10. Wait step records terminal status: `grep -q "swarm_status" .github/workflows/review-swarm.yml` exits 0
11. `cd sdk && npm test` still green (gates 1-2 must not regress) — run and paste output tail
12. `git status --porcelain` shows all new/modified files staged

## Explicitly OUT of scope

- `sdk/` modifications (Track A owns that)
- `kernel/` changes (gate 1 done, no changes)
- `ops/*` files except this NEXT.md (chief owns briefs and state)
- Any GHA workflow other than review-swarm.yml
- Actually testing the workflow in CI (requires `RELAY_WORKSPACE_KEY` secret set, which is a human step)
- The local `~/AgentWorkforce/review-swarm-loop.sh` (owned by chief, not repo)

## Do not redo these (merged and closed)

A PR redoing any will be closed:
- picker actionability (#42), unterminated backticks (#45)
- gate-1 race regression test (#48) — do not touch `kernel/relayflowd/src/server/tests.rs`
- ops/NEXT.md validation (#50) — do not touch `sdk/src/work-package-validator.ts`
- SDK agent worker (#53) — `sdk/src/worker.ts` shipped; leave it alone
- SDK pretest hook (#69) — `sdk/package.json` builds kernel before test
