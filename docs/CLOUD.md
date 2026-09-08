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
console.log(finished.status, 'completionReason' in finished ? finished.completionReason : undefined);
```

A `FlowSpec` object can replace `{ path }`. File reads, submission, and observation
are async. The receipt's `specHash` is calculated with the existing compiler and
kernel dialect; it is a local identity for correlation, not a server attestation.
The API pins the hosted runtime artifact. This SDK adds no bundle registry.
RFC-0001 decision #14's sealed flow bundle/digest admission is not implemented by
the current Cloud endpoint. Khaliq explicitly scoped this lane to its existing
declarative admission contract. This incremental client does not satisfy or
claim to close the immutable-bundle gate; `specHash` never attests server execution.

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
means Cloud reported `completed` with a validated `success` completion reason.
Failed/cancelled runs and observation/transport failures return 1. Local input,
configuration, unsupported format, and pre-admission HTTP 401/403 refusals return 2.
After admission, an observation HTTP 401/403 returns 1 and retains the run ID. SIGINT/SIGTERM stops
observation and preserves the run ID in the error report; it does not cancel
the hosted run. SDK callers can use `AbortSignal` for the same behavior.
An interruption before the admission receipt reports `admission_unknown`: the
server may have started the non-idempotent run. Do not resubmit blindly.

| Boundary | Limit | Control |
| --- | --- | --- |
| Individual HTTP request (including response body) | 30 seconds by default | `requestTimeoutMs` |
| SDK observation | No overall execution deadline | Caller `AbortSignal` stops observation |
| Cloud v2 execution | Existing one-hour runtime deadline | Backend; not changed by SDK options |

Safe GET observation retries transient connection errors, timeouts, HTTP 408,
429, 500, 502, 503, and 504 with exponential backoff capped at 30 seconds. Abort,
authentication, TLS/redirect errors, and invalid responses stop observation.
Only HTTPS endpoints are accepted, including local deployments.

The SDK makes one submission fetch call and adds no application-level POST retry: a lost HTTP response may follow a
successful admission, and retrying without server idempotency could run twice.
The receipt's `apiUrl` requires authentication and is **not a public share URL**.
Terminal observation validates `result.completionReason` against the existing
run protocol vocabulary and checks consistency with Cloud status; the SDK exposes
that reason, not the opaque server payload. Missing/inconsistent reasons fail
closed as `invalid_response`. Cloud can record provisioning failures or
cancellation without a journal report; those records cannot supply an attested
execution outcome through this API. Step-level journal evidence is not exposed
by this endpoint and is not synthesized by the SDK.

## Current limits and scope

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
  scope, by Khaliq’s ruling. Publication needs a new endpoint in the Cloud
  repository, outside this lane, with no assigned owner. The written design is
  the deliverable; implementation is not a WS-14 acceptance dependency.
  The [publication and gallery design](CLOUD-PUBLICATION-DESIGN.md) specifies
  proposed endpoints, token scopes, visibility tiers, and public records. Cloud
  ownership has not been identified; the SDK does not export `publishFlowRun`.
- Live proof: **BLOCKED-ON-CREDENTIAL**. The captured error is
  `Authenticated Cloud-base-path read HTTP: 401`. No hosted run is claimed, and
  this lane is not pursuing another credential. The package proof uses a local
  HTTPS contract server and is labeled accordingly.

`node scripts/cloud-package-proof.mjs` installs the packed SDK in a fresh
temporary npm project and exercises both its exported function and installed
`flows run --cloud` command. It verifies packaging and the HTTP contract, not
Cloud execution.

## Proposed positioning copy — document only

**Deterministic gates. Session replay. Your CLI harness.**

Keep the coding agents you already use. Put deterministic checks around their
work, then replay the session to understand how it got there.

- **Set the gate.** Declare the command and the evidence that permits the next
  step. An agent's assertion that it finished is not a passing check.
- **Replay the work.** Inspect the recorded session alongside the verification
  result so a reviewer can trace the outcome.
- **Bring your harness.** Keep your preferred coding-agent CLI and place the
  same explicit checks around its work.

The landing page is **cancelled, not deferred**, by Khaliq’s ruling. This
proposed copy is retained here as a document only. It will not be applied to a
page; there is no deployment target or landing acceptance dependency.
