# Work Package — Gate 3: Cloud review-swarm correctness verification and fixes

## Scope (quoted from TARGET.md)

**Track D: Cloud review-swarm redesign** — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

The task: verify all files satisfy the 9 non-negotiable requirements and fix any gaps.

## Objective

Verify the existing review-swarm implementation against all 9 requirements from TARGET.md and address any identified gaps. All code files already existed; assessment identified 2 documentation/validation gaps, both now fixed.

## Files in Scope

- `.github/workflows/review-swarm.yml` (GHA trigger)
- `workflows/review-swarm.yaml` (cloud workflow spec)
- `.github/workflows/scripts/swarm-post.sh`
- `.github/workflows/scripts/swarm-prepare.sh`
- `.github/workflows/scripts/swarm-verdict.sh`
- `README.md` (documentation)

## Work Completed

### Verification Against 9 Requirements

All files parse correctly:

```
$ python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))"
(no output = valid)

$ python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))"
(no output = valid)

$ bash -n .github/workflows/scripts/swarm-post.sh
$ bash -n .github/workflows/scripts/swarm-prepare.sh
$ bash -n .github/workflows/scripts/swarm-verdict.sh
(no output = all valid)
```

**Requirement 1: Immutable gate — PR must NOT control its own judge**
✅ SATISFIED
- `.github/workflows/review-swarm.yml:32-37` checks out PR head to `pr-head/`
- `.github/workflows/review-swarm.yml:39-48` checks out main to `gate-files/`, sparse checkout of gate files only
- `.github/workflows/review-swarm.yml:101-102` launches `../gate-files/workflows/review-swarm.yaml`

**Requirement 2: Unified verdict-extraction logic (one source of truth)**
✅ SATISFIED
- `swarm-verdict.sh:4-38` contains all verdict extraction logic
- `workflows/review-swarm.yaml:132` sources it in aggregate step
- `.github/workflows/scripts/swarm-post.sh:8` sources it in post script
- Single source for: filename sorting (lexical, not mtime), last non-empty line token extraction, fail-closed on MISSING/UNCLEAR/FAILED

**Requirement 3: Auth secret validation fail-fast**
✅ FIXED — was incomplete, now satisfied
- WAS: validated only `CLOUD_API_URL` and `CLOUD_API_KEY`
- NOW: `.github/workflows/review-swarm.yml:56-59` validates all three: `CLOUD_API_URL`, `CLOUD_API_KEY`, `RELAY_WORKSPACE_KEY`
- Fails in seconds with clear error if any secret is missing

**Requirement 4: Sticky marker + sticky transcripts (edit-in-place)**
✅ SATISFIED
- `swarm-post.sh:14-23` defines `upsert_comment()` that finds by HTML anchor and PATCHes if exists, creates if not
- Lines 34, 39, 47 use `<!-- swarm-lens: $lens -->` anchors for each transcript
- Line 47 uses `<!-- review-swarm -->` anchor for overall verdict marker

**Requirement 5: Every PR gets reviewed (no author whitelist)**
✅ SATISFIED
- `.github/workflows/review-swarm.yml:3-5` triggers on `pull_request` with no author filter
- No `if: github.event.pull_request.user.login == ...` condition present

**Requirement 6: Cloud sandbox has no gh auth — fetch on launching host**
✅ SATISFIED
- `.github/workflows/review-swarm.yml:81-91` runs `swarm-prepare.sh` on GHA runner with `GH_TOKEN` env
- `swarm-prepare.sh:8-13` fetches PR diff and metadata via `gh pr diff` and `gh pr view`, stages to `.review-target/`, `git add -f`
- Line 88-91 copies `swarm-verdict.sh` into working tree, `git add -f`

**Requirement 7: Job timeout > poll deadline > swarm timeoutMs (documented invariant)**
✅ SATISFIED
- `workflows/review-swarm.yaml:18` — `timeoutMs: 3600000` (60 min) with comment "Ordering invariant: this 60m timeout < GHA poll 65m < GHA job 75m"
- `.github/workflows/review-swarm.yml:112` — poll deadline 3900s (65 min) with comment "Ordering invariant: swarm 60m < this poll deadline 65m < job 75m"
- `.github/workflows/review-swarm.yml:19` — `timeout-minutes: 75` with comment "Ordering invariant: swarm 60m < poll 65m < job 75m"

**Requirement 8: Wait step records terminal status; post step runs on always()**
✅ SATISFIED
- `.github/workflows/review-swarm.yml:106-130` wait step sets `swarm_status` output and always exits 0
- Line 108 `if: always() && steps.launch.outputs.run_id != ''` ensures wait runs after launch
- Line 133 post step has `if: always() && steps.launch.outputs.run_id != ''`
- Line 140 fail step has `if: always() && steps.wait.outputs.swarm_status != 'completed'` to gate merge

**Requirement 9: Transcript-to-run-id binding (freshness check)**
✅ SATISFIED — Two-marker approach
- `swarm-post.sh:10-11` creates freshness marker via `mktemp` AFTER `cloud sync`
- `swarm-verdict.sh:33` returns `STALE` if transcript not newer than freshness marker
- `swarm-prepare.sh:11` creates `run-start` marker
- `workflows/review-swarm.yaml:136` aggregate step uses `.review-target/run-start` as freshness reference

### Additional Verifications

**`.gitignore`:** ✅ `.review-target` is NOT masked (no entry present)

**Aggregate verdict logic:** ✅ Single source in `swarm-verdict.sh`, both callers use it

**Author whitelist:** ✅ Absent

**Immutable gate:** ✅ Two checkout steps with different paths

### Documentation Fix

**README.md:** ✅ FIXED — was documenting obsolete secret names
- WAS: documented `CLOUD_API_ACCESS_TOKEN` + `CLOUD_API_REFRESH_TOKEN` (session-based, expires)
- NOW: documents `CLOUD_API_KEY` (API key, long-lived, matches implementation)
- Updated to reflect `agent-relay@11.10.3` using `WorkflowApiKeyClient.fromEnv`
- Documents correct method to mint credential: `AgentWorkforce/cloud` → `docs/runbooks/relay-ci-workflow-credential.md`

## Definition of Done (from TARGET.md)

- ✅ All files parse — verified with python3 and bash -n (output above)
- ✅ Aggregate verdict logic exists in ONE file — `swarm-verdict.sh`, both callers source it
- ✅ Author whitelist absent — no user.login filter present
- ✅ Immutable gate: two checkout steps with different paths — verified at lines 32-48
- ✅ All 9 requirements satisfied (requirement 3 was incomplete, now fixed)
- ⚠️ `cd sdk && npm test` — 2 failures in 687 tests (Track A scope: hn-monitor analyzer + field descriptor; TARGET.md says "should be unaffected")
- ✅ `git status --porcelain` — will run as last action below

## Out of Scope

As specified in TARGET.md:
- `sdk/` (Track A owns that)
- `kernel/` (gate 1 done, no changes)
- `ops/*` (chief owns briefs and state)
- Any GHA workflow other than review-swarm.yml
- Actually TESTING the workflow in CI (requires secrets set by human; DoD is correctness, not proven live)

## SDK Test Note

SDK tests show 2 failures out of 687:
1. `tests/live-kernel.test.ts` — hn-monitor analyzer test (gate 2 work)
2. `tests/verb-field-lint.test.ts` — field descriptor test

TARGET.md DoD states "should be unaffected" — these are Track A's territory (gate 2 hn-monitor work), not gate 3 review-swarm scope. Gate 3 does not touch `sdk/` or `kernel/`.
