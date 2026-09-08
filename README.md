# relay(Flows)

**Step functions for coding agent workflows**

Agent Relay is building infrastructure for autonomous agents. A relayflow is a readable step function
that runs on the relay and produces a verifiable artifact or result that can be paused
for human input and resumed from any step wherever needed. It is an agentic pipeline
that can load in any model + harness along with deterministic gates to generate
reliable results.


```ts
import { flow } from "@relayflows/surface";

export default flow("fix-failing-tests", async (f) => {
  const result = await f
    .run("npm test 2>&1; echo EXIT:$?")
    .gate((out) => !out.includes("EXIT:0"), "tests are already green, nothing to fix");

  const fix = await f
    .agent("fixer", {
      task: `The test suite is failing. Diagnose and fix it:\n${result}`,
      workspace: "src/**: readwrite",
    })
    .gate((r) => r.artifacts.length > 0, "the agent must actually change something");

  f.done("success");
});
```

# Use Cases

Flows can be run locally or in production on our hosted cloud. We're built entire 
applications using flows that are stacked to run in a sequence with review gates that
can run autonomously over days and weeks. Every agent session is observable and replayable.

- Cloud pipeline to use agents to generate a social media post. The pipeline coordinates agents who do research, verify the post, check for authenticity, generate graphics, and gate on a human approval — [`examples/social-post-pipeline/`](examples/social-post-pipeline/)
- Pull request review pipeline with different agents looking at the pull request from different angles (security, optimization etc) and agents communicate when needed to reach consensus — [`examples/pr-review-pipeline/`](examples/pr-review-pipeline/)
- Dependency upgrade bot: deterministic check flags a dependency out of date which fires an agent who does the upgrade in a sandbox. This upgrade is gated on another agent verifying the entire application with computer use in another sandbox. If completely verified a pull request is opened up — [`examples/dependency-upgrade-bot/`](examples/dependency-upgrade-bot/)

## Cloud review swarm

Every pull request launches the cloud review swarm. Repository administrators
must configure two Actions secrets. The workflow fails during preflight, in
seconds and before submitting a run, when either is absent.

| Secret | What it is | How to obtain it |
|---|---|---|
| `RELAY_WORKSPACE_KEY` | Selects the messaging workspace the swarm runs in. | `agent-relay workspace key --reveal-secrets` |
| `CLOUD_API_KEY` | The Cloud API key for workflow invocation. | Follow `AgentWorkforce/cloud` → `docs/runbooks/relay-ci-workflow-credential.md`, profile `workflow-invoke` |

`CLOUD_API_URL` is not secret; the workflow defaults it and it can be
overridden with a repository variable of the same name.

A workspace key alone cannot run the swarm. `agent-relay cloud run` authenticates
to the Cloud API using `CLOUD_API_KEY`: the workspace key is read only by the
resolver that picks a messaging workspace, while the API key authenticates
`POST /api/v1/workflows/prepare` — which `--sync-code` requires, and `--sync-code`
is how the swarm receives the PR diff. Given no API key, the CLI falls back to an
interactive device login that no runner can approve and exits after the grant expires.

# Get Started

Installation:
```
npm install -g relayflows
```

Give your agent a skill to write a flow:
```
npx skills add https://github.com/agentworkforce/skills --skill writing-relayflows
```
