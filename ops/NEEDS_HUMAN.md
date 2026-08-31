# Gate 3 needs human setup

The current environment is not authenticated to GitHub (`gh auth status` reports
no logged-in hosts), so it cannot verify or create the required
`RELAY_WORKSPACE_KEY` Actions secret on `AgentWorkforce/flows`, nor can it run
the definition-of-done posting command against a real pull request. A repository
administrator must add the secret if absent and run the live posting check from
an environment authenticated to that repository.
