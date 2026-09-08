# Hosted flow submission

`runInCloud` submits a declarative YAML/JSON flow to Cloud's existing
`POST /api/v1/workflows/run` API with `relayflowVersion: "v2"`. Cloud provisions
the runtime; the SDK starts no local daemon and requires no `agent-relay node up`.
The Rust runtime remains responsible for execution and verification.

```ts
import { runInCloud, waitForCloudFlowRun } from '@relayflows/sdk';

const accepted = await runInCloud({ path: './flow.yaml' }, {
  token: process.env.FLOWS_CLOUD_TOKEN,
});
console.log(accepted.runId); // accepted, not completed
const finished = await waitForCloudFlowRun(accepted.runId);
console.log(finished.status, finished.result);
```

A `FlowSpec` object can replace `{ path }`. File reads, submission, and observation
are async. The receipt's `specHash` is calculated with the existing compiler and
kernel dialect; it is a local identity for correlation, not a server attestation.
The API pins the hosted runtime artifact. This SDK adds no bundle registry.

Configure `FLOWS_CLOUD_TOKEN` with a Cloud API token authorized for
`workflow:invoke:write` and `workflow:runs:read`. The default base URL is
`https://agentrelay.com/cloud`; `FLOWS_CLOUD_URL` selects another Cloud deployment
and must include that deployment's application base path.
SDK options `token` and `apiUrl` override the environment. The token must be a
Cloud token, not a Relay workspace or observer key. Cloud v2 admission and its
pinned runtime must be enabled by that deployment's operator.

```sh
flows run --cloud examples/cloud-gates/cloud-gates.flow.yaml
flows run --cloud --wait --json examples/cloud-gates/cloud-gates.flow.yaml
```

Without `--wait`, exit 0 means the server accepted the run. With `--wait`, it
means Cloud reported `completed`; failure/cancellation returns 1. Credentials
and unsupported source formats are refusals (exit 2). SIGINT/SIGTERM stops
observation and preserves the run ID in the error report; it does not cancel
the hosted run. SDK callers can use `AbortSignal` for the same behavior.
Each HTTP request has a separate 30-second transport timeout, configurable via
`requestTimeoutMs`; this does not limit the hosted run's execution duration.

Submission is never automatically retried: a lost HTTP response may follow a
successful admission, and retrying without server idempotency could run twice.
The receipt's `apiUrl` requires authentication and is **not a public share URL**.

## Current limits and rollout dependencies

- Cloud's v2 bootstrap explicitly rejects authored `.flow.ts` files. The SDK
  refuses those before HTTP rather than uploading code that cannot run. Inputs,
  local imports, CLI configuration files, and workspace files are not bundled
  or uploaded by this path.
- SDK observation has no fixed execution deadline. The merged authored-agent
  executor follows worker leases rather than the former 30-second limit.
  Cloud's separate `relayflow-v2-executor.ts` still has a one-hour execution
  deadline; this SDK does not override or claim to fix it.
- Cloud must provision and preflight agent workers; this client performs spec
  compilation only and cannot prove hosted credentials or worker availability.
- `publishFlowRun` and the gallery are **design-only** under the revised WS-14
  scope. No standalone app, site, route, or publication backend is being built.
  The [publication and gallery design](CLOUD-PUBLICATION-DESIGN.md) specifies
  proposed endpoints, token scopes, visibility tiers, and public records. Cloud
  ownership has not been identified; the SDK does not export `publishFlowRun`.
- Live proof: **BLOCKED-ON-CREDENTIAL**. The captured error is
  `Authenticated Cloud-base-path read HTTP: 401`. No hosted run is claimed, and
  this lane is not pursuing another credential. The package proof uses a local
  HTTP contract server and is labeled accordingly.

`node scripts/cloud-package-proof.mjs` installs the packed SDK in a fresh
temporary npm project and exercises both its exported function and installed
`flows run --cloud` command. It verifies packaging and the HTTP contract, not
Cloud execution.

## Landing copy prepared for the showcase

**Deterministic gates. Session replay. Your CLI harness.**

Keep the coding agents you already use. Put deterministic checks around their
work, then replay the session to understand how it got there.

- **Set the gate.** Declare the command and the evidence that permits the next
  step. An agent's assertion that it finished is not a passing check.
- **Replay the work.** Inspect the recorded session alongside the verification
  result so a reviewer can trace the outcome.
- **Bring your harness.** Keep your preferred coding-agent CLI and place the
  same explicit checks around its work.

This copy is prepared for the landing owner; it is not a deployment claim.
Cloud submission and public-gallery CTAs must not imply unsupported authored
TypeScript execution or link to fabricated public runs.
