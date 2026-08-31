# Review-swarm credentials required

The current environment is not authenticated to GitHub, so it cannot verify
that `RELAY_WORKSPACE_KEY` exists in the `AgentWorkforce/flows` repository or
post the definition-of-done test comments. A repository administrator must add
the canonical workspace key as that Actions secret if it is absent.

Agent Relay cloud authentication is also unavailable here: the CLI requests
device authorization instead of reaching the laptop's canonical workspace. A
human must authorize the environment and confirm that a cloud run launched with
the repository secret reaches that same workspace.
