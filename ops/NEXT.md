# NEXT — gate 3: Document review-swarm secrets in README

**Scope:** Track D: Cloud review-swarm redesign — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts. Parallel to Track A (hn-monitor); different territory (`.github/` + `workflows/` — no overlap with `sdk/` work).

## Why this matters

The local `~/AgentWorkforce/review-swarm-loop.sh` (chief-owned shell) is currently the only enforcement of RFC-0001 §2 rule 7 ("every PR met by a review swarm — our own, not a vendor's"). It works, but it lives on my laptop. When my session ends, so does swarm enforcement.

The cloud version — `workflows/review-swarm.yaml` fired from `.github/workflows/review-swarm.yml` — must exist for gate 3+ work to be trustworthy. Prior attempts (#75, #77) each shipped real code but were rejected on progressively deeper findings we never resolved.

## Current state verification

Analysis of the 9 non-negotiable requirements:

1. ✅ **Immutable gate** — two checkout steps at `.github/workflows/review-swarm.yml:32-48` (pr-head + gate-files from main)
2. ✅ **Unified verdict logic** — `swarm-verdict.sh` sourced by both `workflows/review-swarm.yaml:184` and `.github/workflows/scripts/swarm-post.sh:8`
3. ✅ **Auth secret validation** — preflight validates all three secrets at `.github/workflows/review-swarm.yml:91-94`: `CLOUD_API_URL`, `CLOUD_API_KEY`, and `RELAY_WORKSPACE_KEY`
4. ✅ **Sticky marker + transcripts** — HTML anchors `<!-- swarm-lens: {lens} -->` and `<!-- review-swarm -->` in `swarm-post.sh:34,39,44,47`
5. ✅ **No author whitelist** — verified absent:
   ```bash
   grep -c "whitelist\|github.event.pull_request.user.login" .github/workflows/review-swarm.yml
   # Output: 0
   ```
6. ✅ **Cloud sandbox fetch** — `swarm-prepare.sh` runs on GHA runner with `GH_TOKEN` at step "Prepare review input on GitHub runner" (line 160)
7. ✅ **Timeout ordering** — documented with comments:
   - swarm: 60m (`workflows/review-swarm.yaml:18`)
   - poll: 65m (3900s at `.github/workflows/review-swarm.yml:191`)
   - job: 75m (`.github/workflows/review-swarm.yml:19`)
8. ✅ **Wait step records status, post runs always()** — wait step at line 185-235 sets `swarm_status` output and exits 0; post step at line 237-242 has `if: always() && steps.launch.outputs.run_id != ''`
9. ✅ **Transcript-to-run-id binding** — `swarm-prepare.sh:11` creates `.review-target/run-start` marker; `swarm-verdict.sh:33-34` checks freshness

Validation commands all pass:
```bash
bash -n .github/workflows/scripts/swarm-post.sh && \
bash -n .github/workflows/scripts/swarm-prepare.sh && \
bash -n .github/workflows/scripts/swarm-verdict.sh && \
echo "All bash scripts parse OK"
# Output: All bash scripts parse OK

python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))" && \
python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))" && \
echo "YAML files parse OK"
# Output: YAML files parse OK
```

**The ONLY missing item:** README.md does not document `RELAY_WORKSPACE_KEY` or `CLOUD_API_KEY` secrets.

## Objective

Add documentation to README.md explaining the GitHub secrets required for the review-swarm workflow.

## Files in scope

- `README.md` — add secrets documentation section

## Work tasks

1. Add a "GitHub Actions Secrets" section to README.md documenting:
   - `RELAY_WORKSPACE_KEY` — workspace key for Agent Relay cloud runs
   - `CLOUD_API_KEY` — API key for cloud workflow invocation (scoped to `workflow:invoke:read` and `workflow:invoke:write`)
   - `CLOUD_API_URL` — (optional) Cloud API endpoint, defaults to `https://agentrelay.com/cloud`
   - Reference to where to obtain these credentials

2. Verify the documentation is accurate and actionable

## Definition of done

1. README.md contains a section documenting the three secrets used by `.github/workflows/review-swarm.yml`

2. The documentation explains:
   - What each secret is for
   - How to obtain them (or where to find instructions)
   - That these are GitHub repository secrets

3. All validation commands still pass:
```bash
bash -n .github/workflows/scripts/swarm-post.sh && \
bash -n .github/workflows/scripts/swarm-prepare.sh && \
bash -n .github/workflows/scripts/swarm-verdict.sh
```

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))" && \
python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))"
```

4. SDK tests show acceptable status (2 failed tests in live-kernel.test.ts are pre-existing, not introduced by this work):
```bash
cd packages/sdk && npm test
# Expected: 889 passed, 2 failed (json_schema verification gate mismatch + daemon race test)
```

5. As final action, in a normal git environment:
```bash
git status --porcelain
# Should show only README.md modified
```

## Explicitly OUT of scope

- `.github/workflows/review-swarm.yml` (all 9 requirements satisfied)
- `workflows/review-swarm.yaml` (correct)
- `.github/workflows/scripts/swarm-*.sh` (all three scripts correct, syntax valid)
- `.gitignore` (correct - no .review-target mask)
- `sdk/` tests (Track A; only verify they still pass)
- `kernel/` (gate 1 done, no changes)
- `ops/*` (chief owns briefs and state)
- Fixing the 2 SDK test failures (pre-existing, not gate 3 scope)
- Actually TESTING the workflow in CI (requires human to set secrets in GitHub repo settings)
