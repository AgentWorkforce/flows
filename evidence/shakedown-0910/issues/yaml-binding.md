## Summary

**BLOCKER for the requested declarative `llm → agent → deterministic` demo.** `dependsOn` orders steps, but the YAML surface has no input binding for passing a verified JSON value into a downstream instruction or deterministic command. The accepted step fields and kernel compilation expose no binding mechanism.

This is a missing authoring capability, not a claim that a particular template syntax is promised.

## Repro

The launch shakedown attempted a three-step YAML flow: `extract` declares a JSON `output` schema; `draft` depends on `extract`; `write` depends on `draft`. There is no documented value-reference field. An exploratory `input: {from: first}` is refused:

```
REFUSED [invalid_spec] Relayflow spec is invalid: spec.steps[1]: unknown key "input" (expected one of id | type | dependsOn | verification | maxIterations | memory | requirements | command | timeoutMs)
```

A provider-free control using a guessed `{{steps.first.output}}` string completes but writes that exact literal to its output file:

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

```
EXIT: 0
RUN 01M25TW2BTQ39XDNJPRN2RBA0B completed (2 steps) completionReason: success
FILE CONTENTS: {{steps.first.output}}
```

Again, the guessed braces syntax is not documented; this establishes that it is not an available workaround.

## Expected

A documented declarative binding reads a completed, verified upstream value, preserves its type, and supplies it to the next step without hand-written journal readers or shell files standing in for declared data flow.

## Suggested direction

Design input references at the authoring/protocol boundary with missing-reference preflight, explicit value selection, safe command argument transport, and durable provenance. Clarify how this composes with JSON Schema outputs and `dependsOn`. Avoid raw shell substitution of model output.

## Acceptance criteria

- A three-step YAML example passes verified `llm` JSON through an agent and writes a deterministic artifact.
- Missing step IDs/fields are refused before effects when statically knowable.
- Quotes, newlines, and shell metacharacters in upstream values remain data.
- Resume consumes the journaled output, with no duplicate upstream execution.
- Document and exercise the actual syntax through `flows run`.
