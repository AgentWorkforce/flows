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


# Get Started

Install the CLI, then the authoring package in your own project:
```sh
npm install -g relayflows
mkdir my-flow && cd my-flow && npm install @relayflows/surface
```

Write a flow — save this as `hello.flow.ts`:
```ts
import { flow } from "@relayflows/surface";

export default flow("hello", async (f) => {
  await f.run('echo "hello from a relayflow"');
  f.done("success");
});
```

Run it:
```sh
flows run hello.flow.ts --input '{}'
```

That's the whole loop — `flows run` spins up the local kernel itself on first use, no separate daemon step. You should see a completed run report.

`f.run` and `f.agent` both actually dispatch today. `f.agent` runs a real coding-agent CLI the same way a declarative `type: agent` step does — it needs a `flows.json` in your project declaring which CLI to use (see `docs/SURFACE.md` §5 and `packages/sdk/src/cli/check.ts`'s `readProjectConfig`); without one, `flows run` refuses with a clear `agent_cli_unresolved` diagnostic rather than hanging. `f.llm`, `f.human`, `f.dispatch`, and `f.cloud` are still `docs/SURFACE.md`'s design surface, not yet runnable — see [`examples/`](examples/) for what the full shape looks like, and each example's own README for exactly what runs today versus what's still landing.

Give your agent a skill to write a flow:
```sh
npx skills add https://github.com/agentworkforce/skills --skill writing-relayflows
```
