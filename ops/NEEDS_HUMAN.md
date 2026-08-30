# Gate 3 prerequisites

This environment cannot authenticate to either service needed for the required live dry run:

- `gh auth status` reports that no GitHub host is authenticated, so it cannot verify the `RELAY_WORKSPACE_KEY` secret or post PR comments. Authenticate `gh` with access to `AgentWorkforce/flows`, then ensure the repository secret exists using the workspace key from `~/.agentworkforce/relay/cloud-auth.json` on the laptop.
- `agent-relay cloud status 404a8386-a129-40b0-9e5b-8ec9ad433038 --json` starts device authorization and does not complete. Authenticate this machine to the existing cloud workspace; do not substitute another endpoint or token.

The checkout metadata is also incomplete: `.git` points to `/home/daytona/.project-git`, which does not exist. Restore that Git directory before running the required final `git status --porcelain`.
