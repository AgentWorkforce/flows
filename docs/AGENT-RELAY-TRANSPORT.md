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

The remote path uses `@agent-relay/sdk >=17.2.1 <19`:

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

Before the journal append, Flows records a settlement intent containing the
kernel attempt and expected completion reason. The journal's terminal fact
must contain that reason and the exact Relay delivery and message ids before a
restart can acknowledge the inbox item. Inbox acknowledgement and rejection
have independent deadlines; an unconfirmed operation remains in the durable
outbox and is retried on worker attach, after dispatch drain, and on shutdown.

One worker uses one lazy publisher connection across all of its concurrent
relay steps. Each step closes only its inbox iterator. The default runtime is
disconnected after worker shutdown drains every step; cancellation teardown is
best-effort. Injected runtimes remain caller-owned: their caller must
disconnect them after every worker sharing that runtime has drained.

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
execution deadline. Once a correlated result was durably observed before that
deadline, the validated envelope is part of the claim and can be replayed to
the journal after any restart delay. Recovery cannot use that fact to spawn or
extend remote execution.

Lease loss or timeout aborts the inbox wait and attempts exact release. A
post-spawn verification failure carries any exact identity already proven into
the same cleanup path. Spawn and release action inputs carry their stable
idempotency keys. Every release attempt has an independent deadline. A failed
or unconfirmed cleanup is recorded as pending in the durable claim,
the attempt remains incomplete for kernel redispatch, and the result remains
unacked. Kernel redelivery therefore reopens the same claim and retries exact
release before it can accept a result or issue another spawn. A result delivery
stays unacked until its terminal journal append succeeds, so a worker crash
cannot turn Relay acknowledgement into fabricated execution truth.

## Local Desktop bridge

The SDK contains a local `NodeSpawnPort` adapter for Desktop's schema-v2
service-caller bridge. The caller is an explicit private `caller.json` path
supplied with `--service-caller-file`, the SDK `serviceCallerFile` option, or
`RELAYFLOW_SERVICE_CALLER_FILE`; Flows never scans Desktop's app-data
directory. Optional `@agent-relay/core-bridge` `>=18.1.0 <19` validates the
handoff and local socket or named pipe, challenge-authenticates a fresh
connection, verifies the bound publisher/workspace/node identity, and then
calls `spawn.targets`, `spawn.invoke`, `spawn.status`, and `spawn.release` without sending a caller
name or secret. The same authenticated bridge provides the invocation-scoped
result inbox and its ack/fail/close/disconnect lifecycle.

An explicit caller handoff is bound before the local worker registers with the
journal, so a missing, expired, malformed, revoked or identity-mismatched file
cannot admit a run and fail only at its first Relay step. The bridge package
owns platform-specific socket and Windows named-pipe trust checks; a bridge
version hello by itself is not authentication.
The current bridge does not accept model, repository, or sandbox placement
overrides, so the local adapter refuses those fields instead of dropping them.

The CLI selects this adapter only when the caller file is explicit and
absolute. It is mutually exclusive with `RELAY_AGENT_TOKEN`; Flows does not
borrow another session's name and does not invent or provision authority.
Desktop creates, rotates and revokes the private handoff.

See [the migration note](MIGRATION-NODE-SPAWN.md) for removed broker surfaces.
