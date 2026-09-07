# flows

**We are taking prompting and making it reliable, with natural rails and gates.**

This is the clean-slate build of Relayflows: a durable execution engine that is
competitive with Temporal and Inngest and agentic-leading where they are
structurally blind. A Relayflow is a deterministic script that composes agentic
primitives — an LLM call, an agent, a virtual filesystem, memory, identity,
authorization — into anything from a one-shot pipeline to a resident harness to
an entire application.

The constitution is [`docs/RFC-0001-everything-is-a-relayflow.md`](docs/RFC-0001-everything-is-a-relayflow.md).
Nothing in this repo may contradict it; changing it is a human decision.

## Layout

```
kernel/     relayflowd — Rust. Journal, scheduler, leases, timers, streams. One binary.
packages/sdk/        TypeScript-first authoring SDK. Compiles specs; speaks the journal protocol.
packages/surface/    @relayflows/surface — the TypeScript flow-authoring contract.
workflows/  The gates. Each gate is a relayflow; the build is orchestrated by relayflows.
docs/       RFC-0001 and design docs.
charter/    The Relayflow Lead.
```

## Method

The rewrite is a program *of* relayflows: every capability ships as a relayflow,
and its acceptance gate is that it supports the real use case it exists for.
Nine gates, in `docs/RFC-0001` §3. Gate 1 first: a relayflow can run — the hello
ladder survives `kill -9` at every boundary.

Private while we build. YC 2026-09-15 runs on this base.

## Cloud review swarm

Every pull request launches the cloud review swarm. Repository administrators
must configure two Actions secrets. The workflow fails during preflight, in
seconds and before submitting a run, when either is absent.

| Secret | What it is | How to obtain it |
|---|---|---|
| `RELAY_WORKSPACE_KEY` | Selects the messaging workspace the swarm runs in. | `agent-relay workspace key --reveal-secrets` |
| `CLOUD_API_KEY` | The Cloud API key for workflow invocation. | Mint via `AgentWorkforce/cloud` → `docs/runbooks/relay-ci-workflow-credential.md`, profile `workflow-invoke`, scoped to `workflow:invoke:read` and `workflow:invoke:write` |

`CLOUD_API_URL` defaults to `https://agentrelay.com/cloud` and can be overridden
with a repository variable of the same name.

The workflow uses `agent-relay@11.10.3`, which reads `CLOUD_API_KEY` via
`WorkflowApiKeyClient.fromEnv` and avoids the interactive device flow entirely.
The credential is a long-lived API key, not a user session, and does not expire
or rotate. If either secret is missing, the preflight validation step fails
immediately with a clear error before any cloud run is attempted.
