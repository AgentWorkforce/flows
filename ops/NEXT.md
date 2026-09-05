# NEXT — gate 3 work package

## Scope

**Track D: Cloud review-swarm redesign** — validate that `.github/workflows/review-swarm.yml` and supporting infrastructure satisfy all 9 architectural requirements from the walked-away #75/#77 attempts, then fix the SDK test failure blocking the "definition of done."

This run is pinned to **gate 3**. Work on other gates collides with parallel runs.

## Objective

Verify that the existing review-swarm implementation addresses all 9 non-negotiable requirements from ops/TARGET.md, document the verification in this package, and fix the SDK test failure so the definition-of-done command (`cd sdk && npm test`) passes.

## Files in scope

- `.github/workflows/review-swarm.yml` (verify only; already exists)
- `.github/workflows/scripts/swarm-prepare.sh` (verify only; already exists)
- `.github/workflows/scripts/swarm-post.sh` (verify only; already exists)
- `.github/workflows/scripts/swarm-verdict.sh` (verify only; already exists)
- `workflows/review-swarm.yaml` (verify only; already exists)
- `.gitignore` (verify only; no `.review-target` mask present)
- `README.md` (verify only; already documents `RELAY_WORKSPACE_KEY`)
- `sdk/package.json` (fix @types/node missing dependency)

## Current state assessment

### Requirement verification

**Requirement 1: Immutable gate — two checkout steps**
✅ SATISFIED — `.github/workflows/review-swarm.yml:21-37` has two `actions/checkout@v4` steps:
- `pr-head` at L21-26 (PR head sha)
- `gate-files` at L28-37 (main branch, sparse checkout of gate files)

**Requirement 2: Unified verdict-extraction logic**
✅ SATISFIED — `.github/workflows/scripts/swarm-verdict.sh` is the single source of truth:
- Transcript selection: `swarm_latest_transcript` sorts by filename (L7-8)
- Verdict extraction: `swarm_transcript_verdict` reads last non-empty line's token (L12-13)
- Used by both `workflows/review-swarm.yaml:136` (aggregate step sources it) and `.github/workflows/scripts/swarm-post.sh:8` (sources it)

**Requirement 3: Auth secret validation fail-fast**
✅ SATISFIED — `.github/workflows/review-swarm.yml:39-46` validates `RELAY_WORKSPACE_KEY` is set and non-empty before launching; exits 1 with clear message referencing README § Cloud review swarm.

**Requirement 4: Sticky marker + sticky transcripts**
✅ SATISFIED — `.github/workflows/scripts/swarm-post.sh:14-23` implements `upsert_comment` with HTML anchor find-by-anchor logic:
- Marker uses `<!-- review-swarm -->` (L47)
- Each lens uses `<!-- swarm-lens: <lens> -->` (L34, L39)

**Requirement 5: Every PR gets reviewed**
✅ SATISFIED — `.github/workflows/review-swarm.yml:3-5` triggers on all PRs (opened, synchronize, reopened, ready_for_review); no author whitelist present.

**Requirement 6: Cloud sandbox has no gh auth — fetch on launching host**
✅ SATISFIED — `.github/workflows/review-swarm.yml:48-57` runs `swarm-prepare.sh` on GHA runner (which has `GH_TOKEN`), stages `.review-target/{pr-number,pr.diff,pr.json}` with `git add -f`.

**Requirement 7: Job timeout > poll deadline > swarm timeoutMs**
✅ SATISFIED — ordering invariant documented and enforced:
- `workflows/review-swarm.yaml:18` — swarm `timeoutMs: 3600000` (60 min)
- `.github/workflows/review-swarm.yml:77` — poll deadline 3900s (65 min), with comment
- `.github/workflows/review-swarm.yml:19` — job `timeout-minutes: 75`, with comment

**Requirement 8: Wait step records terminal status; post runs on always()**
✅ SATISFIED:
- `.github/workflows/review-swarm.yml:70-91` — wait step records `swarm_status` output, always exits 0 (L91)
- `.github/workflows/review-swarm.yml:93-99` — post step has `if: always() && steps.launch.outputs.run_id != ''`
- `.github/workflows/review-swarm.yml:101-105` — enforce step fails if `swarm_status != 'completed'`

**Requirement 9: Transcript-to-run-id binding**
✅ SATISFIED — `.github/workflows/scripts/swarm-post.sh:10-12` creates `freshness_marker` (mktemp) BEFORE sync, then `swarm-verdict.sh:27` rejects transcripts with mtime older than the marker (stale check).

### Additional DoD items

**All files parse:**
- `.github/workflows/review-swarm.yml` — valid GHA YAML ✅
- `workflows/review-swarm.yaml` — valid relayflow spec ✅
- All `.sh` scripts — bash syntax valid ✅

**Aggregate verdict logic in ONE file:**
✅ SATISFIED — `swarm-verdict.sh` is the single source.

**Author whitelist absent:**
✅ SATISFIED — no conditional on `github.event.pull_request.user.login`.

**Immutable gate: two checkout steps:**
✅ SATISFIED — verified above.

**SDK tests:**
❌ BLOCKED — `cd sdk && npm test` fails with:
```
error TS2688: Cannot find type definition file for 'node'.
```

This is a missing `@types/node` devDependency in `sdk/package.json`.

## Definition of done

1. ✅ All 9 requirements from ops/TARGET.md verified and documented above
2. ✅ All files parse (verified by reading; no syntax changes needed)
3. ✅ Aggregate verdict logic exists in ONE file (`swarm-verdict.sh`)
4. ✅ Author whitelist absent
5. ✅ Immutable gate: two checkout steps with different paths
6. ❌ `cd sdk && npm test` green — MUST fix @types/node missing

**To satisfy DoD item 6:**
Add `@types/node` to `sdk/package.json` devDependencies, run `npm install`, verify tests pass.

**Passing command (after fix):**
```bash
cd sdk && npm test
```

Expected output: all tests pass, no TypeScript errors.

**Final verification command:**
```bash
git status --porcelain
```

## Out of scope

- Any changes to `.github/workflows/review-swarm.yml` or scripts (they already satisfy all requirements)
- Any changes to `workflows/review-swarm.yaml` (aggregate step already sources shared verdict logic)
- Any changes to `.gitignore` (no `.review-target` mask present)
- Any changes to `README.md` (already documents `RELAY_WORKSPACE_KEY` at L38-40)
- `kernel/` (gate 1 done, no changes)
- Any GHA workflow other than review-swarm.yml
- Actually testing the workflow in CI (requires human-set secret)
- Track A work (sdk/ implementation; only fixing the test blocker is in scope)

## What this package will do

1. Add `@types/node` to `sdk/package.json` devDependencies
2. Run `npm install` in `sdk/`
3. Verify `npm test` passes
4. Verify `git status --porcelain` shows only the expected changes
5. Report findings with literal command outputs
