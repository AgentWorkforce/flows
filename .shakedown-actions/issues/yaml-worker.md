## Summary

**High launch friction.** `flows run agent.flow.yaml` with an installed/authenticated CLI creates a parked run because no worker is attached. The obvious remediation, `--local-agent`, is rejected for YAML. The message gives no command for attaching a worker. The same real Codex installation succeeds through a TypeScript `f.agent` plus `--local-agent`.

The agent-only use case is workaroundable through authored TypeScript: a real `f.agent` with `--local-agent` and `flows.json` containing `{"cli":"codex"}` completed successfully in 5.476s. This is HIGH friction for YAML, not by itself a launch BLOCKER; the separate missing `f.llm` path still blocks the flagship chain in TS.

## Repro

Outside any `flows.json` ancestry:

```yaml
version: "0.1.0"
name: agent
steps:
  - id: draft
    type: agent
    cli: codex
    instruction: Reply with exactly hello. Do not use tools or modify files.
    verification: {type: output_contains, value: hello}
```

```sh
flows run agent.flow.yaml --data-dir /tmp/yaml-agent-fresh
flows run agent.flow.yaml --local-agent --data-dir /tmp/yaml-agent-fresh-2
```

Captured first command:

```
EXIT: 3
RUN 01M25TMMAW07DKQCQBTTZVGZ8P parked (0 steps)
PARKED [run_parked] Run "01M25TMMAW07DKQCQBTTZVGZ8P" parked at step "draft" (agent): no worker is attached for step type "agent".
```

Second command exits 2 with `REFUSED [invalid_invocation] Usage: ...`.

## Expected

A first-time YAML author has a documented, supported way to run their agent locally, including stream/workspace capability requirements. Missing-worker diagnostics name that next command.

## Suggested direction

Extend the existing local agent path to declarative specs with explicit surface handling, or expose a supported worker command and document the complete run/attach/resume sequence. Do not fabricate workspace pins or silently discard declared permissions to make a run proceed.

## Acceptance criteria

- A fresh YAML agent flow executes through a documented CLI-only sequence with a real CLI.
- Missing-worker output supplies an actionable command.
- Unsupported workspace/permission combinations fail closed.
- Auth and model preflight still happen before agent execution.
