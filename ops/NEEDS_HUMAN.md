# Review-swarm prerequisite

GitHub CLI is not authenticated in this environment, so the presence of the
`RELAY_WORKSPACE_KEY` Actions secret on `AgentWorkforce/flows` could not be
verified and the required live comment-posting test could not run. A repository
administrator must add the key from `~/.agentworkforce/relay/cloud-auth.json`
in the repository's Actions secrets if it is absent, then run:

```sh
gh secret list --repo AgentWorkforce/flows
bash .github/workflows/scripts/swarm-post.sh <completed-run-id> <pr-number>
```
