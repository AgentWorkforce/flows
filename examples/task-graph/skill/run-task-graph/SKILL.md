---
name: run-task-graph
description: Run a large engineering task as a graph of parallel coding agents on Agent Relay Cloud. Turns a Linear issue (with its sub-issues and "blocked by" relations) or a written spec into a dependency plan, runs every subtask as soon as the subtasks it depends on have merged, and pulls the integrated result back into this checkout. Use when the user wants to parallelize a big ticket, run a Linear issue's sub-issues with agents, or watch several agents make progress on one task.
---

# Run a task graph on Agent Relay Cloud

The flow is `task-graph.flow.ts` from github.com/AgentWorkforce/flows
(`examples/task-graph/`). What it does:

- Each subtask runs as its own Claude agent, in its own git worktree and on its own branch.
- A subtask starts only once every subtask it depends on has **merged** into the run's branch.
- An agent may report follow-up subtasks. Those join the graph while the run is going.
- When everything has merged, the repo's test suite runs once on the combined result.

Follow these steps in order. Do not skip step 3: the user should approve the graph before any agent starts.

## 1. Preflight (once per machine)

```sh
npm install -g relayflows          # provides the `flows` CLI
agent-relay cloud login            # or export FLOWS_CLOUD_TOKEN=<Cloud API token>
flows runs --limit 1               # proves the credential works
```

A `REFUSED [cloud_auth_missing]` or `[cloud_auth_rejected]` means the login step
did not work. Ask the user to redo it, and don't carry on until it succeeds.

Put the flow in a scratch directory outside the repo, and install its one
dependency there:

```sh
TG="${TMPDIR:-/tmp}/task-graph" && mkdir -p "$TG" && cd "$TG"
curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/flows/main/examples/task-graph/task-graph.flow.ts -o task-graph.flow.ts
npm init -y >/dev/null && npm pkg set type=module && npm install --no-audit --no-fund @relayflows/surface
```

## 2. Build `plan.json`

The input shape is:

```json
{
  "task": { "title": "…", "body": "…", "url": "…" },
  "maxParallel": 4,
  "maxFollowups": 3,
  "testCommand": "npm ci && npm test",
  "plan": { "subtasks": [
    { "id": "schema", "title": "…", "detail": "what done means", "dependsOn": [] },
    { "id": "api",    "title": "…", "detail": "…", "dependsOn": ["schema"] }
  ] }
}
```

**From a Linear issue.** Use the Linear MCP/API to read the parent issue, its
sub-issues, and each sub-issue's relations. Then map them into the plan:

- `task` comes from the parent issue: its title, its description as `body`, and its `url`.
- Each sub-issue becomes one subtask:
  - `id` is the lowercased identifier, e.g. `ENG-142` → `eng-142`.
  - `title` is the sub-issue's title.
  - `detail` is its description plus its acceptance criteria.
- `dependsOn` comes from "blocked by" relations, but only between sibling
  sub-issues. Drop blockers that are outside the parent issue.
- Skip sub-issues that are already Done or Canceled.
- If a sub-issue has sub-issues of its own, flatten them into the plan. The
  child depends on whatever its parent depends on.

**No sub-issues, or a written spec instead of Linear.** Write the plan yourself. Read the repository
and split the task into subtasks that each fit one focused agent session. Always pass `plan`, so the
user approves the real graph in step 3. If you leave `plan` out, the flow's own planner writes the graph
and it starts running with nobody approving it. That is only for hands-off mode, below.

Rules. The flow refuses a plan that breaks any of these, so check them before submitting:

- `id` matches `^[a-z0-9][a-z0-9-]{0,39}$` and is unique.
- Every `dependsOn` entry names another subtask in the plan.
- There are no cycles.
- There are at most 20 subtasks.
- `maxParallel` is between 1 and 8.
- `maxFollowups` is between 0 and 10. Use 0 when the user wants exactly the plan and nothing more.
- Set `testCommand` to the command that tests this repository. You can leave it out only when
  `package.json` has a `test` script. Without either, the flow stops before testing and doesn't
  pass by default.

Only list a dependency when a subtask needs the other's **code merged**
first. Every dependency you add removes some parallelism.

## 3. Show the graph and get a yes

Print the plan as waves:

- Wave 1 is the subtasks with no dependencies.
- Wave 2 is the subtasks whose dependencies are all in wave 1.
- Continue the same way until every subtask has a wave.

```
wave 1: schema, email-template            (parallel)
wave 2: api-create, api-accept            (parallel)
wave 3: api-revoke
wave 4: ui-invite, ui-accept              (parallel)
```

Tell the user the working tree will be uploaded. Uploads respect `.gitignore`,
untracked files are included, and `.git` and `node_modules` never are. Then ask
for confirmation. Nothing has run until they say yes.

## 4. Submit

Run this from the root of the user's repository:

```sh
flows check "$TG/task-graph.flow.ts"
flows run --cloud --sync-code "$TG/task-graph.flow.ts" --input plan.json
```

It prints the run id. Give the user the live view:
`https://agentrelay.com/cloud/dashboard/workflow/<run-id>`

## 5. Watch

```sh
flows status --cloud <run-id>                 # every step: state, timing, gate verdict, cost
flows logs <run-id> --step <step-name>        # one agent's transcript
```

Poll `flows status --cloud` every few minutes and report changes in terms of the
plan's subtask ids. Say which subtasks are running, which have merged, and
which follow-ups have appeared.

A failed step means one of two things:

- a subtask's gate failed: the agent produced no commit, or no result file; or
- a merge could not be resolved.

For either one, show that step's `flows logs` and ask the user how to proceed.
Do not rerun the whole flow unasked.

## 6. Bring the result home

When the run completes, run this from the same repository:

```sh
flows sync <run-id> --dry-run     # what would change
flows sync <run-id>               # apply it, uncommitted
git diff --stat
```

Walk the user through the diff before committing. It is agent output. If the
plan came from Linear, offer to move the merged sub-issues to Done.

## Hands-off mode

To have every new ticket in a Linear team planned and run automatically, with
one PR per ticket:

```sh
flows deploy "$TG/task-graph.flow.ts" --repo <owner/name> --on linear:team=<KEY> --approver <github-user>
```

A ticket-triggered run receives the ticket as `issue` and uses the planner.
It pushes the run's branch and opens one pull request, with each subtask's
summary in the PR body.
