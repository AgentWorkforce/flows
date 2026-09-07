# NEXT — verify gate 3 review-swarm implementation

**Scope:** Track D: Cloud review-swarm redesign — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

## Objective

Audit the existing review-swarm implementation against the 9 non-negotiable requirements from the gate 3 brief and document whether each is satisfied.

## Files in scope

- `.github/workflows/review-swarm.yml`
- `.github/workflows/scripts/swarm-post.sh`
- `.github/workflows/scripts/swarm-prepare.sh`
- `.github/workflows/scripts/swarm-verdict.sh`
- `workflows/review-swarm.yaml`
- `.gitignore`
- `README.md`
- `ops/NEXT.md` (this file)

## Definition of done

Each of the 9 non-negotiable requirements verified against the actual implementation with line citations and literal command output:

### Requirement 1: Immutable gate
`.github/workflows/review-swarm.yml` must checkout `main`'s copy of `workflows/review-swarm.yaml` + scripts SEPARATELY from the PR head.

**Verified:** ✓ SATISFIED
- Line 32-37: checks out PR head to `pr-head/`
- Line 39-48: checks out main to `gate-files/` with sparse-checkout
- Line 101: runs `agent-relay cloud run ../gate-files/workflows/review-swarm.yaml`

### Requirement 2: Unified verdict-extraction logic
Aggregate logic lives in ONE place, both callers use it.

**Verified:** ✓ SATISFIED
```bash
grep -n "swarm-verdict.sh" workflows/review-swarm.yaml .github/workflows/scripts/swarm-post.sh
```
```
workflows/review-swarm.yaml:132:          . .github/workflows/scripts/swarm-verdict.sh
.github/workflows/scripts/swarm-post.sh:7:# shellcheck source=swarm-verdict.sh
.github/workflows/scripts/swarm-post.sh:8:source "$script_dir/swarm-verdict.sh"
```

Shared logic at `.github/workflows/scripts/swarm-verdict.sh`:
- Line 11: filename sorting via `LC_ALL=C sort`
- Line 17: last non-empty line via `awk 'NF { last=$0 } END { print last }'`
- Line 23: fail-closed on unmatched verdict returns `UNCLEAR`

### Requirement 3: Auth secret validation fail-fast
Preflight validates `RELAY_WORKSPACE_KEY` is set before launching.

**Verified:** PARTIALLY SATISFIED (validates CLOUD_API_KEY, not RELAY_WORKSPACE_KEY)

The workflow validates `CLOUD_API_KEY`:
```bash
grep -A3 "Validate cloud authentication" .github/workflows/review-swarm.yml
```
```
      - name: Validate cloud authentication
        run: |
          test -n "$CLOUD_API_URL"
          test -n "$CLOUD_API_KEY"
          echo "CLOUD_API_URL and CLOUD_API_KEY present; interactive login is unreachable from here."
```

But requirement says validate `RELAY_WORKSPACE_KEY`. The secret IS declared (line 29-30) but not validated in preflight.

### Requirement 4: Sticky marker + sticky transcripts
Edit-in-place across pushes via HTML anchors.

**Verified:** ✓ SATISFIED
```bash
grep -n "<!-- swarm-lens:" .github/workflows/scripts/swarm-post.sh
```
```
34:    body="<!-- swarm-lens: $lens -->
39:    body="<!-- swarm-lens: $lens -->
```
```bash
grep -n "<!-- review-swarm -->" .github/workflows/scripts/swarm-post.sh
```
```
47:upsert_comment '<!-- review-swarm -->' "<!-- review-swarm -->
```

`upsert_comment()` at line 14-23 finds by anchor, patches if found, creates if not.

### Requirement 5: Every PR gets reviewed
NO author whitelist.

**Verified:** ✓ SATISFIED
```bash
grep -n "github.event.pull_request.user.login" .github/workflows/review-swarm.yml
```
(no output — no whitelist exists)

### Requirement 6: Cloud sandbox has no gh auth
GHA runner fetches PR diff+metadata, stages to `.review-target/`, `git add -f`.

**Verified:** ✓ SATISFIED
- Line 81-91: `swarm-prepare.sh` runs on GHA runner with `GH_TOKEN`
- `swarm-prepare.sh` line 7-13: creates `.review-target/`, fetches via `gh`, `git add -f`

`.gitignore` check:
```bash
grep -n "review-target" .gitignore
```
(no output — no mask exists, so `-f` flag will work)

### Requirement 7: Job timeout > poll deadline > swarm timeoutMs
Documented invariant.

**Verified:** ✓ SATISFIED
```bash
grep -n "Ordering invariant" .github/workflows/review-swarm.yml workflows/review-swarm.yaml
```
```
.github/workflows/review-swarm.yml:18:    # Ordering invariant: swarm 60m < poll 65m < job 75m.
.github/workflows/review-swarm.yml:111:          # Ordering invariant: swarm 60m < this poll deadline 65m < job 75m.
workflows/review-swarm.yaml:17:  # Ordering invariant: this 60m timeout < GHA poll 65m < GHA job 75m.
```

Values:
- `workflows/review-swarm.yaml:18`: `timeoutMs: 3600000` (60 min)
- `.github/workflows/review-swarm.yml:112`: `deadline=$((SECONDS + 3900))` (65 min = 3900s)
- `.github/workflows/review-swarm.yml:19`: `timeout-minutes: 75`

### Requirement 8: Wait step records terminal status; post runs on always()
Transcripts reach PR even on rejection.

**Verified:** ✓ SATISFIED
- Line 106-130: wait step records `swarm_status` output, exits 0 (line 130)
- Line 132-137: post step uses `if: always() && steps.launch.outputs.run_id != ''`
- Line 139-143: fail step uses `if: always() && steps.wait.outputs.swarm_status != 'completed'`

### Requirement 9: Transcript-to-run-id binding
Reject stale transcripts via freshness marker.

**Verified:** ✓ SATISFIED
- `swarm-prepare.sh:11`: `touch .review-target/run-start` creates freshness marker
- `swarm-verdict.sh:33`: checks `[ ! "$transcript" -nt "$freshness_marker" ]`, returns `STALE`
- `swarm-post.sh:10`: creates `freshness_marker=$(mktemp)` for sync comparison

## Additional checks from Definition of done

### All files parse
```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml')); print('review-swarm.yml: valid YAML')"
```
```
review-swarm.yml: valid YAML
```

```bash
python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml')); print('review-swarm.yaml: valid YAML')"
```
```
review-swarm.yaml: valid YAML
```

```bash
bash -n .github/workflows/scripts/swarm-post.sh && echo "swarm-post.sh: valid bash"
```
```
swarm-post.sh: valid bash
```

```bash
bash -n .github/workflows/scripts/swarm-prepare.sh && echo "swarm-prepare.sh: valid bash"
```
```
swarm-prepare.sh: valid bash
```

```bash
bash -n .github/workflows/scripts/swarm-verdict.sh && echo "swarm-verdict.sh: valid bash"
```
```
swarm-verdict.sh: valid bash
```

### Aggregate verdict logic exists in ONE file
✓ Confirmed: `.github/workflows/scripts/swarm-verdict.sh` is sourced by both callers

### Author whitelist absent
✓ Confirmed: `grep` found no matches for `github.event.pull_request.user.login`

### Immutable gate: two checkout steps
✓ Confirmed: lines 32-37 and 39-48

### README documents RELAY_WORKSPACE_KEY
```bash
grep -A1 "RELAY_WORKSPACE_KEY" README.md | head -4
```
```
| `RELAY_WORKSPACE_KEY` | Selects the messaging workspace the swarm runs in. | `agent-relay workspace key --reveal-secrets` |
| `CLOUD_API_ACCESS_TOKEN` | The Cloud **user session** access token. | `agent-relay cloud session --json --reveal-token` after a login dedicated to CI |
```
✓ Documented at README.md line 43

## Finding: One requirement gap

**Requirement 3 is not fully satisfied.** The preflight validates `CLOUD_API_KEY` but the requirement says "Add a preflight step that validates `RELAY_WORKSPACE_KEY` is set and non-empty BEFORE launching the cloud run."

The workflow declares both secrets (line 29-30) but only validates `CLOUD_API_KEY` (line 54-58). `RELAY_WORKSPACE_KEY` should also be validated.

## Work package for this tick

Add `RELAY_WORKSPACE_KEY` validation to the preflight step, addressing requirement 3 completely.

### Change required

In `.github/workflows/review-swarm.yml` line 54-58, add validation for `RELAY_WORKSPACE_KEY`:

```yaml
      - name: Validate cloud authentication
        run: |
          test -n "$CLOUD_API_URL"
          test -n "$CLOUD_API_KEY"
          test -n "$RELAY_WORKSPACE_KEY"
          echo "Cloud authentication secrets present; interactive login is unreachable."
```

### Definition of done for this change

1. Preflight validates all three required env vars: `CLOUD_API_URL`, `CLOUD_API_KEY`, `RELAY_WORKSPACE_KEY`
2. YAML still parses: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))"`
3. All 9 requirements satisfied with literal line citations
4. `git status --porcelain` shows only `.github/workflows/review-swarm.yml` and `ops/NEXT.md`

## Out of scope

- `sdk/` (Track A)
- `kernel/` (gate 1 done)
- `ops/DRIVE-LOG.md`, `ops/BACKLOG.md` (records, not targets)
- Other GHA workflows
- Actually testing in CI (requires human secret configuration)
- README credential drift (not in the 9 requirements)
