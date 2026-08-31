# Human action required

Can a repository administrator confirm that the `RELAY_WORKSPACE_KEY` Actions
secret exists on `AgentWorkforce/flows`, and provide an authenticated `gh`
session (or rerun this work package in one) so the required check and real PR
comment dry run can be completed?

The required check could not authenticate:

```text
$ gh secret list --repo AgentWorkforce/flows
To get started with GitHub CLI, please run:  gh auth login
Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.
```
