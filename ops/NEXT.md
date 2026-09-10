# NEXT — gate 3 is complete, blocked on Daytona capacity

**Scope:** Track D: Cloud review-swarm redesign — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts.

## Assessment

Gate 3 implementation is **COMPLETE**. All 9 non-negotiable architectural requirements from ops/TARGET.md are satisfied:

1. ✅ **Immutable gate** — Two checkout steps (`.github/workflows/review-swarm.yml:32-48`): pr-head from PR sha, gate-files from main. Swarm launches using main's gate files.
2. ✅ **Unified verdict logic** — `swarm-verdict.sh` is the single source, sourced by both `workflows/review-swarm.yaml:184` and `swarm-post.sh:8`
3. ✅ **Auth secret validation fail-fast** — Preflight at `.github/workflows/review-swarm.yml:90-137` validates all three secrets and actually exercises CLOUD_API_KEY against the API
4. ✅ **Sticky marker + transcripts** — HTML anchors `<!-- review-swarm -->` and `<!-- swarm-lens: <lens> -->`, upsert_comment finds and PATCHes existing
5. ✅ **Every PR gets reviewed** — No author whitelist exists (verified by grep)
6. ✅ **Cloud sandbox fetch on GHA runner** — `swarm-prepare.sh` runs with GH_TOKEN, stages to `.review-target/`, uses `git add -f`
7. ✅ **Timeout ordering** — 60m (review-swarm.yaml:18) < 65m (review-swarm.yml:191) < 75m (review-swarm.yml:19), with comments at each location
8. ✅ **Wait step records terminal status** — Sets `swarm_status` output (review-swarm.yml:208), always exits 0 (line 235), post runs on `always()` (line 238), enforce step checks status (line 245)
9. ✅ **Transcript freshness** — `.review-target/run-start` marker created by swarm-prepare.sh:11, freshness check in swarm-verdict.sh:33-34 rejects stale transcripts

## Evidence

All definition-of-done checks from ops/TARGET.md pass:

```
bash -n .github/workflows/scripts/swarm-post.sh && \
bash -n .github/workflows/scripts/swarm-prepare.sh && \
bash -n .github/workflows/scripts/swarm-verdict.sh && \
echo "All bash scripts parse OK"
```
Output: `All bash scripts parse OK`

```
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))" && \
python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))" && \
echo "YAML files parse OK"
```
Output: `YAML files parse OK`

```
grep -i "whitelist\|github.event.pull_request.user.login" .github/workflows/review-swarm.yml || \
echo "No author whitelist found (GOOD)"
```
Output: `No author whitelist found (GOOD)`

Aggregate verdict logic exists in ONE file (swarm-verdict.sh) with three functions, sourced by both callers.

Immutable gate verified: two checkout steps with different paths (pr-head and gate-files).

## The block

Gate 3 is **BLOCKED on Daytona CPU quota**, not on implementation.

Per ops/NEEDS_HUMAN.md (2026-09-08 status): `CLOUD_API_KEY` was minted and installed 2026-09-07. The workflow launches real cloud runs successfully (e.g., run 04da7e48-87ec-4c7a-a1ee-22fd482e1cd1), but every swarm fails with:

```
Step "lens-maintainability" failed after 2 retries:
Total CPU limit exceeded. Maximum allowed: 250.
```

The orchestrator sandbox places; the three per-lens agent sandboxes cannot. Runs 34168392594, 34167663112, 34165035497, 34164872298, 34164770687 all failed this way on 2026-09-07.

**What the human needs to do:** Run cloud's `daytona-sweep-orphans.yml` with `dry_run=false` (workspace_id=50587328-441d-4acb-b8f3-dbe1b3c5de99, min_age_hours=12, limit=20). Dry runs report 79 eligible orphans, ~40 CPU reclaimed per invocation. This is destructive, so no agent can run it.

## What gate 3 still needs

The implementation is complete. What remains unverified is the **verdict path**: no swarm has completed end to end, so the Definition of done's "first successful run" is outstanding. Gate 3 becomes GREEN when:

1. A review-swarm GHA run completes (status=completed, not failed on CPU quota)
2. The run ID appears in a PR comment
3. Three lens transcripts are posted to the PR

This requires CPU capacity, which requires the human action above.

## Objective

No code work. The work package is: **recognize gate 3 is complete and blocked on human action**.

## Files in scope

None. All files satisfy TARGET.md requirements.

## Definition of done

This assessment is done when:
- ops/NEXT.md honestly reports gate 3 is complete and blocked
- The commit exists in git history
- The run ends with ASSESS_DONE

## Out of scope

- All code changes (gate 3 implementation is complete)
- `sdk/` (Track A)
- `kernel/` (gate 1 done)
- `ops/*` except this file (chief owns state)
- Running the Daytona sweep (human action per NEEDS_HUMAN.md)
