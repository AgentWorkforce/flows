# Agent communication

A YAML/JSON flow opts in with explicit, directed links:

```yaml
communication:
  timeoutMs: 300000
  links:
    - { from: designer, to: reviewer }
    - { from: reviewer, to: designer }
```

See [the runnable conversation](../workflows/agent-communication.flow.yaml).
With no links, ordinary agent steps use the existing runner: no communication
worker, optional Relay package import, or broker is started. DAG dependencies
alone do not opt in. Both linked steps must be agents that can run concurrently;
ancestral dependencies and shared writable surfaces are rejected.

Install `@agent-relay/harness-driver` and `@agent-relay/sdk` (12.3.1 or newer in 12.x) in the SDK's
runtime environment. They are optional peers, so ordinary SDK installs do not
pull them in. For workspace development, use the built packages from `../relay`.
Set `RELAY_API_KEY` to the existing workspace key and run:

```bash
flows run workflows/agent-communication.flow.yaml --local-agent
```

Use the canonical workspace setup in `scripts/run-workflow.sh` when running a
watchable conversation. The run report includes a scoped observer URL; readable
conversation projections go to `wf-<run-id>`. Workspace keys never belong in URLs.

The kernel journal remains authoritative. Each directed link has one writable
channel, allowing concurrent dispatch. A small helper journals sends; the
receiving worker records a durable delivery and forwards it through Relaycast.
The existing Relay broker injects it into the declared CLI's managed PTY session. Agents
do not call a receive/poll tool. They explicitly acknowledge processing and call
complete. Injection/verification receipts do **not** acknowledge processing.

Sends use stable semantic message IDs. A reset attempt receives its conversation
history from the journal; unacknowledged messages are injected again. Injection
is at-least-once across attempts, not exactly-once model execution. History over
64 channel facts or 24 KB refuses reset rather than silently discarding context.
Use `flows resume <run-id> --local-agent --data-dir <original-dir>` for recovery.

The bridge is CLI-independent: it passes the declared executable, model, working
directory, and helper environment to Relay's PTY harness. Relay owns CLI-specific
launch flags and injection; Flows does not impose a CLI allowlist or add Claude
flags to other tools. Different CLI tools can participate in the same topology.
The CLI must support an interactive session with a shell/terminal tool. Claude,
Codex, Gemini, Cursor, OpenCode, Droid, Aider, Goose, Grok, Pi, DeepAgents, and custom
interactive executables use the same path. Availability of a binary alone is
not proof of authentication or model access: for tools without a Flows auth
probe, preflight emits `managed_cli_unverified`. A login prompt, unavailable
model, or failed task does not count as successful completion.

Current scope is local sessions with stream surfaces. This does not add
the public TypeScript `f.channel` API or hosted worker provisioning. Node must be
on PATH for the helper. Interactive sessions report unmetered usage: dollar and
token ceilings cannot bound their spend. Preflight warns; `timeoutMs` bounds the
session (default five minutes, maximum fifteen). Each attempt releases its owned
agent identity; the last session closes the run's broker and publisher.

After the example completes, verify its recorded exchange:

```bash
python scripts/verify-agent-communication.py <data-dir>/runs/<run-id>.sqlite3
```

The verifier checks message IDs, append/delivery/ack ordering, concurrent starts,
injection receipts, both agent completions, and the run's successful completion.

A mixed-CLI example is [Claude → Codex → Cursor](../workflows/mixed-cli-communication.flow.yaml).
Those three tools have completed a live journaled exchange. Gemini was blocked
by missing local Google authentication; OpenCode's default free model exhausted
its quota; its configured OpenAI key was also rejected on a second attempt.
Routing tests cover all names above and a custom executable; those
are not claims of live end-to-end coverage for every installed tool.

Verify the mixed example with `python scripts/verify-mixed-cli-communication.py <data-dir>/runs/<run-id>.sqlite3`.
