# Agent communication status

The former communication runtime launched interactive broker-managed PTYs and
injected a local helper socket. That path was removed with the Relay broker.
Flows does not fall back to it.

Existing YAML `communication.links` declarations are still parsed so old
bundles receive a precise admission error. Preflight refuses them before a run
is admitted. Native node-spawn communication will require two contracts that
do not yet exist together:

- a supported headless local service caller/delegation contract from Agent
  Relay Desktop; and
- a journal-authoritative send/receive/ack protocol that works without a PTY,
  helper socket, arbitrary environment injection, or direct broker events.

Until those contracts land, split communicating work into ordinary journaled
steps or use one-shot `transport: 'relay'` agents. Relay messages may carry
task/result transport, but they do not replace journal facts.
