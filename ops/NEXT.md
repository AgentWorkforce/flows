# NEXT — work package for this tick

**Scope:** Build `.github/workflows/review-swarm.yml` correctly, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

This run is pinned to **gate 3, Track D** (Cloud review-swarm redesign).

## Objective

Implement cloud-based review swarm automation that enforces RFC-0001 §2 rule 7 ("every PR met by a review swarm — our own, not a vendor's") by creating the GitHub Actions workflow and supporting scripts that address all 9 non-negotiable requirements from prior failed attempts (#75, #77).

The local `~/AgentWorkforce/review-swarm-loop.sh` works but lives on Khaliq's laptop. When the session ends, so does swarm enforcement. The cloud version must exist for gate 3+ work to be trustworthy.

## Context from TARGET.md

Prior attempts (#75, #77) each shipped real code but were rejected on progressively deeper architectural findings:
1. Immutable gate violation (PR could control its own judge)
2. Duplicate verdict logic that could disagree
3. No auth secret validation (failed runs with no clear error)
4. Non-sticky comments (5 pushes → 20 comments instead of 4 edited)
5. Author whitelists (violates "every PR" requirement)
6. Cloud sandbox fetch failure (no `gh` auth in sandbox)
7. Timeout invariant violations
8. Transcript loss on rejecting swarms
9. Stale transcript binding

Every one was a legitimate swarm rejection. Address them or don't ship.

## Files in scope

- `.github/workflows/review-swarm.yml` — the GHA trigger (NEW)
- `.github/workflows/scripts/swarm-post.sh` — sync + verdict + post script (NEW)
- `.github/workflows/scripts/swarm-prepare.sh` — launcher-side fetcher (NEW)
- `workflows/review-swarm.yaml` — refactor aggregate step to share verdict logic
- `.gitignore` — drop the `.review-target` mask
- `README.md` — document `RELAY_WORKSPACE_KEY` secret + how to obtain

## Definition of done

ALL of the following must hold:

1. All files parse:
   ```
   python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))"
   python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))"
   bash -n .github/workflows/scripts/swarm-post.sh
   bash -n .github/workflows/scripts/swarm-prepare.sh
   ```

2. Aggregate verdict logic exists in ONE file, both callers use it

3. Author whitelist absent (no `if: github.event.pull_request.user.login == ...`)

4. Immutable gate: two checkout steps with different paths

5. PR body explicitly documents each of the 9 requirements above and shows where each is satisfied

6. SDK tests still pass:
   ```
   cd sdk && npm test
   ```

7. As final action:
   ```
   git status --porcelain
   ```

## Explicitly OUT of scope

- `sdk/` (Track A owns that)
- `kernel/` (gate 1 done, no changes)
- `ops/*` (chief owns briefs and state)
- Any GHA workflow other than review-swarm.yml
- Actually TESTING the workflow in CI (requires `RELAY_WORKSPACE_KEY` secret set which is a human step; the DoD is the workflow being correct, not proven live)

## If blocked

If gate 3 Track D is genuinely unreachable from the current state, write ops/NEEDS_HUMAN.md saying exactly why and still end with ASSESS_DONE. Do not silently substitute different work: a run that reports progress on the wrong gate is worse than one that reports it is blocked.
