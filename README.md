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
sdk/        TypeScript-first authoring SDK. Compiles specs; speaks the journal protocol.
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

The `review-swarm` GitHub Actions workflow requires a repository Actions secret
named `RELAY_WORKSPACE_KEY`. Obtain the key on a trusted machine with
`agent-relay workspace key`, then add its non-empty output under **Settings →
Secrets and variables → Actions → New repository secret**. The workflow checks
the secret before launching and fails closed when it is absent.
