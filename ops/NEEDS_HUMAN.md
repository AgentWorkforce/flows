# Gate 3 prerequisites needing a human

The current run cannot verify whether `RELAY_WORKSPACE_KEY` exists on
`AgentWorkforce/flows`: `gh secret list --repo AgentWorkforce/flows` reports
that GitHub CLI authentication is missing. A repository administrator must
verify or add that Actions secret from the workspace key stored on the laptop
at `~/.agentworkforce/relay/cloud-auth.json`.

The required posting dry run against an existing completed cloud run is also
blocked here: Agent Relay reports `Cloud login required`, and GitHub CLI has no
authentication with which to post a PR comment. Run
`.github/workflows/scripts/swarm-post.sh <completed-run-id> <pr-number>` from an
environment authenticated to both services and capture the resulting comment
URLs.
