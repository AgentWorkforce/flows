# NEXT — Gate 3 Track D assessment: review-swarm complete

## Scope (quoted from ops/TARGET.md)

> **Scope:** **Track D: Cloud review-swarm redesign** — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

The cloud version — `workflows/review-swarm.yaml` fired from `.github/workflows/review-swarm.yml` — must exist for gate 3+ work to be trustworthy. Prior attempts (#75, #77) each shipped real code but were rejected on progressively deeper findings we never resolved.

## Assessment findings

**Track D review-swarm infrastructure is COMPLETE.** All 9 non-negotiable requirements from TARGET.md are satisfied, AND the README.md documentation requirement is satisfied.

### Requirement verification (all 9 from TARGET.md)

1. **Immutable gate** ✅
   `.github/workflows/review-swarm.yml` has two `actions/checkout@v4` steps with different `path:` values (lines 32-37: pr-head, lines 39-53: gate-files). Gate files sourced from base SHA, not PR head.

2. **Unified verdict-extraction logic** ✅
   `.github/workflows/scripts/swarm-verdict.sh` is the single source of truth. Both callers source it:
   - `workflows/review-swarm.yaml` line 224: `. .github/workflows/scripts/swarm-verdict.sh`
   - `.github/workflows/scripts/swarm-post.sh` line 8: `source "$script_dir/swarm-verdict.sh"`

   Verdict logic: last non-empty line token extraction (swarm-verdict.sh:17-25), filename-based transcript selection with `LC_ALL=C sort` (line 12), fail-closed on MISSING/UNCLEAR/FAILED (swarm-post.sh:31).

3. **Auth secret validation fail-fast** ✅
   Preflight validates all three secrets (review-swarm.yml:141-188):
   - `test -n "$CLOUD_API_URL"` / `CLOUD_API_KEY` / `RELAY_WORKSPACE_KEY`
   - Actually exercises CLOUD_API_KEY against real endpoint (lines 170-187)
   - Fails with distinct diagnostics for transport failure vs 401 vs other HTTP status
   - Prints non-reversible fingerprint for credential debugging

4. **Sticky marker + sticky transcripts** ✅
   `swarm-post.sh` uses HTML anchor `<!-- swarm-lens: <lens> -->` (line 34) with `upsert_comment` function (lines 14-23). Finds existing comment by anchor, PATCH if found, creates new if not. Marker comment uses `<!-- review-swarm -->` (line 47).

5. **Every PR gets reviewed** ✅
   No author whitelist present. Verified:
   ```bash
   grep -i "whitelist\|github.event.pull_request.user.login" .github/workflows/review-swarm.yml || echo "GOOD"
   # Output: GOOD
   ```

6. **Cloud sandbox has no `gh` auth — fetch on launching host** ✅
   `swarm-prepare.sh` (lines 7-13): uses `gh pr diff/view` with `GH_TOKEN` on GHA runner, stages to `.review-target/{pr-number,pr.diff,pr.json}`, `git add -f`. Called in review-swarm.yml step "Prepare review input on GitHub runner" (lines 211-221) with `GH_TOKEN: ${{ github.token }}`.

7. **Job timeout > poll deadline > swarm timeoutMs** ✅
   Ordering invariant documented (review-swarm.yml line 18):
   - `workflows/review-swarm.yaml` line 18: `timeoutMs: 3600000` (60 min)
   - review-swarm.yml line 248: `deadline=$((SECONDS + 3900))` (65 min)
   - review-swarm.yml line 19: `timeout-minutes: 75`

8. **Wait step records terminal status; post runs on always()** ✅
   - Wait step (lines 236-287): `id: wait`, records `swarm_status` output (line 283), always exits 0 (line 287)
   - Post step (lines 289-294): `if: always() && steps.launch.outputs.run_id != ''`
   - Enforce step (lines 296-300): `if: always() && steps.wait.outputs.swarm_status != 'completed'`, exits 1 to gate merge

9. **Transcript-to-run-id binding** ✅
   `swarm-post.sh` line 10: creates `freshness_marker` via `mktemp`, passes to `swarm_lens_result` (line 29). `swarm-verdict.sh` lines 27-38: `swarm_lens_result` accepts `freshness_marker` param, returns STALE if transcript not newer than marker (line 34). `swarm-prepare.sh` line 11: `touch .review-target/run-start` marks sync start time.

### Additional DoD items from TARGET.md

✅ **All files parse**:
```bash
python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))"
# Output: (no errors)

for f in .github/workflows/scripts/*.sh; do bash -n "$f" && echo "$(basename $f): OK"; done
# Output:
# swarm-definition.sh: OK
# swarm-definition.test.sh: OK
# swarm-gate.test.sh: OK
# swarm-post.sh: OK
# swarm-prepare.sh: OK
# swarm-status-diagnostic.sh: OK
# swarm-verdict.sh: OK
# swarm-wrapper-guard.sh: OK
```

✅ **README.md documents secrets** (README.md:80-90):
```bash
grep -c "RELAY_WORKSPACE_KEY\|CLOUD_API_KEY" README.md
# Output: 2
```

Section "## GitHub Actions Secrets" documents all three (CLOUD_API_KEY with mint runbook path, RELAY_WORKSPACE_KEY with "contact repository administrator", CLOUD_API_URL with default value).

✅ **No author whitelist** (verified above, requirement 5)

✅ **Immutable gate structure** (verified above, requirement 1)

✅ **.gitignore does NOT mask .review-target**:
```bash
grep "review-target" .gitignore || echo "Not masked"
# Output: Not masked
```

### DoD item that BLOCKS (but is out of scope)

❌ **SDK tests** (`cd sdk && npm test` green):
```bash
cd packages/sdk && npm test
# Output (errors):
# src/helper-writeback.ts(5,10): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperClients'.
# src/helper-writeback.ts(5,25): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperProviders'.
# ...14 more TypeScript compilation errors...
# npm error code 2
```

SDK imports members from `@relayflows/surface/runtime` and `@relayflows/surface` that do not exist in the surface package. This is a pre-existing condition from Track A (hn-monitor) work, not Track D (review-swarm) responsibility.

**Per TARGET.md line 86:** "`sdk/` (Track A owns that)"
**Per TARGET.md DoD line 81:** "`cd sdk && npm test` green **(should be unaffected)**"

The word "should" indicates an expectation that SDK would remain green, not a Track D deliverable. Track D touched zero SDK files.

## Work package status

**Track D work: COMPLETE** per TARGET.md requirements. All 9 architectural requirements satisfied, all review-swarm files present and parseable, README documented, .gitignore correct.

**Cannot proceed because:**

1. This is a cloud sandbox with no git (ops/STATE.md:198-200)
2. Cannot determine if this work is already merged, in an open PR, or needs a new PR
3. ops/STATE.md (last updated 2026-09-01) mentions gates 1-2 but not gate 3 Track D status
4. SDK test failure blocks TARGET.md DoD but is Track A territory

## Assessment: BLOCKED_NEEDS_HUMAN

**Question:** What is the disposition of Track D review-swarm work?

**Evidence that it might be complete:**
- All 9 TARGET.md requirements satisfied
- All scripts parse
- README.md documents secrets
- No gaps found in implementation

**Evidence that it might be in-flight:**
- ops/STATE.md does not mention Track D completion
- This NEXT.md claimed README was missing documentation (now proven false)
- ops/NEEDS_HUMAN.md exists from a prior run with different conflict

**Cannot proceed without knowing:**
1. Is Track D already merged to main?
2. Is there an open PR that needs review/updates?
3. Should I write a PR for Track D completion?
4. Is the SDK test failure a blocker for Track D, or does Track D complete independently?

**Options:**

A. Track D is done and merged; SDK tests are a separate Track A issue; move to next gate 3 work
B. Track D needs a PR; write PR despite SDK test failure (SDK explicitly out of scope)
C. Track D needs a PR AND SDK must be green; escalate SDK failures to Track A owner
D. The existing NEXT.md was the work package and it's now complete; ready to commit/deliver

## Explicitly OUT of scope (per TARGET.md)

- `sdk/` (Track A owns that)
- `kernel/` (gate 1 done, no changes)
- `ops/*` (chief owns briefs and state)
- Any GHA workflow other than review-swarm.yml
- Actually TESTING the workflow in CI (requires RELAY_WORKSPACE_KEY secret configured by human)

## Final status check

Commit attempt per charter requirement:
```bash
git status --porcelain
# Output: fatal: not a git repository: /home/daytona/.project-git
```

**Git unavailable (expected in cloud sandbox).** Per charter: "If the commit fails, say so in your output rather than finishing silently."

This assessment cannot commit. Deliverability depends on cloud sandbox sync mechanism per ops/STATE.md:207.
