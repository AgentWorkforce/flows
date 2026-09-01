# Work Package — Gate 3: Cloud review-swarm redesign

## Scope (quoted from ops/TARGET.md)

**Track D: Cloud review-swarm redesign** — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

The local `~/AgentWorkforce/review-swarm-loop.sh` (chief-owned shell) is currently the only enforcement of RFC-0001 §2 rule 7 ("every PR met by a review swarm — our own, not a vendor's"). It works, but it lives on my laptop. When my session ends, so does swarm enforcement.

The cloud version — `workflows/review-swarm.yaml` fired from `.github/workflows/review-swarm.yml` — must exist for gate 3+ work to be trustworthy. Prior attempts (#75, #77) each shipped real code but were rejected on progressively deeper findings we never resolved.

## Objective

Create the GitHub Actions infrastructure to launch the review swarm (`workflows/review-swarm.yaml`) in the cloud, addressing all 9 architectural requirements from prior rejected attempts:

1. **Immutable gate** — PR must NOT control its own judge
2. **Unified verdict-extraction logic** — ONE source of truth for verdicts
3. **Auth secret validation fail-fast** — preflight check for RELAY_WORKSPACE_KEY
4. **Sticky marker + transcripts** — edit-in-place across pushes with HTML anchors
5. **Every PR gets reviewed** — no author whitelist (RFC-0001 §2 rule 7)
6. **Cloud sandbox has no `gh` auth** — fetch on launching host, stage into tree
7. **Job timeout > poll deadline > swarm timeoutMs** — documented invariant
8. **Wait step records terminal status** — post step runs on always()
9. **Transcript-to-run-id binding** — reject stale transcripts

## Files in scope

Add / rewrite:
- `.github/workflows/review-swarm.yml` — the GHA trigger (per requirements 1-8)
- `.github/workflows/scripts/swarm-post.sh` — sync + verdict + post script
- `.github/workflows/scripts/swarm-prepare.sh` — launcher-side fetcher (per req. 6)
- `workflows/review-swarm.yaml` — refactor aggregate step to share verdict logic (req. 2)
- `.gitignore` — drop the `.review-target` mask (currently blocks git add)
- `README.md` — document `RELAY_WORKSPACE_KEY` secret + how to obtain

## Definition of done

All of the following must pass WITH CAPTURED OUTPUT:

1. **Parse validation** — all files parse:
```
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))"
python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))"
bash -n .github/workflows/scripts/swarm-post.sh
bash -n .github/workflows/scripts/swarm-prepare.sh
```

2. **Aggregate verdict logic exists in ONE file** — both callers (aggregate step in yaml + swarm-post.sh) must source/use the same logic

3. **No author whitelist** — verified:
```
! grep -q "github.event.pull_request.user.login" .github/workflows/review-swarm.yml
```

4. **Immutable gate** — two checkout steps with different `path:` values visible in `.github/workflows/review-swarm.yml`

5. **SDK tests pass:**
```
cd sdk && npm ci && npm test
```

6. **Final status check:**
```
git status --porcelain
```

## Explicitly OUT of scope

- `sdk/` changes (Track A owns that; gate 2 frontier)
- `kernel/` changes (gate 1 done, no changes needed)
- `ops/*` state files (chief owns briefs and state)
- Any GHA workflow other than review-swarm.yml
- Actually TESTING the workflow in CI (requires `RELAY_WORKSPACE_KEY` secret set which is a human step; DoD is the workflow being **correct**, not proven live)
- Work on gates 1, 2, 4, 5, 6, 7, 8, or 9

## Current status

Assessment findings (2026-09-01 00:05 UTC):

**Unblocked and ready to proceed.**

- `.github/` directory does not exist — must be created
- `workflows/review-swarm.yaml` exists (155 lines) and is the working local version
- No open PRs blocking this work (ops/STATE.md: "NONE. Every PR is merged or triaged closed")
- `sdk/src/worker.ts` exists (2923 bytes) — the agent worker that was the subject of the previous, now-stale ops/NEXT.md
- Kernel tests verified passing:
  ```
  test result: ok. 6 passed; 0 failed
  (across relayflowd, relayflowd-journal, relayflowd-core: 30 tests total)
  ```
- SDK tests fail in sandbox due to missing node_modules (expected); DoD requires they pass after `npm ci`

This is pure infrastructure work creating the GHA workflow and helper scripts to launch the existing `workflows/review-swarm.yaml` in the cloud with proper auth, immutable gate files, and sticky comment management.
