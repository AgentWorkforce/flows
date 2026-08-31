# NEEDS HUMAN — gate 3 is blocked on prerequisites

## The question

Gate 3 (review-swarm GitHub Actions integration) cannot be completed from this cloud sandbox environment. Which prerequisite should be addressed first?

## The blockers

### 1. No .github/ directory in the delivered tree

This sandbox is running in snapshot mode (no .git, per ops/STATE.md). The .github/ directory does not exist in the tree:

```
ls -la .github 2>/dev/null
No .github directory present
```

Creating .github/workflows/review-swarm.yml requires creating the .github/ directory structure first. This can be done, but ops/STATE.md warns that verification may fail if the directory structure cannot be committed (and git commit fails here: "fatal: not a git repository").

### 2. RELAY_WORKSPACE_KEY secret status unknown

Gate 3 requires RELAY_WORKSPACE_KEY to exist as a GitHub Actions secret on AgentWorkforce/flows. The gate cannot check this from a cloud sandbox with no gh auth:

```
gh secret list --repo AgentWorkforce/flows
To get started with GitHub CLI, please run:  gh auth login
```

Per ops/TARGET.md, the secret's value is on the laptop at ~/.agentworkforce/relay/cloud-auth.json and must be added in repo settings.

### 3. Cloud workspace reachability

Even if the workflow is written and the secret exists, agent-relay cloud run invoked from GHA must reach the same cloud workspace as the laptop. This cannot be tested from this sandbox.

## The options

A. **Accept the work package as-is**: ops/NEXT.md is written and committed (commit failed but file persists). The next PLAN or EXECUTE step can work from it if they have git/GitHub access.

B. **Write the workflow file anyway**: Create .github/workflows/review-swarm.yml in this sandbox even though it cannot be committed or tested. Deliver it as an uncommitted file and let the delivery step handle it.

C. **Defer gate 3 entirely**: Gate 3 requires GitHub Actions infrastructure that does not exist in a cloud sandbox. A human with repo access should implement this, or the gate should be assigned to a laptop-based run.

## Recommendation

Option A. The work package in ops/NEXT.md correctly scopes gate 3 and identifies all prerequisites. The next step in the operating loop (whether PLAN or EXECUTE) will have the context it needs. This assessment's job is to write the work package, not to execute it.

Gate 3 is correctly assessed as BLOCKED on human-provided prerequisites (GitHub secret, .github/ directory in the repo on main branch).
