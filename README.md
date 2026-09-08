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
  const before = await f.run("npm test 2>&1; echo EXIT:$?");
  if (before.trim().endsWith("EXIT:0")) {
    f.done("success"); // already green, nothing to fix
    return;
  }

  await f.agent("fixer", {
    task: `The test suite is failing. Diagnose and fix it:\n${before}`,
    workspace: "src",
  });

  const after = await f.run("npm test 2>&1; echo EXIT:$?");
  if (!after.trim().endsWith("EXIT:0")) {
    throw new Error(`fixer did not get the suite green:\n${after}`);
  }
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


# Get Started

Install the CLI, then the authoring package in your own project:
```sh
npm install -g relayflows
mkdir my-flow && cd my-flow && npm install @relayflows/surface
```

Write a flow — save this as `explain-env.flow.ts`. It runs a deterministic step, then hands the result to a real coding agent:
```ts
import { flow } from "@relayflows/surface";

export default flow("explain-env", async (f) => {
  const versions = await f.run("node --version && npm --version");

  const result = await f.agent("explainer", {
    task: `Given this Node/npm version output, write one sentence noting anything\n`
      + `worth flagging (EOL, mismatch, etc):\n${versions}`,
    workspace: "src",
  });

  console.log(result.summary);
  f.done("success");
});
```

Tell `flows` which agent CLI to dispatch to by adding a `flows.json` next to it:
```json
{ "cli": "claude" }
```

Run it:
```sh
flows run explain-env.flow.ts --input '{}'
```

The `f.run` step always executes locally. The `f.agent` step needs a *worker* attached to run the agent — without one, `flows run` parks the run cleanly (`agent_parked`, exit code 3) instead of hanging, so you always get a clear diagnostic rather than a silent stall. Locally, workers are attached by the same process that's driving your agent session; in the cloud (below), a worker is always attached for you.

`f.llm`, `f.human`, and `f.dispatch` are still design surface, not yet runnable — see [`examples/`](examples/) for the full shape and each example's own README for what runs today.

## Running in the cloud

The same flow file runs unmodified on Agent Relay's hosted infrastructure via `agent-relay`, with a worker already attached:
```sh
agent-relay cloud run explain-env.flow.ts --file-type ts --relayflow-version v2 --sync-code
```

`agent-relay cloud schedule` can run a flow like this on a recurring schedule, turning it into a standing automation — a nightly dependency check, a daily digest, a recurring review pass — with the same observable, resumable run history you get locally.

Both paths are real and reachable today, but rolling out gradually: `--relayflow-version v2` admission for `cloud run` is being enabled account-by-account (a 503 `relayflow_v2_admission_disabled` means yours isn't flipped on yet), and `cloud schedule` currently only accepts `v1` for recurring runs — `v2` scheduling is on the way.
