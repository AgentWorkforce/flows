# Migrating from Relay broker execution to node spawn

This release removes the frozen `@agent-relay/harness-driver` dependency and
all broker/PTy launch paths from `@relayflows/sdk`.

## One-shot remote agents

Keep `transport: 'relay'`, install `@agent-relay/sdk` in the supported range
`>=17.2.1 <18`, and provide a dedicated publisher `RELAY_AGENT_TOKEN`. The
transport now uses fleet node placement and the durable result inbox instead
of Relaycast `task.run`.

Custom executable paths and arbitrary injected environment variables do not
carry over. The selected node must advertise `spawn:<harness>` for the declared
harness. Use `RELAYFLOW_NODE_NAME` for an exact node or
`RELAYFLOW_NODE_REPO` for repository placement.

## Removed surfaces

- `transport: 'broker'`, `keepAlive`, `f.message`, and `f.release` for retained
  sessions fail before child-run admission.
- YAML `communication.links` fails preflight.
- `examples/issue-swarm` is retained only as a labelled migration reference;
  it is not runnable on this release.
- `RELAYFLOW_RELAY_BROKER_BIN`, broker connection files, helper sockets, and
  broker health checks are no longer read.

There is deliberately no compatibility fallback to broker 17.2.1. Retained
local sessions and linked communication remain unavailable until Desktop has a
supported headless Flows caller/delegation surface. An operator-supplied or
borrowed coding-session name is not a substitute.

## Hosted and self-hosted execution

Hosted workers use the agent-token fleet path. Self-hosted workers use the
same path for remote nodes. Selecting the local Desktop bridge is withheld
until the service-caller contract exists.

Self-hosted Flows licensing is owned by relaycontrol's signed offline licence
design. This SDK does not invent an entitlement store; deployments must fail
closed until a signed `flows` entitlement attestation is available. Scheduled
self-hosted submissions remain Kubernetes CronJobs, not `relaycron`.

Relay CLI migration is a separate follow-up: `relay flows` already consumes
the v2 SDK, while legacy `node workflow run` and the cloud worker must not move
until the Relay and Cloud owners approve that change.
