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
flows run --cloud --input '{}' review.flow.ts
```

An authored `.flow.ts` takes `--input` exactly as a local direct run does (an
existing JSON file, otherwise inline JSON), and travels as one self-contained
source with its pinned Surface authority.

## Code sync

```sh
cd <your-repo>
flows run --cloud --sync-code --wait review.flow.ts --input '{"pr": 7}'
flows sync <run-id>            # apply the run's changes to this checkout
```

`--sync-code` uploads the invoking directory before submission, so the hosted
run — every `f.run` and every `f.agent` — executes inside that tree, the way
v1's `agent-relay cloud run --sync-code` did. Inside a Git checkout the upload
is `git ls-files --cached --others --exclude-standard`: `.gitignore` governs,
untracked files ride along, `.git` and `node_modules` never do. A checkout
whose `git` fails for any other reason (a corrupt `.git`, a locked index, no
`git` on PATH) is refused as `sync_unsupported` rather than widened to a plain
walk, so an ignored `.env` never reaches Cloud because Git was unavailable.
Outside Git, every file except those two directories — there is no ignore
rule there, so keep secrets out of such a tree. Executable bits are preserved;
symlinks whose target resolves outside the tree are dropped and listed as
`sync_link_skipped` warnings. The archive is streamed to a temporary file, so
packing costs one file plus the compressor's window, not the tree. The limit is
256 MiB uncompressed. The flow source itself is still sent in the request
body, so it must stay self-contained; sibling imports inside the tree are not
resolved by the hosted runner.

Interrupting before the run request — during prepare, packing or upload —
reports `submission_aborted`: nothing was admitted and rerunning is safe. Only
an interrupted submission itself reports `admission_unknown`.

The transport is the Cloud API only. `POST /api/v1/workflows/prepare` must
answer with a `cloud-api` workflow-storage backend (Cloud's R2), the archive
is `PUT` to `/api/v1/workflows/runs/<run>/storage/<key>` with the run-scoped
credential that receipt carries, and the run is submitted against that
prepared run ID. A `prepare` that offers any other backend is refused as
`unsupported_storage_backend` before a byte is uploaded; this SDK carries no
AWS client and never uploads to a bucket directly. Sync happens before
submission, so a refused backend or failed upload never leaves a launched run
pointing at a tree Cloud does not hold.

`flows sync <run-id>` fetches the sandbox's post-run diff from
`/api/v1/workflows/runs/<run>/patch` and applies it with `git apply` after a
`--check` pass, so a conflicting patch leaves the tree untouched
(`patch_conflict`, exit 2). The patch lands in the working tree uncommitted
and every touched path is listed, deletions included: what the run changed —
it is your own flow's output, but it is agent output — is reviewed with
`git diff` before any of it is kept, the same contract v1's `cloud sync` had.
Runs that declared several mounted paths carry one patch per path and are
refused here (`sync_unsupported`). `--dir <path>` targets a checkout other
than the current directory.

A synced run and a Cloud repository grant are mutually exclusive on the
server: `--sync-code` is the local-driven development loop, and
webhook-triggered deployments keep cloning through the grant.

## Credentials

Every hosted verb resolves its credential the same way: the `token` option,
then `FLOWS_CLOUD_TOKEN`, then the `agent-relay cloud login` store
(`~/.agentworkforce/relay/cloud-auth.json`, or `AGENT_RELAY_HOME`). The login
store also supplies the base URL unless `FLOWS_CLOUD_URL` overrides it, so a
login against one deployment never sends its token to another. An expired
login is refused with the re-login remedy rather than sent.

Running and syncing work with either kind of token. Deploying, listing and
removing listeners need the interactive `cli:auth` credential the login
produces; a deployment (CI) token gets `session_required` and the CLI says so.

## Listener deployments

```sh
flows deploy issue-triage.flow.ts \
  --repo AgentWorkforce/flows \
  --on github:labels=agent \
  --approver khaliqgant
flows deployments
flows undeploy <deployment-id>
```

Optional flags: `--agents claude,codex`, `--name "Issue triage"`, `--draft`,
`--json`, and further `--on` sources.

`flows deploy <flow.ts>` is the CLI form of the agentrelay.com onboarding's
deploy wizard: `POST /api/v1/flows/deploy` stores one self-contained authored
source and creates a proactive listener whose watch rules match the chosen
ticket sources. There is no webhook to register. The workspace's GitHub App
installation (or Slack, Linear, Jira or Shortcut connection) is the ingress;
Cloud ingests events into the workspace's relayfile projection and the
listener's rules match them there. The digest form,
`flows deploy <flow>@sha256:… --to file://…`, is unchanged; the positional
decides which form is meant.

`--on <provider>[:key=value,…]` takes `github` (`repository`, `labels`,
`contains`, `events`), `slack` (`channel`, `contains`), `linear` (`team`,
`contains`), `jira` (`project`, `contains`) or `shortcut` (`workspace`,
`contains`), each at most once. A GitHub source without `repository` is
scoped to `--repo`. `events` is `issues` (the default: `issues.opened` and
`issues.labeled`) or `pull_request`, which wakes on a pull request being
opened, receiving commits, being reopened, or being reviewed; a
pull-request run checks out the pull request's own head and receives
`input.pullRequest` (`number`, `title`, `body`, `headRef`, `headSha`,
`baseRef`, `author`, `draft`, `labels`, `url`, and `review` for a submitted
review) beside `input.issue` and `input.event`. Comment and check-run
events are not wake sources yet.

Each matching ticket launches one run of the stored source. Cloud clones
`--repo` at its default branch onto a fresh `relayflow/<name>-<id>` branch,
runs `flows run --local-agent` there, and passes the flow body
`{ approver, issue: { source, title, body, labels, repository, url, … }, event }`
as its input. The flow must therefore be the default body,
`flow<Input>(name, header, async (f, input) => …)`; `.on(github.issues(…))`
handlers are checked but are not what Cloud dispatches. `--agents` names the
coding-agent harnesses the flow uses (default `claude`); activation checks
their credentials are connected and refuses with `flow_model_not_connected`
otherwise. `--draft` saves the flow without activating it and skips those
checks. The deploy routes answer refusals as `{ code, error }`, and the CLI
names them (`flow_repository_not_connected`, `flow_name_taken`, …).

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

## Schedules

```sh
flows schedule nightly.flow.ts --input '{"topic":"release"}'          # uses the flow's schedule.* declaration
flows schedule monitor.flow.yaml --every 15m
flows schedule report.flow.ts --cron "0 9 * * 1-5" --tz Europe/Oslo --input '{}' --name "Morning report"
flows schedules
flows unschedule <schedule-id>
```

`flows schedule` registers a cron on Cloud: `POST /api/v1/workflows/schedules`
with `schedule_type: cron`, `cron_expression`, `timezone` and, as
`workflowRequest`, **exactly the body `flows run --cloud` would send** —
`workflow`, `fileType`, `relayflowVersion: v2`, and for an authored flow its
pinned `authoredAuthority` and the `--input` value. Each fire replays that
stored request through the same run admission a CLI submission takes, so what
runs on the cron is the source you scheduled, not a re-read of your checkout.
Nothing runs at schedule time. Code sync and repository grants are refused on
schedules: both name one specific upload or base commit, which a second fire
would find stale.

The cron comes from, in order: `--cron`, `--every` (only intervals cron can
express exactly — divisors of an hour, `1h`, divisors of a day, `1d`), or the
flow's own `schedule.cron(...)` / `schedule.every(...)` handler when it
declares exactly one. Both the expression and `--tz` are validated before any
request. The routes need the interactive `cli:auth` login, as deployments do.
`--every` and `schedule.every` are refused where no exact cron exists (`7m`):
say what you mean with `--cron`.

Authored `.on(schedule.*, body)` handlers are the declaration; the hosted fire
runs the flow's **default body** with `input`, as deployments do. Until
handler dispatch lands (flows #301), write the scheduled work in the default
body and use the handler to declare when — `flows check` prints the
declaration and its `flows.tick` lowering either way.

## Current limits and scope

- An authored `.flow.ts` is submitted as one self-contained source. Local
  imports and `use:` dependencies are refused before HTTP. With `--sync-code`
  the working tree is uploaded for the run to execute in, but the runner still
  loads the flow from the request body, not from the tree.
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
