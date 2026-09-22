# task-graph

One big engineering task, about a day of work, runs as a graph of parallel coding agents.

Most multi-agent setups work through subtasks one at a time. That's how "seven subtasks" turns into a
week. This flow takes a plan in which each subtask lists the subtasks it depends on (`dependsOn`), then:

- Each subtask starts **the moment** every subtask it depends on has **merged**.
- Each subtask runs in its own git worktree, on its own branch, as its own Claude agent.
- A finished subtask merges back into the run's branch. If the merge conflicts, a dedicated agent
  resolves it, and a gate checks that the subtask's branch really is merged.
- A planned subtask can report **follow-up subtasks** that the task can't ship without. They join the graph
  mid-run, up to `maxFollowups` (default 3, `0` turns them off). Follow-ups can't spawn follow-ups of their
  own. Without these limits, agents keep filing polish and docs follow-ups: a 4-subtask test run grew to 20.
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

- **Needs the next `relayflows` release.** Running agents at the same time and `f.agent({ cwd })` both land
  in the SDK and kernel fix that follows 2.0.26. On 2.0.26, a second concurrent agent is set aside ("parked")
  and `cwd` is refused.
- **No budget header.** A budgeted authored flow currently admits one step at a time
  (`packages/sdk/src/authored-budget.ts`), which would serialize the whole graph. Until that is fixed,
  cap spend with `maxParallel` (default 4, maximum 8) and the 20-subtask ceiling.
- **Cloud labels each step by its position in the run, not by subtask, for now.** Until flows#553 and
  cloud#3945 ship, the Cloud run page shows `agent-4`, `run-7`, and so on, with no edges. With them, it shows
  each subtask's name and the edges between subtasks, but only once the run finishes. While the run is going,
  nodes show live status without names or edges.
- **Resume is untested.** With subtasks running concurrently, the order of step calls depends on timing.
  Resuming this flow after a runner crash has not been tested.
