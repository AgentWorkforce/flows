# NEXT — work package for this tick

**Gate:** 3

**Scope (from ops/TARGET.md):**

Track D: Cloud review-swarm redesign — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

## Objective

Build the cloud-hosted review swarm workflow that enforces RFC-0001 §2 rule 7 ("every PR met by a review swarm — our own, not a vendor's"). The local `~/AgentWorkforce/review-swarm-loop.sh` works but lives on the chief's laptop. The cloud version must exist for gate 3+ work to be trustworthy.

This is a redesign addressing all 9 architectural findings from prior attempts #75 and #77 that were rejected and walked away from.

## Files in scope

- `.github/workflows/review-swarm.yml` — the GHA trigger (NEW)
- `.github/workflows/scripts/swarm-post.sh` — sync + verdict + post script (NEW)
- `.github/workflows/scripts/swarm-prepare.sh` — launcher-side fetcher (NEW)
- `.github/workflows/scripts/swarm-verdict.sh` — shared verdict logic (NEW, per requirement 2)
- `workflows/review-swarm.yaml` — aggregate step refactored to use shared verdict logic
- `.gitignore` — drop the `.review-target` mask
- `README.md` — document `RELAY_WORKSPACE_KEY` secret + how to obtain

## Definition of done

All of the following must pass and output MUST be captured in the PR body:

```bash
# Parse checks
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))"
python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))"
bash -n .github/workflows/scripts/swarm-post.sh
bash -n .github/workflows/scripts/swarm-prepare.sh
bash -n .github/workflows/scripts/swarm-verdict.sh
```

Requirements verification (address all 9 findings):

1. **Immutable gate** — two `actions/checkout@v4` steps with different `path:` values visible in `.github/workflows/review-swarm.yml`
2. **Unified verdict logic** — ONE source of truth for verdict extraction (either `scripts/swarm-verdict.sh` sourced by both aggregate step and swarm-post.sh, OR aggregate step trivial and swarm-post.sh does all extraction)
3. **Auth secret validation** — preflight step validates `RELAY_WORKSPACE_KEY` is set and non-empty BEFORE cloud run launch
4. **Sticky marker + sticky transcripts** — use HTML anchor `<!-- swarm-lens: <lens> -->` for find-by-anchor editing
5. **Every PR gets reviewed** — NO author whitelist (`if: github.event.pull_request.user.login == ...` must be absent)
6. **Cloud sandbox fetch** — GHA runner fetches via `gh pr diff/view`, stages into `.review-target/{pr-number,pr.diff,pr.json}`, `git add -f` before `agent-relay cloud run`
7. **Timeout ordering** — job timeout > poll deadline > swarm timeoutMs (documented invariant with comment)
8. **Wait step records terminal status** — output recorded, post step runs `if: always()`
9. **Transcript-to-run-id binding** — sub-guard: reject stale transcripts (mtime older than sync start)

Tests:
```bash
cd sdk && npm test
```

Final check:
```bash
git status --porcelain
```

## Out of scope

- `sdk/` (Track A owns that)
- `kernel/` (gate 1 done, no changes)
- `ops/*` (chief owns briefs and state)
- Any GHA workflow other than review-swarm.yml
- Actually TESTING the workflow in CI (requires `RELAY_WORKSPACE_KEY` secret set which is a human step; the DoD is the workflow being correct, not proven live)
- Anything in the "Do not re-do these" list in TARGET.md (picker actionability #42, unterminated backticks #45, gate-1 race regression test #48, ops/NEXT.md validation #50, SDK agent worker #53, SDK pretest hook #69)

## Assessment context

**Current state:**
- Gate 1: GREEN (PR #48 closed the race regression test)
- Gate 2: AMBER (proactive agent primitives exist, real workload hn-monitor runs manually, awaiting judgement on whether manual satisfies rule 2)
- Gate 3: RED, and this is the work package to advance it
- No open PRs (per STATE.md updated 2026-08-30 02:55 UTC)
- No standing directives (ops/DIRECTIVES.md is empty except header)

**Test status:**
- Kernel: 77 tests passed (19+0+19+1+1+26+5+6), 0 failed
- SDK: 203 tests passed, 0 failed

**Known environment:**
- Cloud sandbox has no `.git`, no `gh` auth, no network to GitHub (STATE.md §"Known environment faults")
- This is why requirement 6 mandates fetch on GHA runner side, not in cloud sandbox

This work package stays strictly inside gate 3 territory (`.github/` + `workflows/review-swarm.yaml`). It does NOT touch `sdk/` or `kernel/`.
