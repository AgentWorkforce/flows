# Migrating from Relay broker execution to node spawn

This release removes the frozen `@agent-relay/harness-driver` dependency and
all broker/PTy launch paths from `@relayflows/sdk`.

## One-shot remote agents

Keep `transport: 'relay'`, install `@agent-relay/sdk` in the supported range
`>=17.2.1 <19`, and provide a dedicated publisher `RELAY_AGENT_TOKEN`. The
transport now uses fleet node placement and the durable result inbox instead
of Relaycast `task.run`.

Custom executable paths and arbitrary injected environment variables do not
carry over. The selected node must advertise `spawn:<harness>` for the declared
harness. Use `RELAYFLOW_NODE_NAME` for an exact node or
`RELAYFLOW_NODE_REPO` for repository placement.

## Removed surfaces

- `transport: 'broker'`, `keepAlive`, `f.message`, and `f.release` for retained
  sessions fail before child-run admission.
- YAML with non-empty `communication.links` fails preflight. An empty list
  declares no linked session and remains a no-op.
- `examples/issue-swarm` is retained only as a labelled migration reference;
  it is not runnable on this release.
- `RELAYFLOW_RELAY_BROKER_BIN`, broker connection files, helper sockets, and
  broker health checks are no longer read.

There is deliberately no compatibility fallback to broker 17.2.1. A local
Desktop run uses a separately approved schema-v2 service caller. Pass its
private file explicitly with
`--local-agent --service-caller-file /absolute/caller.json`,
the SDK `serviceCallerFile` option, or `RELAYFLOW_SERVICE_CALLER_FILE`. Flows
never scans Desktop's app-data directory. It securely parses and
challenge-authenticates the handoff through `@agent-relay/core-bridge` 18.1 or
newer. Install a compatible version
(`npm install @agent-relay/core-bridge@^18.1.0`) when using Desktop mode; the
peer is optional only when Desktop mode is not used.
Flows then sends no caller name or secret
on spawn or inbox calls. The handoff's harness and directory scope is enforced
before dispatch. A local relay step with no authored `cwd` spawns in that run's
root; remote relay placement still receives no local directory.

`RELAYFLOW_SERVICE_CALLER_FILE` and `RELAY_AGENT_TOKEN` are mutually exclusive:
the former is local Desktop authority and the latter is remote fleet authority.
Setting both fails closed. A caller file whose publisher or workspace differs
from the authenticated core identity is also refused; rotate or reprovision it
in Desktop rather than editing the file.

## Custom `NodeSpawnPort` implementations

Ports must declare `dispatchFenceVersion: 1` and accept the supplied
`beforeDispatch` callback. Flows cannot prove that arbitrary port preflight is
side-effect-free, so it durably fences a custom port before entering `spawn`;
any error from that call is permanently ambiguous and is not retried. Calling
`beforeDispatch` remains required for forward compatibility and is idempotent
after that fence. `NodeSpawnPreDispatchError` preserves retry only for the SDK
runtime built from its internally loaded Core Bridge module and exact local
method/state identity, whose target preflight is audited;
it does not reopen any other port's fenced claim. Existing one-argument `spawn`
methods must be migrated even though JavaScript permits them to ignore the
callback. The required version field makes an unchanged port a type error, and
runtime use fails before claim creation. Overriding the built-in local port's
`spawn` or `targets` method also removes that narrow trust and fences it before
entry.

The exact built-in local Desktop port has one additional recovery contract.
Core Bridge 18.1 or newer persists `spawn.invoke` idempotency keys, so after a
durable fence and a lost reply Flows may repeat the identical local request and
recover the original invocation even when mutable current scope or target
preflight would no longer admit a new dispatch. That exemption is registered
only when the SDK runtime loaded the exact Core Bridge module and the local
prototype and lifecycle method identities remain unchanged. Injected bridges,
wrappers, subclasses, overrides, accessors, custom ports, remote placement and
legacy version 2 claims remain fail-closed. New unfenced local dispatches still
enforce current caller scope and target eligibility.

## Hosted and self-hosted execution

Hosted workers use the agent-token fleet path. Self-hosted workers use the
same path for remote nodes. The local Desktop mode requires a Desktop release
whose `hello.methods` contains the complete service-caller challenge, identity,
spawn, invocation-scoped inbox, settlement, close and disconnect contract.
Each result subscription uses its own authenticated connection. Flows closes
that iterator and connection before settling the item through another fresh
authenticated connection. Older Desktop builds fail closed before dispatch.

Self-hosted Flows licensing is owned by relaycontrol's signed offline licence
design. This SDK does not invent an entitlement store; deployments must fail
closed until a signed `flows` entitlement attestation is available. Scheduled
self-hosted submissions remain Kubernetes CronJobs, not `relaycron`.

Relay CLI migration remains a separate, approved follow-up: `relay flows`
already consumes the v2 SDK, while legacy `node workflow run` and the cloud
worker move together in their own stacked draft after the broker-retirement
change. This package is not published as part of either draft.
