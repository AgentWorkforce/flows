# NEEDS_HUMAN — gate 3 work package is blocked on repository administrator action

## The block

ops/NEXT.md documents that **gate 3 is blocked on a repository administrator creating a GitHub Actions secret**. The Relayflow Lead cannot do this work because:

1. **RFC-0001 decision #6 and charter hard rail #2:** The Lead cannot edit gates that judge its work. `.github/workflows/review-swarm.yml` is such a gate.

2. **The credential requires repository admin privileges:** Per ops/NEXT.md, minting the `CLOUD_API_KEY` credential requires following `AgentWorkforce/cloud` → `docs/runbooks/relay-ci-workflow-credential.md`, and **storing it as a GitHub Actions secret requires repository administrator access** (explicitly noted in the runbook).

3. **The preflight validation requires editing the gate file:** ops/NEXT.md §"What to do" step 4 requires adding `CLOUD_API_KEY` validation to the `Validate cloud authentication` step in `.github/workflows/review-swarm.yml`. This is the immutable gate file.

## Evidence the work is blocked

From ops/NEXT.md:
```
**The Relayflow Lead cannot do this one.** RFC-0001 decision #6 and the
charter's second hard rail: it cannot edit the gates that judge its work.
```

The ops/NEXT.md file already exists and explicitly identifies this as human-blocked work.

## What the human needs to do

From ops/NEXT.md §"What to do":

1. **Mint the credential** using `AgentWorkforce/cloud` → `docs/runbooks/relay-ci-workflow-credential.md`, profile `CI_TOKEN_PROFILE=workflow-invoke`
2. **Store it as a GitHub Actions secret** (requires repository administrator)
3. **Add to `.github/workflows/review-swarm.yml`** on the `Launch cloud swarm` step: `CLOUD_API_KEY: ${{ secrets.CLOUD_API_KEY }}`
4. **Fix the preflight** in `Validate cloud authentication` to assert both `CLOUD_API_URL` and `CLOUD_API_KEY` are non-empty

## Definition of done (from ops/NEXT.md)

1. A review-swarm run reaches a step after `Launch cloud swarm` — the first non-zero success in this workflow's history
2. Literal step list showing `Launch cloud swarm` succeeded

## Options

This is not a choice — there is only one path forward:

**Option 1 (required):** A human with repository administrator privileges mints the credential per the runbook, stores it as a GitHub Actions secret, and adds the two `env:` lines to `.github/workflows/review-swarm.yml`.

No other option can unblock gate 3. The credential cannot be minted or stored by an agent, and the gate file is outside the Lead's write scope.
