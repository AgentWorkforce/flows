# Agent Relay node-spawn transport

An agent step with `transport: 'relay'` runs through Agent Relay's native node
spawn control. Flows no longer invokes the Relaycast `task.run` action and does
not start, connect to, or embed the retired Relay broker.

## Runtime contract

The worker needs a dedicated publisher `RELAY_AGENT_TOKEN`; a workspace key
cannot replace it. `RELAY_BASE_URL` defaults to
`https://cast.agentrelay.com`. Optional placement constraints are
`RELAYFLOW_NODE_NAME`, `RELAYFLOW_NODE_REPO`, and
`RELAYFLOW_NODE_SANDBOX_ONLY=1`.

The remote path uses `@agent-relay/sdk >=17.2.1 <18`:

1. `placement.spawn` selects a live node advertising `spawn:<harness>`.
2. Flows requests `confirm: true` and `verifyReady: true` and refuses an
   unconfirmed task, identity, node, launch, or readiness result.
3. The spawned agent reports one versioned result envelope to the publisher's
   durable inbox. Flows verifies the immutable sender id and name plus run,
   step, and dispatch correlation.
4. Flows invokes the node's `release` capability on the same node with the
   exact agent id, then records spawn, delivery, and release evidence.
5. Only after `stepComplete` is durably accepted by the journal does Flows ack
   the inbox delivery. Relay is transport; the journal is execution authority.

Spawn readiness is not task completion. A result without the exact sender and
attempt correlation cannot complete a step.

## Replay and cancellation

Before dispatch, Flows creates and fsyncs a private claim under
`<data-dir>/node-spawns/`. It binds publisher identity, Relay origin, journal
identity, stable worker name, and full spawn input. Tokens are never stored.

The current fleet placement SDK has no caller-provided idempotency key. Flows
therefore sends at most one spawn for a newly created claim. A recorded
invocation is reconciled with `commands.getInvocation`; an existing claim with
no recorded acknowledgement is the ambiguous crash window and fails closed.
It is never answered by a blind second spawn. The stable worker name provides
additional collision protection at the node.

Lease loss or timeout aborts the inbox wait and attempts exact release. A
failed cleanup remains auditable in the durable claim. A result delivery stays
unacked until its terminal journal append succeeds, so a worker crash cannot
turn Relay acknowledgement into fabricated execution truth.

## Local Desktop bridge

The SDK contains a local `NodeSpawnPort` adapter for the Desktop core's bridge
v2 methods: `spawn.targets`, `spawn.invoke`, `spawn.status`, and
`spawn.release`. It connects to the private same-user `core.sock`, validates
socket ownership/mode, performs the `hello` handshake, passes no credentials,
and requires an explicit caller name.

It is not selected by the CLI yet. Desktop currently authorizes only an
existing live coding-session registration; there is no headless Flows service
caller or delegation contract. Flows does not borrow another session's name.
Local admission therefore stays fail-closed until Desktop supplies that
contract.

See [the migration note](MIGRATION-NODE-SPAWN.md) for removed broker surfaces.
