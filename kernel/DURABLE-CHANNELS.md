# Durable channels (gate 1, #212)

Channels are run-local journal facts. An agent receives the oldest message it
has not acknowledged. Receiving commits `channel.delivered` before returning
its contents. Another receive before acknowledgement records another delivery
of that same message. `channel.acknowledged` advances the offset by exactly one;
reopening the journal reconstructs both the offset and delivery history.

## Internal journal protocol

Every request carries `run_id`, `step_id`, `attempt`, `idempotency_key`, and
`channel`. The connection must hold that attempt's worker lease. The durable
attempt must still be running, and the run must not be terminal or canceling.
Producer and consumer identity is the stable step id, so replacing a worker
process does not create a new consumer. Consumers have independent offsets.

| Verb | Additional parameters | Result |
| --- | --- | --- |
| `channel.append` | `message_id`, `message` (any JSON, including null) | Persisted `channel.appended` entry |
| `channel.receive` | None | Persisted `channel.delivered` entry, or null if empty |
| `channel.ack` | `delivery_seq` from a receive result | Persisted `channel.acknowledged` entry |

A producer may append only to a stream named in its existing `surfaces.streams`
declaration (Appendix A rule 1). Reading does not reserve the other agent's
writable surface. No schema or SDK fields are added here. The crash fixture
uses two agents with distinct outgoing stream and external effect surfaces,
so the scheduler can dispatch both together.

Offsets are one-based; an acknowledged offset of zero means nothing consumed.
A send is deduplicated by `(run, channel, producer step, message_id)`. Retrying
with identical JSON returns the original entry, even across attempts; changing
the content under that key is rejected. Acknowledgement must reference a
committed delivery to this consumer on this channel. Repeated acknowledgement,
including one older than the current offset, returns the current durable
acknowledgement without another append. Acknowledgement never skips messages.

## Persistence and replay

The pure `relayflowd-core::channel::ChannelState` decides operations and folds
journal facts. SQLite loads the state, validates the actor, makes the decision,
and commits the entry under one IMMEDIATE transaction. This serialization also
covers independent journal connections. Raw channel entry appends validate the
message/delivery/acknowledgement ordering in their transaction. A failed write
returns an error without a delivery result or an advanced offset. The daemon
notifies journal observers only after a new entry commits.

Replay reads recorded deliveries in journal sequence order; it does not execute
consumer code or invoke receive again. As with the existing stream reader,
channel operations currently scan retained journal segments. This supports a
message/delivery in one segment being acknowledged in another. It does not yet
provide a bounded channel snapshot for archiving/removing old segments; epoch
compaction remains scaffolding in this kernel. There is no extra mutable offset
table that can disagree with the journal.

## Crash evidence

`relayflowd/tests/crash_resume/channels.rs` drives two stub agents over the real
daemon socket and resumes using the real CLI. It SIGKILLs the daemon after
append, after delivery, after effect confirmation, and after acknowledgement.
Unacknowledged messages are delivered again; acknowledged messages stay consumed.
The agents exchange a request and reply and use the existing effect election /
confirmation protocol to produce one effect per agent across those cuts. This
proves the tested coordination crash windows; it does not add a new guarantee
for arbitrary external providers between a provider call and effect confirmation.

The test was committed before implementation at `38dcef9`, with the expected
`unsupported_verb` failure captured in `evidence/212/red-channel.txt`.
The required command is `cd kernel && cargo test --workspace`; its captured
output is `evidence/212/workspace.txt`.
