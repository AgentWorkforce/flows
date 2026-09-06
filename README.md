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
must configure three Actions secrets. The workflow fails during preflight, in
seconds and before submitting a run, when any of them is absent.

| Secret | What it is | How to obtain it |
|---|---|---|
| `RELAY_WORKSPACE_KEY` | Selects the messaging workspace the swarm runs in. | `agent-relay workspace key --reveal-secrets` |
| `CLOUD_API_ACCESS_TOKEN` | The Cloud **user session** access token. | `agent-relay cloud session --json --reveal-token` after a login dedicated to CI |
| `CLOUD_API_REFRESH_TOKEN` | That session's refresh token. | `~/.agentworkforce/relay/cloud-auth.json`, field `refreshToken`, from the same login |

`CLOUD_API_URL` and `CLOUD_API_ACCESS_TOKEN_EXPIRES_AT` are not secret; the
workflow defaults them and either can be overridden with a repository variable
of the same name.

A workspace key alone cannot run the swarm. `agent-relay cloud run` authenticates
to the Cloud API as a user session and as nothing else: the workspace key is read
only by the resolver that picks a messaging workspace, and `POST
/api/v1/workflows/prepare` — which `--sync-code` requires, and `--sync-code` is
how the swarm receives the PR diff — admits only a browser session or a token
carrying the `cli:auth` scope. Given no session, the CLI opens an interactive
device login that no runner can approve and exits after the grant expires.

**These tokens expire, and this is a stopgap.** A CLI login mints a 24-hour
access token backed by a 90-day refresh token, and every refresh rotates the
refresh token server-side — invalidating the copy held in the secret, which a
job cannot write back. Expect to re-mint `CLOUD_API_ACCESS_TOKEN` and
`CLOUD_API_REFRESH_TOKEN` roughly daily until Cloud can issue a long-lived,
non-refreshing CI token that carries `cli:auth` (the existing CI deployment
tokens carry only `deployments:ci:*` and cannot launch a workflow).
