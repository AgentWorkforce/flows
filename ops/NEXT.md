# NEXT — work package for this tick

**Scope:** Build `.github/workflows/review-swarm.yml` and supporting infrastructure correctly, addressing every architectural finding from the walked-away #75/#77 attempts.

This run is pinned to **gate 3** (Track D: Cloud review-swarm redesign) and must not work on any other gate.

## Objective

Build the cloud-hosted GitHub Actions review-swarm workflow that enforces RFC-0001 §2 rule 7 ("every PR met by a review swarm — our own, not a vendor's"). This workflow must run in GitHub Actions (not just locally) and address all 9 architectural requirements that caused #75 and #77 to be rejected.

## Context

The local `~/AgentWorkforce/review-swarm-loop.sh` (chief-owned shell) is currently the only enforcement of RFC-0001 §2 rule 7. It works, but it lives on a laptop. When that session ends, so does swarm enforcement.

The cloud version — `workflows/review-swarm.yaml` fired from `.github/workflows/review-swarm.yml` — must exist for gate 3+ work to be trustworthy. Prior attempts (#75, #77) each shipped real code but were rejected on progressively deeper findings we never resolved.

## Files in scope

- `.github/workflows/review-swarm.yml` — the GHA trigger (CREATE/REWRITE)
- `.github/workflows/scripts/swarm-post.sh` — the sync + verdict + post script (CREATE)
- `.github/workflows/scripts/swarm-prepare.sh` — the launcher-side fetcher (CREATE)
- `.github/workflows/scripts/swarm-verdict.sh` — shared verdict extraction logic (CREATE)
- `workflows/review-swarm.yaml` — aggregate step refactored to share verdict logic (EDIT)
- `.gitignore` — drop the `.review-target` mask (EDIT)
- `README.md` — document `RELAY_WORKSPACE_KEY` secret + how to obtain (EDIT)

## Definition of done

ALL of the following must hold:

1. All files parse correctly — run these commands and paste the literal output:
   ```
   python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))"
   python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))"
   bash -n .github/workflows/scripts/swarm-post.sh
   bash -n .github/workflows/scripts/swarm-prepare.sh
   bash -n .github/workflows/scripts/swarm-verdict.sh
   ```

2. Aggregate verdict logic exists in ONE file (`scripts/swarm-verdict.sh` or equivalent), both `workflows/review-swarm.yaml` aggregate step AND `.github/workflows/scripts/swarm-post.sh` use it

3. Author whitelist absent — verify no `if: github.event.pull_request.user.login == ...` in `.github/workflows/review-swarm.yml`

4. Immutable gate verified — two separate `actions/checkout@v4` steps with different `path:` values in `.github/workflows/review-swarm.yml` (one for PR head, one for main's gate files)

5. All 9 requirements from gate 3 scope addressed:
   - **§1: Immutable gate** — PR must NOT control its own judge. Two checkout steps with different paths. Launch swarm using main's gate files, not PR's.
   - **§2: Unified verdict-extraction logic** — one source of truth. Verdict logic in ONE place (shared bash helper OR aggregate step becomes trivial). Rules: filename sort, last non-empty line token, fail-closed on MISSING/UNCLEAR/FAILED.
   - **§3: Auth secret validation fail-fast** — preflight step validates `RELAY_WORKSPACE_KEY` is set and non-empty BEFORE launching cloud run. Fail with clear message if missing.
   - **§4: Sticky marker + sticky transcripts** — edit-in-place across pushes using HTML anchors. 1 marker + 3 transcripts (edited), NOT N markers + 3N transcripts. Use `<!-- swarm-lens: <lens> -->` anchors.
   - **§5: Every PR gets reviewed** — NO author whitelist. If filter needed, document as temporary + file RFC amendment.
   - **§6: Cloud sandbox has no `gh` auth** — GHA runner fetches PR diff + metadata via `gh pr diff/view`, stages into `.review-target/{pr-number,pr.diff,pr.json}`, `git add -f`. Drop `.review-target` from `.gitignore`.
   - **§7: Job timeout > poll deadline > swarm timeoutMs** — documented invariant. Values: `timeoutMs: 3600000` (60 min), poll deadline: 3900s (65 min), `timeout-minutes: 75`. Comment where each lives naming the ordering invariant.
   - **§8: Wait step records terminal status; post step runs on always()** — rejecting swarm transcripts MUST reach PR. Structure: wait step records `$swarm_status` output (exits 0), post step `if: always() && steps.launch.outputs.run_id != ''`, fail step `if: steps.wait.outputs.swarm_status != 'completed'`.
   - **§9: Transcript-to-run-id binding** — sub-guard: aggregate rejects stale transcripts. Require ALL THREE transcripts newly-produced in THIS sync. If any transcript mtime older than sync started, reject as stale.

6. SDK tests remain green (unaffected by `.github/` changes) — run and paste literal output:
   ```
   cd sdk && npm test
   ```

7. Final verification — working tree state, run and paste literal output:
   ```
   git status --porcelain
   ```

## Explicitly OUT of scope

- `sdk/` (Track A owns that territory)
- `kernel/` (gate 1 is done, no changes needed)
- `ops/*` (chief owns briefs and state)
- Any GHA workflow other than `review-swarm.yml`
- Actually TESTING the workflow in CI (requires human to set `RELAY_WORKSPACE_KEY` secret in GitHub; the DoD is the workflow being architecturally correct and parseable, not proven live)
- Anything in the "Do not re-do these" list:
  - picker actionability (#42), unterminated backticks (#45)
  - gate-1 race regression test (#48) — do not touch `kernel/relayflowd/src/server/tests.rs`
  - ops/NEXT.md validation (#50) — do not touch `sdk/src/work-package-validator.ts`
  - SDK agent worker (#53) — `sdk/src/worker.ts` shipped; leave it alone
  - SDK pretest hook (#69) — `sdk/package.json` builds kernel before test

## If blocked

If gate 3 is genuinely unreachable from the current state, write `ops/NEEDS_HUMAN.md` saying exactly why and still end with ASSESS_DONE. Do not silently substitute different work: a run that reports progress on the wrong gate is worse than one that reports it is blocked.
