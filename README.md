# relay(Flows)

**Stop babysitting agents. Script them.**

Define complex sequences of tasks for agents instead of hoping they follow the rules in your prompt.
Predictable, auditable, and dependable.

```ts
import { flow } from '@relayflows/surface';

export default flow('hello', async (f) => {
  const greeting = await f.run('echo "Hello from Relayflows"');
  console.log(greeting.trim());
  const answer = await f.agent('greeter', {
    task: 'Reply with one short hello sentence. Do not use tools or modify files.',
  });
  console.log(answer.summary);
  f.done('success');
});
```

# What Can You Do With This?

Every flow below is a single `.flow.ts` file. Run it from a checkout, or deploy it to
[Agent Relay Cloud](https://agentrelay.com/cloud) where it listens for tickets, PRs, or a
schedule and every run is observable and replayable.

- **Automations:** on a schedule, iterate over all the issues in your repo, decide which are stale
  or need attention, and send a Slack digest — [`examples/stale-issues/`](examples/stale-issues/)

```bash
flows schedule examples/stale-issues/stale-issues.flow.ts \
  --cron "0 9 * * 1-5" --tz Europe/Oslo \
  --input '{"repo":"acme/api","channel":"#eng","staleDays":14}'
```

- **Review:** when a PR is opened, three agents review it from three perspectives — security,
  correctness, performance — and a fourth reconciles their findings —
  [`examples/pr-review-pipeline/`](examples/pr-review-pipeline/)

```bash
flows deploy examples/pr-review-pipeline/pr-review-pipeline.flow.ts \
  --repo acme/api --on github:events=pull_request --approver you
```

[![Deploy to Cloud](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/flows/deploy?flow=https://github.com/AgentWorkforce/flows/blob/main/examples/pr-review-pipeline/pr-review-pipeline.flow.ts&on=github:events=pull_request)

- **Software Factory:** an issue in Linear kicks off an implementation agent, a deterministic test
  run, an adversarial review agent, and finishes with a pull request opened for you —
  [`examples/software-factory/`](examples/software-factory/)

```bash
flows deploy examples/software-factory/software-factory.flow.ts \
  --repo acme/api --on linear:team=ENG --approver you
```

[![Deploy to Cloud](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/flows/deploy?flow=https://github.com/AgentWorkforce/flows/blob/main/examples/software-factory/software-factory.flow.ts&on=linear)

`--on` takes `github`, `linear`, `jira`, `shortcut` or `slack` with optional filters
(`github:labels=agent`, `jira:project=OPS`, `slack:channel=#eng`). `flows deployments` lists what is
listening; `flows undeploy <id>` stops it. Sign in once with `agent-relay cloud login`.

# How Can I Run It?

A flow can be run locally or in the cloud. If run in the cloud it can run on a schedule, or via a trigger, or ad hoc. It can
run using your LLM subscription or using an API key.

Install:
```bash
npm install -g relayflows
npm install --save-dev @relayflows/surface
```

Try on the cloud right now: [https://agentrelay.com/flows](https://agentrelay.com/flows)
