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

Flow-extension plugins declared in `flows.json` (and extra `--plugin <github
ref>` on `flows deploy`) travel in the deploy/run body as `extensions[]`:
name, version, canonical ref, digest, manifest, and the plugin files (UTF-8
or base64). The extensions field is capped at 2 MB separately from the 256 KB
source cap. Cloud must materialize them at `.flows/plugins/<name>@sha256:<digest>/`
before the hosted CLI loads the source; until that Cloud slice lands, a
deployment that includes plugins is accepted by this CLI but not yet executed
as a composed graph on the hosted runner. Private repositories are
unsupported. `permissions.writes` is a reviewed declaration, unenforced
until gate 8.

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
`--dir <path>` targets a checkout other than the current directory.

The agent runtime's own bookkeeping inside the synced tree is never written.
The sandbox commits its baseline before the run, so `.agent-bin/**`,
`.relayfile.acl`, `.relayfile-mount-state.json` and its `.tmp-*` temporaries,
`.trajectories/**` and `.workflow-context/**` all show up in the post-run diff;
applying them verbatim would drag trajectory records and mount state into your
checkout, and overwrite the mount state of the tree being synced into. They are
dropped with `git apply --exclude`, listed as `SKIPPED` (`excluded` under
`--json`), and — because the exclusions are a property of the patch that lands —
the `--check` pass carries the identical arguments: a conflict in a hunk that is
never applied is not a refusal. The patterns are anchored at the patch root, so
a vendored `packages/x/.agent-bin/tool` belongs to a different tree and rides
along. `CLOUD_SYNC_PATCH_EXCLUDES` is the list's single home; `applyCloudPatch`
takes an `exclude` option, and `[]` applies a patch whole.

`--dry-run` prints the patch and applies nothing, reporting which paths it would
write and which it would skip. Under `--json` the diff travels in the payload's
`patch` field rather than loose on stdout beside it, so one object still parses.

A run that declared several mounted paths carries one patch per path, keyed by
path name. `flows sync --dry-run` shows each of them; applying is refused
(`sync_unsupported`, exit 2), because they target different repositories and no
single `--dir` is the right destination — inspect them, then apply each in its
own repository. This is not a v1 shape: the `/patch` route branches on the run's
`paths`, not on `relayflowVersion`, so a v2 `--sync-code` run that submits
several paths answers the same way.

A synced run and a Cloud repository grant are mutually exclusive on the
server: `--sync-code` is the local-driven development loop, and
webhook-triggered deployments keep cloning through the grant.

## Reading a hosted run

Three read-only verbs answer "what did that run do" from the Cloud API, so an
agent holding its user's own Cloud credential does not have to hand-roll HTTP:

```sh
flows runs [--limit <n>] [--json]                         # recent runs
flows logs <run-id> [--step <name>] [--raw] [--json]      # runner log, or a step's transcript
flows logs <run-id> --follow [--json]                     # ...and keep reading it until the run ends
flows status --cloud [--json] <run-id>                    # the run's steps, as `flows status` renders a local one
flows status --cloud --watch [--json] <run-id>            # ...and redraw it until the run ends
```

They resolve their credential exactly the way every other hosted verb does
(see [Credentials](#credentials) below) and they write nothing. A workspace
API token of purpose `workflow` is enough; the log route additionally wants
`workflow:logs:read` or `workflow:invoke:read`, and a run-scoped *sandbox*
token may only read its own run.

`flows runs` lists the runs the credential can see, newest first, one line
each: run id, flow name, status, completion reason, the started and updated
instants, and the pull request the run opened when there is one. The route
pages by opaque cursor and has no `limit` parameter of its own, so `--limit`
is applied here — asking for ten makes one request, and the header says when
Cloud had more.

```text
runs 2
RUN 20d04c99-3fa8-48c9-9286-92d364a5bc2e  insight-proof-2022  completed  success  started 2026-09-19T20:34:58Z  updated 2026-09-19T20:37:42Z
RUN 2c24c74d-ce49-5e0b-b7ca-d5ff64a19102  relay.ci.pr-proof   failed              started 2026-09-19T23:16:09Z  updated 2026-09-19T23:17:43Z
      error relayflow_v2_repository_token_unavailable
```

`flows logs <run-id>` prints the sandbox's runner log. `--step <name>` selects
one agent step's transcript instead — the step name is the `sandbox_id` the
step list carries, and `flows status --cloud` prints the exact invocation
under each step that has one. A transcript is JSONL (the harness's
`stream-json`, wrapped in the `relayflow.attempt` markers the v2 executor
interleaves), and it is rendered: a session header from the `system`/`init`
frame, assistant text as prose, one line per tool call with its target and the
size of its result, thinking blocks as a character count only, attempt and
truncation markers as separators, and a footer with duration, turns, cost and
tokens.

```text
LOG 20d04c99-3fa8-48c9-9286-92d364a5bc2e  step agent-2  5,945 bytes  complete
── attempt 1 · 5,873 bytes ─────────────────────────────────────────────
session  claude-opus-5 · v2.1.19 · bypassPermissions · 18 tools · 0 MCP servers
assistant:
  I'll read the file.
  tool  Read  /project/workflows/runs/e4456951-.../notes.txt  → 385 chars
  thinking  0 chars (not shown)
assistant:
  **Line count:** 3 (`alpha`, `beta`, `gamma` — ...)
── result success · 6.2s · 2 turns · $0.108098 · 4 in / 248 out · 25,402 cache read · 25,638 cache write ──
```

`--raw` prints the JSONL unrendered. It does **not** print it unredacted:
every string that reaches the terminal — rendered, raw, or `--json` — goes
through `redact.ts`, the redactor the local `flows status` uses. That is a
deliberate choice of one of the two redactors in the tree (flows#494): this is
the status page extended to hosted runs, and a reader should meet the same
rule set whether the run was local or hosted. No frame is ever dropped — a
frame this vocabulary has no opinion about is reported as one line naming its
type and size, and a line that is not JSON is printed as written, so `--raw`
is never the only way to find out that something ran.

`flows status --cloud <run-id>` is the local `flows status` view, sourced from
the run record and the step list instead of a journal: the `RUN` header with
status, completion reason and summed spend, a `steps N` count, and one
glyph-led line per step with its state, attempts, timing and gate verdict.
An agent step also gets its transcript digest — model, turns, tool calls,
cost, frames and bytes kept, token and cache usage, the tool roster, the last
calls, and its artifacts.

```text
RUN 20d04c99-3fa8-48c9-9286-92d364a5bc2e   insight-proof-2022   completed   started 2h49m ago   finished success   spend 4 in / 248 out / $0.108098
steps 3: 3 completed
authority surface 2.0.22 · artifact 9c361a2cbb0a · commit b4dd665eb433

  ✓ run-1       deterministic  completed    1 attempt  0.0s  success  gate: exit_code pass
  ✓ agent-2     agent          completed    1 attempt  9.3s  success  gate: completion pass
      transcript (attempt 1): claude-opus-5 · 2 turns · 1 tool call · $0.108098
        7 of 7 frames, 5,873 bytes
        4 in / 248 out · 25,402 cache read · 25,638 cache write
        tools: Read ×1
        call 1 Read {"file_path":"/project/.../notes.txt"} → 393 bytes
        artifacts: none
      logs: flows logs 20d04c99-3fa8-48c9-9286-92d364a5bc2e --step agent-2
  ✓ complete-3  deterministic  completed    1 attempt  0.0s  success  gate: exit_code pass
```

A step that is still going renders in the same grammar as a finished one, in
the local view's vocabulary: `↻` for `running` and `backoff`, `⏸` for
`waiting` and `needs_human`, the number of the attempt now running, and the
time since its `startTime`.

```text
  ↻ agent-5  agent          running      attempt 1  6m50s
```

Only what the snapshot establishes is printed. Cloud's step rows carry no
maximum-attempt budget, no wait id and no backoff deadline, so — unlike the
local view — no `attempt 1/3`, no `awaiting human: ...` and no
`backoff until ...` appears; those cells arrive if and when the step route
carries the fields. A row with no `startTime` has not been dispatched, so it
shows no attempt number rather than `attempt 1`, and a step that has ended
keeps the duration Cloud reported instead of being advanced to now. A running
run whose snapshot has no rows prints `steps 0` followed by
`No step snapshot available yet.` — a fact about the snapshot, where a bare
`steps 0` would be a claim about the run.

### Following a run that is still going

`flows status --cloud --watch` redraws the page every two seconds until the
run reaches a terminal status, then leaves the final page up. `flows logs
<run-id> --follow` appends new runner output on the same cadence until the run
ends and Cloud marks the log complete, then prints the run's outcome:

```text
LOG 20d04c99-3fa8-48c9-9286-92d364a5bc2e  runner  following  1,204 bytes so far
[relayflow] ▶ agent-5 (agent) started
[relayflow] ✓ agent-1 … done in 5m16s · claude-opus-5 · 37 turns · $2.26 · wrote plan.md
COMPLETED 20d04c99-3fa8-48c9-9286-92d364a5bc2e completionReason: success
```

Both differ from their one-shot forms in one visible way: **the exit code is
the run's, not the read's.** They exit 0 only on a run Cloud attests as
`completed` with `completionReason: success`, 1 on an attested failure or
cancellation, and 1 with `cloud_invalid_response` on a terminal record that
attests neither — the same validation `flows run --cloud --wait` blocks on, so
the two cannot disagree. A plain `flows logs` on a failed run still exits 0,
because there the exit code describes the read. Ctrl-C exits 1 with
`observation_aborted`; the hosted run is **not** cancelled by it.

Under `--json` both poll silently and print exactly one document at the end —
the one their one-shot form would have printed, with `--follow` carrying the
whole redacted log. That is deliberately unlike `flows check --watch`, which
emits one JSON report per check: these two have a single result, and a script
that wants it wants to block and then parse once. In that document `ok: true`
means the read succeeded; the run's outcome is the exit code.

A watched page is drawn in one write after the cancellation check, so an
interrupt never leaves half a frame, and a failed poll leaves the previous page
alone rather than clearing the screen to report it. Transient failures and
HTTP 408/429/500/502/503/504 are retried with the same doubling delay, capped
at 30 seconds, that the hosted waiter uses; every other failure refuses with
the codes below. The page is two reads against two projections (the run record
then the step rows), so a step row can lag the header above it by a poll; it is
not an atomic snapshot and does not claim to be.

`--follow` does not take `--step`. A step transcript is not an append-only
stream: a retry replaces it, and the rendered form is built from the whole
JSONL. The combination is refused with `invalid_invocation` before any request,
naming both alternatives. Following the runner log re-reads it whole on every
poll and prints only the part that is new — the route's `offset` is a byte
count and the content is a string, and mixing the two silently loses text the
moment a log contains a non-ASCII character, which the runner's own transition
lines do. The cost is a full read per poll and the log held in memory; the
benefit is that no line can be duplicated or skipped. If what was already
printed is no longer a prefix of what Cloud serves, `--follow` refuses with
`cloud_log_rewritten` rather than guessing which bytes are new.

`--cloud` takes neither `--data-dir` nor `--tail`: both name things on this
filesystem, which a hosted run has none of, so pairing them is refused as an
invocation rather than quietly ignored. `--watch` is refused without `--cloud`
for the same reason: the local `flows status` reads one journal file and
returns, so there is no loop for it to hang in. The spend total is summed from the
step rows because the run record carries no total, and Cloud stores each
step's cost as a float — unlike the local view, which adds the journal's
decimal strings exactly (`run-state.ts`).

Every refusal is one `REFUSED [code] message` line naming what to do next:

| code | when |
| --- | --- |
| `cloud_auth_missing` | no credential anywhere; names `agent-relay cloud login` |
| `cloud_auth_expired` | the stored login expired; refused before any request |
| `cloud_auth_rejected` | Cloud answered 401: the token is unknown or revoked |
| `cloud_forbidden` | 403: authenticated, but not allowed to read that run or log |
| `cloud_run_not_found` | 404: no such run for this credential; points at `flows runs` |
| `cloud_step_no_transcript` | `--step` named a step with no transcript, or no such step; names the ones that have one |
| `cloud_log_rewritten` | `--follow` found the log no longer starts with what it printed; following it would skip or repeat output |
| `observation_aborted` | Ctrl-C (or a caller's abort) during `--watch`/`--follow`; the hosted run continues |
| `invalid_invocation` | the run id is not a run id (wrong characters, too long); refused before any request |
| `cloud_invalid_response` | Cloud answered something this client cannot trust — a record for a different run, a list that is not a list, a row with no id, a pagination cursor that does not advance |
| `cloud_unreachable` / `cloud_transport_failed` | the request never completed |

A read never guesses to stay quiet. A run record whose `runId` is not the one
asked for, a `runs` or `steps` field that is not an array, and a row with no
`runId`/`stepName` are all refused rather than rendered — otherwise `runs 0`
and a three-step run shown with two would be claims about the workspace that
nobody established. A step-list read that fails while resolving `--step`
surfaces *its* failure (403, transport) rather than becoming
`cloud_step_no_transcript`, which would tell a caller to fix an invocation that
was fine.

Under `--json` the same refusal is one object on stdout
(`{"v":1,"ok":false,"code":…,"message":…}`) and stderr stays empty.

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
`--no-connect`, `--json`, and further `--on` sources.

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
`input.pullRequest` (`owner`, `repo`, `number`, `action`, `title`, `body`, `headRef`, `headSha`,
`baseRef`, `author`, `draft`, `labels`, `url`, and `review` for a submitted
review) beside `input.issue` and `input.event`. Comment and check-run
events additionally require Cloud's expanded change-request routing release.
`input.event` is a normalized descriptor, not the raw webhook: it carries
`provider`, dotted `eventType` (for example `pull_request.synchronize` or
`pull_request_review.submitted`), `paths`, and `deliveryId`. The repository
coordinates also appear in `issue.repository`; they are not exclusive to it.

Each matching ticket launches one run of the stored source. Cloud clones
`--repo` at its default branch onto a fresh `relayflow/<name>-<id>` branch,
runs `flows run --local-agent` there, and passes the flow body
`{ approver, issue: { source, title, body, labels, repository, url, … }, event }`
as its input. The flow must therefore be the default body,
`flow<Input>(name, header, async (f, input) => …)`; `.on(github.issues(…))`
handlers are checked but are not what Cloud dispatches. `--agents` names the
coding-agent harnesses the flow uses; it defaults to the `cli:` declarations
the source carries (`flowRequirements`), else `claude`. Activation checks
their credentials are connected and refuses with `flow_model_not_connected`
otherwise, and the CLI appends the remedy (`agent-relay cloud connect
<harness>`). `--draft` saves the flow without activating it and skips those
checks. The deploy routes answer refusals as `{ code, error }`, and the CLI
names them (`flow_repository_not_connected`, `flow_name_taken`, …).

## Integrations a flow requires

`flows check` prints what a flow needs from the workspace it will run in:

```
REQUIRES slack (tools.slack), github (deploy target), claude (agent "review")
```

The list is derived from inert declarations only (`flowRequirements` in the
SDK; the same function reads a compiled YAML spec, where a helper step such as
`slack: { post: … }` names its provider): `tools.<helper>: true` flags and
`tools.relayfile` mounts in the header, `f.<helper>` use in the default body
(recognised exactly as helper preflight recognises it), provider triggers
(`.on(github.issues())`), the `--on` sources and the deploy target (every
launched run lands in `--repo`, so GitHub is always required), the `cli:` of
each `f.agent`/`f.llm` call in the default body (else the nearest `flows.json`
`cli`, else `claude`), and `tools.mcp`. Handler bodies are not scanned: hosted
dispatch runs the default body (flows #301), so only a handler's trigger is a
requirement. The deploy body carries the same list as `requirements` for
Cloud to cross-check, and a declared harness Cloud cannot run yet (`gemini`)
refuses the deploy unless `--agents` overrides it.

Before `flows deploy`, `flows schedule` and `flows run --cloud` submit anything,
each required integration is checked against the workspace
(`GET /api/v1/workspaces/<id>/integrations/<provider>/status?scope=workspace`).
A missing one is offered in the terminal, the way `agentworkforce deploy`
connects a proactive agent's integrations:

```
This flow needs Slack (tools.slack), which is not connected to this workspace.
Connect Slack now? (opens browser) [Y/n]
Opening https://agentrelay.com/cloud/…/connect
Slack connected.
```

Yes opens a relayfile connect session (`POST …/integrations/connect-session`
with `{ allowedIntegrations: ["slack"], scope: { kind: "workspace" } }`) in
the browser and polls the status until it is ready (five minutes at most);
`FLOWS_NO_BROWSER=1` prints the link instead of opening it. No answer, `--json`,
a non-interactive stdin, or `--no-connect` refuses with
`integration_not_connected` (exit 2), naming the provider, the declaration that
needs it, and the two ways to connect it. `--draft` deploys skip the check,
as Cloud does. Coding-agent credentials have no status route; Cloud refuses
them on activation or launch and the CLI names `agent-relay cloud connect
<harness>` then. A flow that requires no integration contacts nothing extra.

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
- Inside a hosted sandbox, `flows status` (SURFACE.md §5) works unchanged: the
  worker is the `--local-agent` of the CLI Cloud spawns with `--data-dir`, so
  the agent's own journal is on its own disk and the four `RELAYFLOW_*`
  discovery names are set by that worker with no Cloud env change. Cloud's one
  obligation is to put the same pinned `flows` binary that wrote the journal on
  the agent's PATH; today it is invoked by absolute path only. What the agent
  cannot learn from disk is Cloud's alone and is not guessed: its Cloud run id
  (a UUID Cloud may export separately), its sandbox, and which listener
  launched it.
- From outside the sandbox, step state *is* readable — see
  [Reading a hosted run](#reading-a-hosted-run). `GET /runs/<id>/steps`
  answers per-step rows carrying state, attempts, timing, gate verdicts, spend
  and the transcript digest, and `GET /runs/<id>/logs` answers the runner log
  or one step's transcript. There is still no journal-export endpoint: what
  these routes serve is Cloud's own record of the run, not the kernel journal,
  so `flows status --cloud` renders the same facts in the same shape without
  claiming to be a replay. `flows replay` remains local-journal only.
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
