# Node-spawn local response-loss acceptance kit

This is an acceptance-only proof for Flows #707. It changes no production
runtime behavior. It proves the part of recovery that the exact Flows data
directory and Core Bridge proxy can establish when upstream commits a strict
local spawn but Flows loses the complete `spawn.invoke` response.

The kit is Unix-only and must run from a plain terminal. Never run it from an
agent session tree. Use a disposable workspace, a dedicated local target node,
a mode-0600 schema-v2 caller, and the packed SDK under review. Do not put caller
contents, publisher tokens, or workspace credentials in the config or logs.

## Files

- `packages/sdk/scripts/node-spawn-response-loss-proxy.mjs` — transparent Core
  Bridge socket proxy and response/key evidence collector.
- `packages/sdk/scripts/node-spawn-response-loss-audit.mjs` — executable local
  verifier for the final durable claim, journal ordering, process generations,
  and proxy evidence.
- `packages/sdk/scripts/node-spawn-response-loss-e2e.mjs` — lifecycle
  orchestrator. It invokes the local verifier directly; no fixture-supplied
  audit hook is accepted.
- `packages/sdk/tests/node-spawn-response-loss-proxy.test.ts` — deterministic
  proof of zero response bytes, same-key replay, exact durable identity,
  terminal-journal-before-settlement ordering, and fail-closed validation.

The proxy forwards newline-framed JSON-RPC until it reads the first complete,
successful `spawn.invoke` reply from the real core. It never writes that line
downstream. It synchronously sends `SIGKILL` to the foreground Flows process,
then closes that connection. Later connections pass through unchanged. The
orchestrator races two independent OS process generations after the initial
generation is killed. Correct durable claim ownership may coalesce those
racers into one physical bridge replay; the verifier requires at least one
exact same-key replay.

## Proven boundary

The local verifier proves only these facts:

1. the final v3 claim retains the exact spawn identity from the intercepted
   reply, a correlated result, `release.status === "completed"`, and no
   `cleanupPending`;
2. exactly one matching terminal `step.completed` journal entry predates the
   claim's durable inbox settlement;
3. the killed process and two replay processes are distinct generations, the
   initial process died by `SIGKILL`, neither replay died by signal, and at
   least one replay exited zero; and
4. the proxy forwarded zero response bytes, observed the original task bytes
   and one idempotency key on every invoke, at least one replay, one release
   call, and one inbox settlement call.

The following remain explicitly deferred until a strict self-host artifact
digest and an authorized server-side audit are available:

- stored Relaycast contract and replay-capability proofs;
- provider-frame and worker-creation counts;
- target fleet capacity;
- preservation of an unrelated server reservation; and
- remote/fleet lifecycle acceptance.

Bridge request counts are not provider-frame counts. This kit never presents
them as such and makes no remote/fleet or server-database claim.

## Preconditions

1. Install dependencies from the exact #707 head and build the SDK.
2. Pack that SDK and install it with public
   `@agent-relay/core-bridge@18.1.0` in a fresh mode-0700 consumer directory.
3. Provision a dedicated mode-0600 schema-v2 caller from a plain terminal.
4. Prepare fresh mode-0700 HOME, evidence, and Flows data directories; the data
   directory must contain no `runs/*.sqlite3`.

## Config

Create a mode-0600 JSON file outside the repository. Paths are absolute. The
start command runs the packed SDK in the foreground. The resume command must
contain `{RUN_ID}` exactly where the durable run id belongs. Do not pass
`--service-caller-file`; the kit securely copies the caller into a temporary
mode-0700 directory outside the evidence tree, changes only its socket to the
proxy, and injects `RELAYFLOW_SERVICE_CALLER_FILE`.

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
  }
}
```

The orchestrator writes private proxy/process inputs and invokes the executable
verifier equivalently to:

```sh
node packages/sdk/scripts/node-spawn-response-loss-audit.mjs \
  --run "$RUN_ID" \
  --data-dir /private/proof/flows-data \
  --proxy-stats /private/mode-0700/proxy-stats.json \
  --process-evidence /private/mode-0700/process-evidence.json \
  --json
```

Those two input files are mode 0600 and live only in the runner's temporary
mode-0700 directory. The runner deletes that directory on exit.

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
publisher-key, and Relayfile-bearer shapes. Evidence stores spawn identity,
task, and idempotency-key digests rather than their source values. The runner requires
the public `@agent-relay/core-bridge@18.1.0` package, runs children with the
fresh HOME, and removes inherited publisher, workspace, broker, node, and API
credentials.

Keep #707 draft after the run. Attach the exact source head, packed SDK receipt,
public Core Bridge receipt, config with private paths redacted, literal commands
and output, and the secret-free `response-loss-proof.json` for independent
review. A human decides merge readiness; this kit never merges or publishes.
