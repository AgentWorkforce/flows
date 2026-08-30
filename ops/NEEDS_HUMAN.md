# NEEDS_HUMAN — gate 3 blocked on environment constraints

## The question

Can gate 3's `.github/workflows/review-swarm.yml` task be executed in an environment where:
1. No git repository is available (`.git` points to nonexistent `/home/daytona/.project-git`)
2. No GitHub CLI (`gh`) authentication exists
3. No `agent-relay` CLI is available to test against cloud runs
4. The definition of done requires: dry-run testing, git commits, and `git status --porcelain`

## The options

**Option A: Execute in a proper development environment**
- Move this task to a local/laptop environment with:
  - Full git repository access
  - GitHub CLI authenticated
  - `agent-relay` CLI installed
  - Ability to test against real cloud runs
- This satisfies the full definition of done from TARGET.md

**Option B: Deliver untested boilerplate here**
- Create `.github/workflows/review-swarm.yml` based on TARGET.md spec
- Document the RELAY_WORKSPACE_KEY requirement
- Mark it as "untested, requires verification"
- Accept that the dry-run requirement cannot be met

**Option C: This task already done**
- Check if PR #53's SDK agent worker (mentioned in TARGET.md as "shipped worker") already included the GitHub Actions integration
- Verify if `.github/workflows/review-swarm.yml` exists in the main repo but is absent from this worktree snapshot

## Prerequisites that cannot be verified

From TARGET.md §Prerequisites:

> `RELAY_WORKSPACE_KEY` must exist as a GitHub Actions secret on `AgentWorkforce/flows`. `gh secret list --repo AgentWorkforce/flows` will show if it's there.

**Cannot check** because `gh` is unavailable and this sandbox has no network to GitHub (ops/STATE.md Known environment faults #1, #3).

If the secret is missing:
- Human must add it from laptop at `~/.agentworkforce/relay/cloud-auth.json`
- This must be done in GitHub repo settings for `AgentWorkforce/flows`

## What I can deliver vs. what is required

### Can deliver without unblocking:
- ✅ `.github/workflows/review-swarm.yml` file content (untested)
- ✅ Documentation of the RELAY_WORKSPACE_KEY requirement
- ✅ Workflow logic for: trigger conditions, concurrency groups, steps 1-8 per TARGET.md

### Cannot deliver without unblocking:
- ❌ Dry-run test proving shell logic works (requires `agent-relay cloud run <id>`)
- ❌ Git commit of the work package (no git repo)
- ❌ `git status --porcelain` output (no git repo)
- ❌ Verification that RELAY_WORKSPACE_KEY exists
- ❌ Test that workflow's author filter works (need gh CLI to test expression)
- ❌ Confirmation that `actionlint` or `yamllint` passes

## Recommendation

Choose Option A. The charter's requirement to "COMMIT YOUR WORK PACKAGE BEFORE YOU FINISH" and TARGET.md's requirement for dry-run testing both indicate this task was designed for an environment with full development tooling, not a sandboxed cloud execution environment.

This assessment itself demonstrates the integrity constraint from the charter: "If genuinely blocked on a decision only a human can make, write ops/NEEDS_HUMAN.md with the exact question and the options — then still end with ASSESS_DONE."
