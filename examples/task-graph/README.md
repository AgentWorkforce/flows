# task-graph

One big engineering task, about a day of work, runs as a graph of parallel coding agents.

Most multi-agent setups work through subtasks one at a time. That's how "seven subtasks" turns into a
week. This flow takes a plan in which each subtask lists the subtasks it depends on (`dependsOn`), then:

- Each subtask starts **the moment** every subtask it depends on has **merged**.
- Each subtask runs in its own git worktree, on its own branch, as its own Claude agent.
- A finished subtask merges back into the run's branch. If the merge conflicts, a dedicated agent
  resolves it, and a gate checks that the subtask's branch really is merged.
- A subtask can report **follow-up subtasks**. They join the graph mid-run.
- Once everything has merged, the repository's tests run once, outside any agent, on the combined result.

A subtask counts as done only when it has **a commit on its branch and a result file**. An agent saying
"done" isn't enough.

## Run it

```sh
npm install -g relayflows && agent-relay cloud login
npm install @relayflows/surface          # next to the flow file

# from the repository the work should happen in
flows run --cloud --sync-code task-graph.flow.ts --input example-plan.json
flows status --cloud <run-id>            # or https://agentrelay.com/cloud/dashboard/workflow/<run-id>
flows sync <run-id>                      # the integrated result lands uncommitted in your checkout
```

`example-plan.json` is a 7-subtask "team invitations" feature. It has three parallel waves and a join.
Leave out `plan` and a planner agent reads the repository and writes the graph itself.

To have every new Linear ticket planned and run automatically, with one PR per ticket:

```sh
flows deploy task-graph.flow.ts --repo acme/api --on linear:team=ENG --approver you
```

Locally, from a checkout that has a `flows.json` naming the agent CLI:

```sh
flows run task-graph.flow.ts --local-agent --input example-plan.json
```

## Give it to your agent

`skill/run-task-graph/SKILL.md` is a Claude Code skill. Copy it to `~/.claude/skills/run-task-graph/`
(or to `.claude/skills/` in your repository). Your agent can then:

1. read a Linear issue with its sub-issues and "blocked by" relations;
2. build the plan and show you the parallel waves before anything runs;
3. submit the run to Cloud, report progress, and bring the result back with `flows sync`.

## Limits today

- **Only one agent at a time — this blocks the parallel part.** `flows run --local-agent` attaches one
  agent worker with `capacity: 1` (`packages/sdk/src/local-agent.ts`). Cloud's hosted runner uses the
  same flag. A second agent that becomes ready while the first is running doesn't wait: it **parks**
  with "no worker is attached for step type agent", and the run exits parked (exit 3). Until the worker
  can run several agents at once, use `maxParallel: 1`.
- **`f.agent({ cwd })` is refused.** The SDK passes `cwd` in the step spec, but the kernel's `StepSpec`
  has no such field (`invalid_spec: unknown field "cwd"`). So each agent is told its worktree path in
  its task instead.
- **No budget header.** A budgeted authored flow currently admits one step at a time
  (`packages/sdk/src/authored-budget.ts`), which would serialize the whole graph. Until that is fixed,
  cap spend with `maxParallel` (default 4, maximum 8) and the 20-subtask ceiling.
- **Cloud labels each step by its position in the run, not by subtask.** The run page and
  `flows status --cloud` show `agent-4`, `run-7`, and so on, not `api-create`. The Cloud run graph also
  has no edges for TypeScript flows: it recovers dependencies only from YAML definitions.
- **Resume is untested.** With subtasks running concurrently, the order of step calls depends on timing.
  Resuming this flow after a runner crash has not been tested.
