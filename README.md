# relay(Flows)

**Turn a coding-agent task into steps you can inspect and verify.**

A flow combines shell commands and coding agents with a journal that records
what each step did and why it completed. Start with a small local flow; add
verification as the task grows.

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

The new scaffolder in this branch creates the flow, `flows.json`, and an npm
project, then installs its dependencies:

```sh
npx create-flow@latest my-flow
cd my-flow
npm start
```

**Release status:** `create-flow` is not published yet. The commands above are
the intended released entry point; use the [candidate artifact procedure](docs/evidence/ws13/README.md)
to try this branch. A clean-machine first-agent run under 60 seconds has not
been established.

The agent starter requires Node 22.18+ and an installed, authenticated Claude
CLI. Use `--cli codex` to select Codex, or `--template deterministic` for a
starter that needs no model credentials. The generated command is
`flows run my-flow.flow.ts --local-agent --input '{}'`.

`--local-agent` attaches the existing SDK agent worker to the local daemon.
It accepts stream-only agent steps and runs the chosen CLI with its existing
local access. Workspace revision pins and isolation require a worker that
provides those capabilities. Authored TypeScript bodies are not yet durably
resumable as a whole; each lowered step has its own journal run.

For SDK callers, the CLI is optional:

```ts
import { createFlow, renderProgress } from '@relayflows/sdk';

await createFlow('./my-flow', { cli: 'claude' });
// renderProgress(events) returns terminal lines; callers own event delivery.
```

See the [example gallery and individual run results](examples/README.md).
The larger examples currently refuse or time out; their intended budgets,
artifact gates, workspace restrictions, and human approvals are preserved.

Give your agent a skill to write a flow:

```sh
npx skills add https://github.com/agentworkforce/skills --skill writing-relayflows
```
