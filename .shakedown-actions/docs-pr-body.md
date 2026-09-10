The surface docs still say all models require a project registry, contradicting #266. Document the actual split: inline named-agent models reach the live readiness probe when no `flows.json` exists, while direct step models still need an allowlist; an existing config still enforces its policy.

Validated against `preflight.ts:180` and two actual `flows run` outcomes from the launch shakedown (both outside any config ancestry):

```text
agent-inline.flow.yaml: EXIT 2
REFUSED [cli_unauthenticated] Step "draft" declares CLI "claude", but "claude auth status" exited non-zero; authenticate it or repair that adapter's authentication probe.

chained.flow.yaml with model directly on llm step: EXIT 2
REFUSED [model_unknown] Step "extract" declares model "claude-sonnet-4-6" for CLI "claude", but it is not listed in the nearest project config (no model registry was found); add the exact model only after verifying that project is allowed to use it.
```

A forward-only PATH shim captured the real inline-model probe before the auth refusal:

```text
auth status --help
-p --model claude-sonnet-4-6 --tools  --no-session-persistence Reply with exactly RELAYFLOWS_MODEL_READY and nothing else.
auth status
```

`git diff --check` exited 0 with no output. Documentation-only change.
