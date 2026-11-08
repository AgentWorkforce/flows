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

One worker uses one lazy publisher connection across all of its concurrent
relay steps. Each step closes only its inbox iterator. The default runtime is
disconnected after worker shutdown drains every step; cancellation teardown is
best-effort, and injected runtimes remain caller-owned.

Spawn readiness is not task completion. A result without the exact sender and
attempt correlation cannot complete a step.

## Replay and cancellation

Before dispatch, Flows creates and fsyncs a private claim under
`<data-dir>/node-spawns/`. It binds publisher identity, Relay origin, journal
identity, stable worker name, and full spawn input. Tokens are never stored.

The current fleet placement SDK has no caller-provided idempotency key for the
placement invocation itself. Flows forwards the durable key to the selected
node in the spawn action input, and still sends at most one placement spawn
for a newly created claim. A recorded
invocation is reconciled with `commands.getInvocation`; an existing claim with
no recorded acknowledgement is the ambiguous crash window and fails closed.
It is never answered by a blind second spawn. The stable worker name provides
additional collision protection at the node.

The claim also fixes the task's original start time. Resume never grants a new
deadline. Once a correlated result was already durably observed, a restart has
at most 30 seconds beyond that original deadline to recover the same unacked
delivery; it cannot use that window to spawn or extend remote execution.

Lease loss or timeout aborts the inbox wait and attempts exact release. A
post-spawn verification failure carries any exact identity already proven into
the same cleanup path. Spawn and release action inputs carry their stable
idempotency keys. A failed cleanup is recorded as pending in the durable claim,
the attempt remains incomplete for kernel redispatch, and the result remains
unacked. Kernel redelivery therefore reopens the same claim and retries exact
release before it can accept a result or issue another spawn. A result delivery
stays unacked until its terminal journal append succeeds, so a worker crash
cannot turn Relay acknowledgement into fabricated execution truth.

## Local Desktop bridge

The SDK contains a local `NodeSpawnPort` adapter for the Desktop core's bridge
v2 methods: `spawn.targets`, `spawn.invoke`, `spawn.status`, and
`spawn.release`. On Unix it connects to `core.sock`, validates socket
ownership/mode, performs the `hello` handshake, and requires an explicit
Desktop-issued caller name and secret on invoke, status, and release. The
secret is kept in module-private storage rather than on the exported port
instance. Local node spawn is refused on Windows until Desktop exposes an
authenticated named-pipe server contract; a bridge-version hello alone is not
server authentication.
The current bridge does not accept model, repository, or sandbox placement
overrides, so the local adapter refuses those fields instead of dropping them.

It is not selected by the CLI yet. Flows does not borrow another session's
name and does not invent or provision its caller secret. Local admission stays
fail-closed until Desktop supplies the service credential path and file shape.

See [the migration note](MIGRATION-NODE-SPAWN.md) for removed broker surfaces.
