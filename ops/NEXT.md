# NEXT — gate 3 work package: document review-swarm secrets in README

**Scope (from TARGET.md):**

Track D: Cloud review-swarm redesign — build `.github/workflows/review-swarm.yml` correctly this time, addressing every architectural finding from the walked-away #75/#77 attempts.

## Objective

Complete the final missing piece of gate 3's Definition of Done: document `RELAY_WORKSPACE_KEY` and `CLOUD_API_KEY` secrets in README.md with instructions on how to obtain them.

## Current state assessment

All 9 architectural requirements from TARGET.md are SATISFIED in the existing code:

1. ✅ Immutable gate — two checkout steps (`.github/workflows/review-swarm.yml:32-53`)
2. ✅ Unified verdict logic — `swarm-verdict.sh` sourced by both callers
3. ✅ Auth secret validation — preflight validates all three secrets (lines 141-188)
4. ✅ Sticky marker + transcripts — HTML anchors with upsert_comment
5. ✅ No author whitelist — verified absent
6. ✅ Cloud sandbox fetch on GHA runner — `swarm-prepare.sh` with GH_TOKEN
7. ✅ Timeout ordering — 60m < 65m < 75m with comments
8. ✅ Wait step records status — swarm_status output, always() post step
9. ✅ Transcript freshness — run-start marker with stale detection

Verification commands all pass:
```
bash -n .github/workflows/scripts/swarm-post.sh && \
bash -n .github/workflows/scripts/swarm-prepare.sh && \
bash -n .github/workflows/scripts/swarm-verdict.sh && \
echo "All bash scripts parse OK"
# Output: All bash scripts parse OK

python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))" && \
python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))" && \
echo "YAML files parse OK"
# Output: YAML files parse OK

grep -i "whitelist\|github.event.pull_request.user.login" .github/workflows/review-swarm.yml || echo "No author whitelist found (GOOD)"
# Output: No author whitelist found (GOOD)

grep -c "actions/checkout@v4" .github/workflows/review-swarm.yml
# Output: 2
```

**The gap:** TARGET.md Definition of Done item 6 requires:
> README.md — document `RELAY_WORKSPACE_KEY` secret + how to obtain

Current reality:
```
grep -c "RELAY_WORKSPACE_KEY\|CLOUD_API_KEY" README.md
# Output: 0
```

README.md does NOT document these secrets. The workflow comment (`.github/workflows/review-swarm.yml:21-24`) references a runbook in the `AgentWorkforce/cloud` repo, but README has no such documentation.

From `ops/NEEDS_HUMAN.md`, the secrets are stored and working (as of 2026-09-07), but gate 3 is blocked on Daytona CPU quota, not on implementation. The workflow WORKS; the documentation is missing.

## Files in scope

- `README.md` — add section documenting GitHub Actions secrets required for review-swarm

## Work package

Add a "GitHub Actions Secrets" section to README.md documenting:

1. `RELAY_WORKSPACE_KEY` — Agent Relay workspace key for review swarm communication
   - How to obtain: Contact repository administrator or see ops/NEEDS_HUMAN.md for historical context
   - Why required: Enables agent coordination within review swarm workflow

2. `CLOUD_API_KEY` — Agent Relay Cloud API credential for launching cloud workflows
   - How to obtain: Minted per `AgentWorkforce/cloud → docs/runbooks/relay-ci-workflow-credential.md`
   - Profile: `workflow-invoke`
   - Scopes: `workflow:invoke:read` and `workflow:invoke:write`
   - How to store: Repository Settings → Secrets and variables → Actions → New repository secret

3. `CLOUD_API_URL` — Cloud API endpoint (typically `https://agentrelay.com/cloud`)
   - Usually set as repository variable, not secret
   - Defaults to production endpoint if not set

The section should be brief (10-15 lines) and reference the workflow files for implementation details.

## Definition of done

1. README.md contains a section documenting the three secrets/variables
2. Each entry states what it is and how to obtain it
3. Parse checks continue to pass:
   ```
   bash -n .github/workflows/scripts/swarm-*.sh
   python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))"
   python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))"
   ```
4. Verification remains true:
   ```
   grep -c "RELAY_WORKSPACE_KEY\|CLOUD_API_KEY" README.md
   # Should return > 0
   grep -i "whitelist\|github.event.pull_request.user.login" .github/workflows/review-swarm.yml || echo "GOOD"
   # Should return "GOOD" or nothing (no whitelist)
   ```
5. As final action:
   ```
   git status --porcelain
   ```

## Explicitly OUT of scope

- `.github/workflows/review-swarm.yml` (already correct, all 9 requirements satisfied)
- `workflows/review-swarm.yaml` (already correct)
- `.github/workflows/scripts/swarm-*.sh` (all already correct)
- `.gitignore` (no .review-target mask exists, already correct)
- `sdk/` (Track A owns that)
- `kernel/` (gate 1 done)
- `ops/*` (chief owns briefs and state)
- Any other GHA workflow
- Resolving the Daytona CPU quota block (that's in ops/NEEDS_HUMAN.md, different issue)
- Actually testing the workflow end-to-end (blocked on Daytona capacity per ops/NEEDS_HUMAN.md)

## Why this is the work package

TARGET.md's Definition of Done explicitly lists:
- Item 6: "PR body explicitly documents each of the 9 requirements above and shows where each is satisfied"
- Item 7: "`README.md` — document `RELAY_WORKSPACE_KEY` secret + how to obtain"

The 9 requirements are satisfied in code. Item 7 is not satisfied. This is the remaining gap between current state and TARGET.md's done-when.
