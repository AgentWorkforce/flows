## Summary

**BLOCKER for the 2026-09-11 launch's requested `llm → agent → deterministic` demo.** With a real authenticated Codex CLI, declarative YAML parks at its first `llm` step with no worker; authored TypeScript with `--local-agent` reports `unsupported_verb` for `f.llm`. A standalone TypeScript `f.agent` using the same installation succeeds, so this is not a missing provider login.

Observed against main `a42ca16` composed with #268 `33c460a` and #269 `f3dc7ce`, on macOS arm64 / Node 25.8.1.

## Repro

Build kernel and SDK, then run this file outside any `flows.json` ancestry with a fresh data directory and an authenticated `codex` on PATH:

```yaml
version: "0.1.0"
name: llm-first
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
```

```sh
node packages/sdk/dist/cli.js run /tmp/llm-first.flow.yaml --data-dir /tmp/llm-first-fresh
```

Captured from the three-step variant:

```
EXIT: 3
RUN 01M25TMMN68GZPYJ7JK85CSH2B parked (0 steps)
PARKED [run_parked] Run "01M25TMMN68GZPYJ7JK85CSH2B" parked at step "extract" (llm): no worker is attached for step type "llm".
```

Trying the imperative path (`await f.llm(...)`) with installed `@relayflows/surface` and `flows run chained.flow.ts --local-agent --input '{}'` instead gives:

```
EXIT: 1
FAILED [protocol_error] relayflowd could not complete the run request: unsupported_verb: the initial authored executor does not lower f.llm
```

## Expected

The supported local CLI can execute a real `llm` request, validate its JSON output, and advance through the advertised three-step chain. If a worker must be started separately, ship and document the exact supported command and refuse before creating a run when a required executor is absent (RFC-0001 covenant 2).

## Suggested direction

Implement authored `f.llm` lowering and a real local LLM worker/runner path using existing kernel `llm` dispatch and typed completion. Cover the declarative entry point as well. Do not disguise this as `agent` or remove the typed gate to get a green demo.

## Acceptance criteria

- A documented local command runs `llm → agent → deterministic` with real provider output and a fresh data directory.
- Invalid JSON and schema mismatch fail with a typed completion reason.
- The deterministic final step consumes verified upstream data and writes the expected artifact.
- Missing runtime capabilities are reported before run submission with a concrete remediation command.
- Capture a real-provider CLI transcript; a stubbed worker alone is not acceptance evidence.
