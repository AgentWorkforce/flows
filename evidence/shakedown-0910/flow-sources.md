# Shakedown flow sources

YAML schema version is `0.1.0`; v2 names the product/CLI generation.
These are evidence fixtures, not supported-example claims. The temporary-project copies avoid `testdata/flows.json`.

## agent-inline.flow.yaml

```yaml
version: "0.1.0"
name: agent-inline
agents:
  drafter:
    cli: claude
    model: claude-sonnet-4-6
steps:
  - id: draft
    type: agent
    agent: drafter
    instruction: Reply with exactly hello. Do not use tools or modify files.
    verification:
      type: output_contains
      value: hello
```

## chained.flow.yaml

```yaml
version: "0.1.0"
name: chained
agents:
  drafter:
    cli: claude
    model: claude-sonnet-4-6
steps:
  - id: extract
    type: llm
    cli: claude
    model: claude-sonnet-4-6
    prompt: 'Return only JSON: {"message":"hello"}'
    output:
      type: object
      required: [message]
      properties:
        message: {type: string}
      additionalProperties: false
  - id: draft
    type: agent
    agent: drafter
    dependsOn: [extract]
    instruction: 'Repeat the message from this JSON as plain text: {{steps.extract.output}}. Do not use tools or modify files.'
    verification:
      type: output_contains
      value: hello
  - id: write
    type: deterministic
    dependsOn: [draft]
    command: "printf '%s' '{{steps.draft.output}}' > shakedown-result.txt"
```

## deep-cwd.flow.yaml

```yaml
version: "0.1.0"
name: deep-cwd
steps:
  - id: hello
    type: deterministic
    command: printf hello
```

## error-dependency.flow.yaml

```yaml
version: "0.1.0"
name: error-dependency
steps:
  - id: broken
    type: deterministic
    dependsOn: [does-not-exist]
    command: printf hello
```

## error-path.flow.yaml

```yaml
version: "0.1.0"
name: error-path
steps:
  - id: broken
    type: agent
    cli: claudee
    instruction: Reply hello.
    verification:
      type: output_contains
      value: hello
```

## hello-world.flow.yaml

```yaml
version: "0.1.0"
name: hello-world
steps:
  - id: hello
    type: deterministic
    command: printf hello
```

## observer.flow.yaml

```yaml
version: "0.1.0"
name: observer
steps:
  - id: hello
    type: deterministic
    command: printf hello
```

## Supplemental agent-codex.flow.yaml

```yaml
version: "0.1.0"
name: agent-codex
steps:
  - id: draft
    type: agent
    cli: codex
    instruction: Reply with exactly hello. Do not use tools or modify files.
    verification: {type: output_contains, value: hello}
```

## Supplemental agent.flow.ts

```ts
import { flow } from '@relayflows/surface';
export default flow('agent', async (f) => {
  const answer = await f.agent('drafter', { task: 'Reply with exactly hello. Do not use tools or modify files.' });
  console.log(answer.summary);
  f.done('success');
});
```

## Supplemental binding.flow.yaml

```yaml
version: "0.1.0"
name: binding
steps:
  - id: first
    type: deterministic
    command: printf hello
  - id: second
    type: deterministic
    dependsOn: [first]
    command: "printf '%s' '{{steps.first.output}}' > binding-result.txt"
```

## Supplemental chained-codex.flow.yaml

```yaml
version: "0.1.0"
name: chained
steps:
  - id: extract
    type: llm
    cli: codex
    prompt: 'Return only JSON: {"message":"hello"}'
    output:
      type: object
      required: [message]
      properties:
        message: {type: string}
      additionalProperties: false
  - id: draft
    type: agent
    cli: codex
    dependsOn: [extract]
    instruction: 'Repeat the message from this JSON as plain text: {{steps.extract.output}}. Do not use tools or modify files.'
    verification:
      type: output_contains
      value: hello
  - id: write
    type: deterministic
    dependsOn: [draft]
    command: "printf '%s' '{{steps.draft.output}}' > shakedown-result.txt"
```

## Supplemental chained-llm.flow.ts

```ts
import { flow } from '@relayflows/surface';
export default flow('chained', async (f) => {
  const raw = await f.llm`Return only JSON: {"message":"hello"}`;
  const plan = JSON.parse(raw);
  const draft = await f.agent('drafter', { task: JSON.stringify(plan) });
  await f.run(`printf '%s' '${draft.summary}' > shakedown-result.txt`);
  f.done('success');
});
```
