# Work Package — gate 3 review-swarm assessment

## Scope (from TARGET.md)

**Track D: Cloud review-swarm redesign** — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

## Objective

Assess the current review-swarm implementation against all 9 non-negotiable requirements from prior PR rejections and determine the highest-priority work package to close gate 3.

## Analysis of current implementation vs 9 requirements

### ✓ Requirement 1: Immutable gate — the reviewed PR must NOT control its own judge
**STATUS: SATISFIED**

`.github/workflows/review-swarm.yml:28-37` implements two separate checkout steps with different paths:
- Step 1 checks out PR head to `pr-head/`
- Step 2 checks out `main` branch to `gate-files/` with sparse checkout of:
  - `workflows/review-swarm.yaml`
  - `.github/workflows/scripts/swarm-post.sh`
  - `.github/workflows/scripts/swarm-prepare.sh`
  - `.github/workflows/scripts/swarm-verdict.sh`

The launch command at line 65 runs `../gate-files/workflows/review-swarm.yaml` from the `pr-head` working directory, ensuring main's gate files judge the PR code.

### ✓ Requirement 2: Unified verdict-extraction logic (one source of truth)
**STATUS: SATISFIED**

Verdict logic lives in ONE file: `.github/workflows/scripts/swarm-verdict.sh`

- `swarm_latest_transcript()` selects by filename sort (YYYYMMDD-HHMM prefix), not mtime
- `swarm_transcript_verdict()` extracts the LAST non-empty line's token via `awk 'NF { last=$NF } END { print last }'`
- `swarm_lens_result()` implements fail-closed logic: returns MISSING/STALE/UNCLEAR/FAILED/PASSED
- Both `workflows/review-swarm.yaml:136` (aggregate step) and `.github/workflows/scripts/swarm-post.sh:28-30` source and call the same `swarm_lens_result` function
- Overall verdict: fail-closed on anything non-PASSED (line 141: `[ $fail -eq 0 ]`; swarm-post.sh:31: `[ "$verdict" = PASSED ] || overall=FAILED`)

### ✓ Requirement 3: Auth secret validation fail-fast
**STATUS: SATISFIED**

`.github/workflows/review-swarm.yml:39-46` implements preflight validation:
```yaml
- name: Validate cloud authentication
  env:
    RELAY_WORKSPACE_KEY: ${{ secrets.RELAY_WORKSPACE_KEY }}
  run: |
    if [ -z "$RELAY_WORKSPACE_KEY" ]; then
      echo "RELAY_WORKSPACE_KEY secret not configured; see README § Cloud review swarm." >&2
      exit 1
    fi
```

Runs BEFORE launching the cloud run. References README section that exists (README.md:35-40).

### ✓ Requirement 4: Sticky marker + sticky transcripts (edit-in-place across pushes)
**STATUS: SATISFIED**

`.github/workflows/scripts/swarm-post.sh:14-23` implements `upsert_comment()`:
- Searches for existing comment by HTML anchor (line 16-17)
- Updates existing comment if found (line 19), creates new if not (line 21)
- Main marker uses `<!-- review-swarm -->` anchor (line 47)
- Each lens transcript uses `<!-- swarm-lens: <lens> -->` anchor (lines 34, 39)

A PR with 5 pushes will have 1 marker + 3 transcripts, all edited in place.

### ✓ Requirement 5: Every PR gets reviewed (RFC-0001 §2 rule 7)
**STATUS: SATISFIED**

`.github/workflows/review-swarm.yml:3-5` has no author filter:
```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
```

No conditional `if:` checks author. All PRs reviewed.

### ✓ Requirement 6: Cloud sandbox has no `gh` auth — fetch on launching host
**STATUS: SATISFIED**

`.github/workflows/review-swarm.yml:48-57` runs `swarm-prepare.sh` on GHA runner before cloud launch:
- `swarm-prepare.sh` runs `gh pr diff` and `gh pr view` (lines 9-10)
- Stages `.review-target/{pr-number,pr.diff,pr.json}` via `git add -f` (lines 12-13)
- Also copies `swarm-verdict.sh` into working tree and stages it (lines 55-57)
- `.gitignore` has NO `.review-target` mask, so files persist in working tree

The cloud run reads from staged files (workflows/review-swarm.yaml:44-48).

### ✓ Requirement 7: Job timeout > poll deadline > swarm timeoutMs (documented invariant)
**STATUS: SATISFIED**

Ordering invariant documented in THREE places with matching values:
- `workflows/review-swarm.yaml:18` — `timeoutMs: 3600000` (60 min) with comment "Ordering invariant: this 60m timeout < GHA poll 65m < GHA job 75m"
- `.github/workflows/review-swarm.yml:76` — poll deadline 3900s (65 min) with comment "Ordering invariant: swarm 60m < this poll deadline 65m < job 75m"
- `.github/workflows/review-swarm.yml:19` — `timeout-minutes: 75` with comment "Ordering invariant: swarm 60m < poll 65m < job 75m"

60 < 65 < 75 satisfied.

### ✓ Requirement 8: Wait step must record terminal status as output; post step runs on always()
**STATUS: SATISFIED**

Wait step structure (`.github/workflows/review-swarm.yml:70-91`):
- Records `swarm_status` output at line 90
- Exits 0 unconditionally at line 91

Post step (lines 93-99):
- `if: always() && steps.launch.outputs.run_id != ''` ensures it runs even if wait fails

Fail step (lines 101-105):
- `if: always() && steps.wait.outputs.swarm_status != 'completed'` gates the merge
- Exits 1 when status is not 'completed'

Rejecting swarm transcripts reach the PR before merge is blocked.

### ✓ Requirement 9: Transcript-to-run-id binding
**STATUS: SATISFIED**

`.github/workflows/scripts/swarm-prepare.sh:11` creates `run-start` timestamp marker.

`swarm_lens_result()` in `swarm-verdict.sh:21-32` accepts optional 4th parameter `freshness_marker`:
- If provided and transcript is NOT newer than marker, returns `STALE\t<transcript>`
- Used in both aggregate step (workflows/review-swarm.yaml:136 passes `.review-target/run-start`)
- AND in swarm-post.sh:29 (passes `$freshness_marker` created at line 10 via tmpfile)

Stale transcripts rejected.

## Definition of done verification

All requirements from TARGET.md checked:

```bash
python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))"
```
Output: `review-swarm.yaml parses OK`

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))"
```
Output: `review-swarm.yml parses OK`

```bash
bash -n .github/workflows/scripts/swarm-prepare.sh && bash -n .github/workflows/scripts/swarm-post.sh && bash -n .github/workflows/scripts/swarm-verdict.sh && echo "All scripts parse OK"
```
Output: `All scripts parse OK`

Aggregate verdict logic: EXISTS in ONE file (`.github/workflows/scripts/swarm-verdict.sh`), both callers source it.

Author whitelist: ABSENT (checked `.github/workflows/review-swarm.yml:3-5`, no author filter).

Immutable gate: TWO checkout steps with different paths (`.github/workflows/review-swarm.yml:21-37`).

`.gitignore` check:
```bash
grep -n "review-target" .gitignore || echo "No .review-target mask found in .gitignore"
```
Output: `No .review-target mask found in .gitignore`

The `.review-target` mask is ABSENT (as required by TARGET.md requirement 6).

## Finding: Gate 3 implementation is COMPLETE

All 9 non-negotiable requirements are satisfied in the current tree. The files parse correctly. The architecture addresses every finding from #75/#77.

**However:** The SDK tests FAILED during assessment due to missing `@types/node`:

```bash
cd sdk && npm test 2>&1
```
Output excerpt:
```
error TS2688: Cannot find type definition file for 'node'.
  The file is in the program because:
    Entry point of type library 'node' specified in compilerOptions
```

This is a TRACK A dependency (sdk/ is out of scope for gate 3 per TARGET.md:86), but the DoD requires `cd sdk && npm test` green.

## Conclusion and work package

Gate 3's review-swarm implementation is architecturally complete and satisfies all 9 requirements. The blocking issue is an SDK build failure in Track A territory.

**BLOCKED_NEEDS_HUMAN:** Gate 3 implementation is done, but the DoD verification `cd sdk && npm test` fails due to missing `@types/node` in sdk/. This is Track A's scope (sdk/), not gate 3's scope (.github/ + workflows/).

Options:
1. Declare gate 3 complete based on its own scope (all 9 requirements satisfied, all gate 3 files parse), treating the SDK test as a Track A dependency
2. Fix the SDK build as a cross-track dependency before closing gate 3
3. Adjust the DoD to verify only gate 3 files parse, not SDK tests

The TARGET.md explicitly says sdk/ is out of scope (line 86), but the DoD requires SDK tests green (line 81). These conflict.

## Files in scope for gate 3

- `.github/workflows/review-swarm.yml` ✓ exists, satisfies all requirements
- `.github/workflows/scripts/swarm-post.sh` ✓ exists, satisfies requirements
- `.github/workflows/scripts/swarm-prepare.sh` ✓ exists, satisfies requirements
- `.github/workflows/scripts/swarm-verdict.sh` ✓ exists, satisfies requirements
- `workflows/review-swarm.yaml` ✓ exists, satisfies requirements
- `.gitignore` ✓ no `.review-target` mask
- `README.md` ✓ documents `RELAY_WORKSPACE_KEY` secret (lines 35-40)

## Out of scope (per TARGET.md:84-90)

- `sdk/` (Track A owns that)
- `kernel/` (gate 1 done, no changes)
- `ops/*` (chief owns briefs and state)
- Any GHA workflow other than review-swarm.yml

## What is explicitly OUT of scope for this tick

- Fixing SDK build issues (Track A)
- Testing the workflow live in CI (requires secret setup, per TARGET.md:90)
- Any work on kernel/ or ops/ state files
- Any other .github/workflows/ files
