# NEXT — work package for this tick

**Scope (from ops/TARGET.md):** **Track D: Cloud review-swarm redesign** — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

## Objective

Implement the cloud-based review swarm that enforces RFC-0001 §2 rule 7 ("every PR met by a review swarm — our own, not a vendor's"). The local `~/AgentWorkforce/review-swarm-loop.sh` works but lives on Khaliq's laptop. The cloud version must exist for gate 3+ work to be trustworthy.

This work package addresses ALL 9 non-negotiable requirements from prior review findings on PRs #75 and #77, which were walked away from without resolution.

## Files in scope

- `.github/workflows/review-swarm.yml` — the GHA trigger (NEW FILE)
- `.github/workflows/scripts/swarm-prepare.sh` — launcher-side PR fetcher (NEW FILE)
- `.github/workflows/scripts/swarm-post.sh` — sync + verdict + post script (NEW FILE)
- `.github/workflows/scripts/swarm-verdict.sh` — shared verdict extraction logic (NEW FILE)
- `workflows/review-swarm.yaml` — refactor aggregate step to use shared verdict logic (EDIT)
- `.gitignore` — drop the `.review-target` mask (EDIT)
- `README.md` — document `RELAY_WORKSPACE_KEY` secret + how to obtain (EDIT)

## Definition of done

All 9 requirements from ops/TARGET.md must be satisfied:

### 1. Immutable gate (settled decision #6)
`.github/workflows/review-swarm.yml` uses TWO `actions/checkout@v4` steps with different `path:` values:
- One checks out PR head for the code under review
- One checks out `main`'s copy of `workflows/review-swarm.yaml` + all `.github/workflows/scripts/*.sh` files
- The swarm is launched using main's gate files, not the PR's

**Verification command:**
```bash
grep -c "uses: actions/checkout@v4" .github/workflows/review-swarm.yml
# Must output: 2
grep "path:" .github/workflows/review-swarm.yml | wc -l
# Must output: 2
```

### 2. Unified verdict-extraction logic (one source of truth)
Create `.github/workflows/scripts/swarm-verdict.sh` containing ALL verdict extraction logic. Both `workflows/review-swarm.yaml`'s aggregate step AND `.github/workflows/scripts/swarm-post.sh` source this single file. Rules enforced:
- Transcript selection sorts by FILENAME (`YYYYMMDD-HHMM` prefix), not mtime
- Verdict is the LAST non-empty line's token, not a whole-file grep
- `overall = ALL lenses PASSED, else FAILED` — fail-closed on MISSING/UNCLEAR/FAILED

**Verification command:**
```bash
test -f .github/workflows/scripts/swarm-verdict.sh && echo "verdict script exists"
grep "source.*swarm-verdict.sh" .github/workflows/scripts/swarm-post.sh && echo "post.sh sources it"
grep "swarm-verdict.sh" workflows/review-swarm.yaml && echo "yaml references it"
```

### 3. Auth secret validation fail-fast
Add a preflight step in `.github/workflows/review-swarm.yml` that validates `RELAY_WORKSPACE_KEY` is set and non-empty BEFORE launching the cloud run. If missing, fail the job immediately with clear message.

**Verification command:**
```bash
grep -A 5 "RELAY_WORKSPACE_KEY" .github/workflows/review-swarm.yml | grep -q "if.*==.*''" && echo "preflight check exists"
```

### 4. Sticky marker + sticky transcripts (edit-in-place)
All comments use HTML anchors and edit in place across pushes. A PR with 5 pushes ends with 1 marker + 3 transcripts (edited to latest), NOT 5 markers + 15 transcripts. Use `<!-- swarm-lens: <lens> -->` anchors.

**Verification command:**
```bash
grep "swarm-lens:" .github/workflows/scripts/swarm-post.sh && echo "lens anchors present"
grep "swarm-marker" .github/workflows/scripts/swarm-post.sh && echo "marker anchor present"
```

### 5. Every PR gets reviewed (RFC-0001 §2 rule 7)
NO author whitelist in `.github/workflows/review-swarm.yml`.

**Verification command:**
```bash
! grep "github.event.pull_request.user.login" .github/workflows/review-swarm.yml && echo "no author whitelist"
```

### 6. Cloud sandbox has no gh auth — fetch on launching host
GHA runner fetches PR diff + metadata via `gh pr diff/view`, stages into `.review-target/{pr-number,pr.diff,pr.json}`, `git add -f`. Then `agent-relay cloud run` uploads the working tree. The `.gitignore` mask on `.review-target` must be dropped.

**Verification command:**
```bash
! grep "^\.review-target" .gitignore && echo "review-target not ignored"
test -f .github/workflows/scripts/swarm-prepare.sh && grep "gh pr diff" .github/workflows/scripts/swarm-prepare.sh && echo "prepare.sh fetches PR"
```

### 7. Job timeout > poll deadline > swarm timeoutMs (documented invariant)
Values and comments must be present naming the ordering:
- `workflows/review-swarm.yaml` `timeoutMs: 3600000` (60 min) with comment
- `.github/workflows/review-swarm.yml` wait poll deadline: 3900s (65 min) with comment
- `.github/workflows/review-swarm.yml` job `timeout-minutes: 75` (65 + 10) with comment

**Verification command:**
```bash
grep "timeoutMs: 3600000" workflows/review-swarm.yaml && echo "swarm timeout set"
grep "3900" .github/workflows/review-swarm.yml && echo "poll deadline set"
grep "timeout-minutes: 75" .github/workflows/review-swarm.yml && echo "job timeout set"
```

### 8. Wait step records terminal status; post step runs on always()
Structure must be:
- wait step: records `$swarm_status` output, always exits 0
- post step: `if: always() && steps.launch.outputs.run_id != ''`
- fail step: `if: steps.wait.outputs.swarm_status != 'completed'` # exit 1 gates merge

**Verification command:**
```bash
grep "always()" .github/workflows/review-swarm.yml | grep -q "post" && echo "post runs on always"
grep "swarm_status" .github/workflows/review-swarm.yml && echo "status output exists"
```

### 9. Transcript-to-run-id binding
Sub-guard: require ALL THREE transcripts newly-produced in THIS sync. If any transcript's file mtime is older than the sync started, reject as stale.

**Verification command:**
```bash
grep "mtime" .github/workflows/scripts/swarm-post.sh && echo "mtime check present"
```

### Parse checks
All files must parse without errors:

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))" && echo "GHA workflow parses"
python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))" && echo "swarm spec parses"
bash -n .github/workflows/scripts/swarm-prepare.sh && echo "prepare.sh parses"
bash -n .github/workflows/scripts/swarm-post.sh && echo "post.sh parses"
bash -n .github/workflows/scripts/swarm-verdict.sh && echo "verdict.sh parses"
```

### SDK tests unaffected

```bash
cd sdk && npm test
```

**Expected output (verbatim tail):**
```
Test Files  5 passed (5)
     Tests  [N] passed ([N])
```

### Final state check

```bash
git status --porcelain
```

**Expected:** Shows only the files listed in "Files in scope" as modified/new.

## Out of scope

- `sdk/` (Track A owns that; no changes)
- `kernel/` (gate 1 done, no changes)
- `ops/*` (chief owns briefs and state)
- Any GHA workflow other than `review-swarm.yml`
- Actually TESTING the workflow in CI (requires `RELAY_WORKSPACE_KEY` secret set, which is a human step)
- The HN monitor work (Track A, different run)

## What happens after done

This work package will be opened as a PR. The PR body must explicitly document each of the 9 requirements above and show where each is satisfied (file:line references). A reviewer should be able to verify every requirement by reading the cited locations.

The cloud review swarm will remain untested until a human configures the `RELAY_WORKSPACE_KEY` secret in the repo settings. That is explicitly out of scope for this tick — the deliverable is the correct workflow files, not a proven live run.
