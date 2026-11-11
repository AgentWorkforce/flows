# Node-spawn response-loss acceptance kit

This is an acceptance-only proof for Flows #707. It changes no production
runtime behavior. It proves recovery when upstream commits a strict spawn but
Flows loses the complete `spawn.invoke` response.

The kit is Unix-only and must run from a plain terminal. Never run it from an
agent session tree. Use a disposable workspace, a dedicated target node, a
mode-0600 schema-v2 caller, and the packed SDK under review. Do not put caller
contents, publisher tokens, or workspace credentials in the config or logs.

## Files

- `packages/sdk/scripts/node-spawn-response-loss-proxy.mjs` — transparent Core
  Bridge socket proxy and fail-closed evidence verifier.
- `packages/sdk/scripts/node-spawn-response-loss-e2e.mjs` — lifecycle
  orchestrator.
- `packages/sdk/tests/node-spawn-response-loss-proxy.test.ts` — deterministic
  fake-upstream proof of zero response bytes, same-key concurrent replays, one
  upstream frame, exact task bytes, and fail-closed evidence validation.

The proxy forwards newline-framed JSON-RPC until it reads the first complete,
successful `spawn.invoke` reply from the real core. It never writes that line
downstream. It synchronously sends `SIGKILL` to the foreground Flows process,
then closes that connection. Later connections pass through unchanged.
The orchestrator races two resume processes. Correct durable claim ownership
may coalesce those racers into one physical bridge replay; the verifier requires
at least one exact same-key replay. The deterministic proxy regression also
sends two physical same-key replay requests and proves they converge on one
upstream provider frame.

## Preconditions

1. Install dependencies from the exact #707 head and build the SDK.
2. Pack that SDK and install it with public
   `@agent-relay/core-bridge@18.1.0` in a fresh mode-0700 consumer directory.
3. Provision a dedicated mode-0600 schema-v2 caller from a plain terminal.
4. Prepare fresh mode-0700 HOME and Flows data directories; the data directory
   must contain no `runs/*.sqlite3`.
5. Reserve one unrelated capacity slot and record its stable identity. The
   audit command must show the same reservation before and after the proof.
6. Provide a fixture audit command that reads the real Relaycast/Relay node,
   Desktop caller ledger, Flows journal, and inbox settlement record. It must
   print only the JSON object below on stdout and must not print secrets.

## Config

Create a mode-0600 JSON file outside the repository. Paths are absolute. The
start command runs the packed SDK in the foreground. The resume command must
contain `{RUN_ID}` exactly where the durable run id belongs. Do not pass
`--service-caller-file`; the kit securely copies the caller into a temporary
mode-0700 directory outside the evidence tree, changes only its socket to the proxy, and injects
`RELAYFLOW_SERVICE_CALLER_FILE`.

```json
{
  "callerFile": "/private/proof/caller.json",
  "dataDir": "/private/proof/flows-data",
  "evidenceDir": "/private/proof/evidence",
  "homeDir": "/private/proof/home",
  "workDir": "/private/proof/work",
  "timeoutMs": 600000,
  "start": {
    "command": "/usr/bin/node",
    "args": ["/private/consumer/node_modules/@relayflows/sdk/dist/cli.js", "run", "/private/proof/work/proof.flow.ts", "--input", "{}", "--local-agent", "--json", "--no-observer-link", "--data-dir", "/private/proof/flows-data"]
  },
  "resume": {
    "command": "/usr/bin/node",
    "args": ["/private/consumer/node_modules/@relayflows/sdk/dist/cli.js", "resume", "{RUN_ID}", "--local-agent", "--json", "--no-observer-link", "--data-dir", "/private/proof/flows-data"]
  },
  "audit": {
    "command": "/private/proof/bin/audit-response-loss",
    "args": ["--run", "{RUN_ID}", "--json"]
  }
}
```

The audit command stdout contract is:

```json
{
  "schema": "relayflows-node-spawn-response-loss/1",
  "strict_contract": "relay.spawn.invoke.logical-replay-resume/1",
  "strict_replay_capability": "relay.spawn.replay-resume/1",
  "strict_invocation_committed": true,
  "upstream_spawn_frames": 1,
  "workers_created": 1,
  "correlated_results": 1,
  "releases": 1,
  "target_capacity": { "active_agents": 0, "reserved_agents": 0 },
  "journal_terminal_sequence": 41,
  "inbox_settlement_sequence": 42,
  "unrelated_reservation": {
    "before": { "identity": "stable-unrelated-reservation-id", "count": 1 },
    "after": { "identity": "stable-unrelated-reservation-id", "count": 1 }
  }
}
```

Sequence values are fixture-defined monotonic positions, but the terminal
journal position must be strictly less than the inbox settlement position.
The audit must count real provider frames and real created workers, not bridge
requests. The strict contract and capability fields must come from the stored
Relaycast invocation, not from the request or from a hard-coded client claim.

## Commands

From the exact Flows checkout:

```sh
npm --prefix packages/sdk ci --ignore-scripts --no-audit --no-fund
npm --prefix packages/sdk run typecheck
npm --prefix packages/sdk run typecheck:tests
npm --prefix packages/sdk run build
npm --prefix packages/sdk exec -- vitest run tests/node-spawn-response-loss-proxy.test.ts --reporter=verbose
node packages/sdk/scripts/node-spawn-response-loss-e2e.mjs --config /private/proof/response-loss-config.json
```

The final command prints only `{ "ok": true, "evidence": ..., "run_id": ... }`.
It writes mode-0600 logs plus `response-loss-proof.json` under `evidenceDir`.
Before writing evidence it scans every captured log for caller-secret, token,
publisher-key, and Relayfile-bearer shapes. The evidence contains hashes and
counts, never the caller secret or task text. The runner requires the public
`@agent-relay/core-bridge@18.1.0` package, runs children with the fresh HOME,
and removes inherited publisher, workspace, broker, node, and API credentials.

## Required result

The proof passes only when all of these are true:

- the proxy received the committed upstream reply and forwarded zero bytes of
  it before `SIGKILL`;
- two concurrent resumes used the same run, task bytes, and idempotency key;
- the real provider saw one spawn frame and created one worker;
- one correlated result was journaled before one inbox settlement;
- exactly one release completed;
- target active and reserved capacity returned to zero; and
- the unrelated reservation identity and count stayed unchanged.

Keep #707 draft after the run. Attach the exact source head, packed SDK receipt,
public Core Bridge receipt, config with private paths redacted, literal commands
and output, and the secret-free `response-loss-proof.json` for independent
review. A human decides merge readiness; this kit never merges or publishes.
