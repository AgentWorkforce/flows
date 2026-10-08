# CLI reference

Generated from `packages/sdk/src/cli-commands.ts` by `scripts/generate-authoring-reference.mjs`. Do not edit. Regenerate with `npm run gen:docs --prefix packages/surface`.

See [SURFACE.md](SURFACE.md#5-invocation-the-cli) for execution semantics and [CLOUD.md](CLOUD.md) for hosted operations.

## Global options

Accepted only as the sole argument, before any verb.

| Option | Description |
| --- | --- |
| `-h, --help` | Print usage and exit. |
| `-V, --version` | Print the SDK version and exit. |

## flows add

Install a helper plugin, or a flow-extension plugin from a public GitHub repository, into this project

| Argument | Required | Description |
| --- | --- | --- |
| `plugin` | Yes | Helper name, @flows/&lt;helper-name&gt;, github:&lt;owner&gt;/&lt;repo&gt;@&lt;ref&gt;#&lt;path&gt;, or a github.com tree URL |

## flows answer

Answer a parked f.human; --cloud also resumes, local answers need flows resume

| Argument | Required | Description |
| --- | --- | --- |
| `run-id` | Yes | Run parked on the question |
| `wait-id-or-answer` | Yes | Local: human-&lt;n&gt; wait id; Cloud: yes or no |
| `answer` | No | Local decision, as yes or no (also true or false) |

| Option | Description | Default |
| --- | --- | --- |
| `--json` | Emit one machine-readable JSON object instead of text | — |
| `--cloud` | Answer and resume a Cloud run using its open wait | — |
| `--source <path>` | Original Cloud flow source when the stored copy is unavailable or truncated | — |
| `--data-dir <dir>` | Daemon data directory | `.relayflowd` |
| `--no-spawn` | Require a running relayflowd rather than starting one | — |
| `--note <text>` | Reason recorded on the journal alongside the answer | — |
| `--by <identity>` | Who answered, when relaying a person’s decision; defaults to the OS user | — |

## flows build

Compile a flow into a sealed, content-addressed bundle

| Argument | Required | Description |
| --- | --- | --- |
| `source` | Yes | flow.yaml, flow.ts, or a bundle directory with --verify |

| Option | Description | Default |
| --- | --- | --- |
| `--out <dir>` | Directory to write the bundle into; not valid with --verify | — |
| `--verify` | Verify an existing bundle directory instead of building | — |
| `--json` | Emit one machine-readable JSON object instead of text | — |

## flows check

Compile, preflight, and validate with the installed runtime when available; never start a run

| Argument | Required | Description |
| --- | --- | --- |
| `source` | Yes | flow.ts, flow.yaml, or spec.json |

| Option | Description | Default |
| --- | --- | --- |
| `--against-daemon` | Require acceptance by the installed relayflowd validator (FLOWS_CHECK_AGAINST_DAEMON=1) | — |
| `--no-daemon-check` | Local compile and preflight only (FLOWS_NO_DAEMON_CHECK=1) | — |
| `--json` | Emit one machine-readable JSON object instead of text | — |
| `--watch` | Re-check on every change to the flow and its imports | — |
| `--explain-warnings` | List every unprovable-effects warning per step instead of one summary line | — |

## flows deploy

Copy a sealed bundle into a file bucket, or deploy a hosted trigger listener

| Argument | Required | Description |
| --- | --- | --- |
| `flow` | Yes | flow.ts for a hosted listener, or &lt;flow&gt;@sha256:&lt;digest&gt; for a bundle |

| Option | Description | Default |
| --- | --- | --- |
| `--to <file-bucket-uri>` | Destination file bucket for a sealed bundle | — |
| `--repo <owner/name\|gitlab:group/project>` | Target repository: owner/name or github:owner/name for GitHub; gitlab:group/project (subgroups allowed) or a github.com/gitlab.com HTTP(S) URL | — |
| `--on <provider>` | Trigger source, as &lt;provider&gt;[:key=value,...]; repeatable | — |
| `--approver <handle>` | Handle delivered to every launched run as input.approver | — |
| `--agents <list>` | Agent harnesses to allow, as claude[,codex] | — |
| `--name <name>` | Name for the hosted listener | — |
| `--draft` | Create the listener without activating it | — |
| `--plugin <ref>` | Send-only GitHub flow-extension ref; repeatable. Does not write flows.json | — |
| `--flow <name\|listener-id>` | Deploy the source as the next version of this flow; its settings stay unchanged | — |
| `--no-connect` | Refuse a missing integration instead of offering to connect it | — |
| `--json` | Emit one machine-readable JSON object instead of text | — |

## flows versions

List a hosted flow’s source versions, the active one marked

| Argument | Required | Description |
| --- | --- | --- |
| `flow` | Yes | Flow name or listener id |

| Option | Description | Default |
| --- | --- | --- |
| `--json` | Emit one machine-readable JSON object instead of text | — |

## flows rollback

Make an earlier (or later) recorded version of a hosted flow the active one

| Argument | Required | Description |
| --- | --- | --- |
| `flow` | Yes | Flow name or listener id |
| `version` | Yes | Version number to activate |

| Option | Description | Default |
| --- | --- | --- |
| `--json` | Emit one machine-readable JSON object instead of text | — |

## flows deployments

List this workspace’s hosted trigger listeners

| Option | Description | Default |
| --- | --- | --- |
| `--json` | Emit one machine-readable JSON object instead of text | — |

## flows hn-monitor

Hacker News monitor: poll for matching stories and launch a flow per hit

## flows hn-monitor start

Start polling in the foreground

| Argument | Required | Description |
| --- | --- | --- |
| `spec` | Yes | Monitor spec.json |

| Option | Description | Default |
| --- | --- | --- |
| `--data-dir <dir>` | Daemon data directory | `.relayflowd` |
| `--poll-interval-ms <ms>` | Milliseconds between polls | — |

## flows logs

Read a hosted run’s runner log, or one agent step’s transcript, from Cloud

| Argument | Required | Description |
| --- | --- | --- |
| `run-id` | Yes | Hosted run id, as `flows runs` lists it |

| Option | Description | Default |
| --- | --- | --- |
| `--step <name>` | Show that agent step’s transcript instead of the runner log | — |
| `--raw` | Print the transcript JSONL unrendered (still redacted) | — |
| `--follow` | Append new runner output until the run ends; exits with the run’s outcome | — |
| `--json` | Emit one machine-readable JSON object instead of text | — |

## flows observer

Mint a read-only observer link without running a flow

| Option | Description | Default |
| --- | --- | --- |
| `--data-dir <dir>` | Daemon data directory | `.relayflowd` |

## flows plugin

Inspect, remove, or update the flow-extension plugins recorded in flows.lock.json

## flows plugin list

List installed flow extensions in composition order

| Option | Description | Default |
| --- | --- | --- |
| `--json` | Emit one machine-readable JSON object instead of text | — |

## flows plugin verify

Re-hash .flows/plugins against the lockfile and, unless --offline, against the pinned commit on GitHub

| Option | Description | Default |
| --- | --- | --- |
| `--json` | Emit one machine-readable JSON object instead of text | — |
| `--offline` | Skip the GitHub re-fetch; check only the local store against the lockfile | — |

## flows plugin remove

Drop a flow-extension plugin from flows.json, the lockfile, and the local store

| Argument | Required | Description |
| --- | --- | --- |
| `name` | Yes | Plugin name as recorded in the lockfile |

| Option | Description | Default |
| --- | --- | --- |
| `--json` | Emit one machine-readable JSON object instead of text | — |

## flows plugin update

Re-resolve a flow-extension plugin, show the permissions/events/budget diff, and rewrite the lock with --yes

| Argument | Required | Description |
| --- | --- | --- |
| `name` | No | Plugin name; omit to update every installed flow extension |

| Option | Description | Default |
| --- | --- | --- |
| `--json` | Emit one machine-readable JSON object instead of text | — |
| `--to <ref>` | GitHub reference to resolve instead of the locked commit | — |
| `--yes` | Apply the update; without this flag the diff is printed and the lock is left unchanged | — |

## flows replay

Replay a finished run from its local journal

| Argument | Required | Description |
| --- | --- | --- |
| `run-id` | Yes | Run id to replay |

| Option | Description | Default |
| --- | --- | --- |
| `--json` | Emit one machine-readable JSON object instead of text | — |
| `--data-dir <dir>` | Daemon data directory | `.relayflowd` |
| `--at <step-id>` | Replay up to this step | — |
| `--allow-human-influenced` | Proceed even though the run carries human-influenced state | — |

## flows resume

Resume an interrupted local run from where its journal left off

| Argument | Required | Description |
| --- | --- | --- |
| `run-id` | Yes | Run id to resume |

| Option | Description | Default |
| --- | --- | --- |
| `--json` | Emit one machine-readable JSON object instead of text | — |
| `--data-dir <dir>` | Daemon data directory | `.relayflowd` |
| `--local-agent` | Run agent steps in this process (bound to this terminal unless --detach) | — |
| `--detach` | Start in a separate process, print the run handle and exit; follow with flows status | — |
| `--agent-capacity <n>` | With --local-agent, how many agent steps (and, separately, LLM steps) run at once (1-32) | `4` |
| `--no-spawn` | Require a running relayflowd rather than starting one | — |
| `--no-observer-link` | Do not mint an observer link for this run | — |
| `--cloud-mirror` | Also put this run on the Cloud dashboard (also FLOWS_CLOUD_MIRROR=1) | — |
| `--allow-human-influenced` | Proceed even though the run carries human-influenced state | — |

## flows run

Run a flow locally, or submit it to Cloud with --cloud

| Argument | Required | Description |
| --- | --- | --- |
| `flow` | Yes | flow.yaml, flow.ts, spec.json, or &lt;flow&gt;@sha256:&lt;digest&gt; |

| Option | Description | Default |
| --- | --- | --- |
| `--json` | Emit one machine-readable JSON object instead of text | — |
| `--data-dir <dir>` | Daemon data directory | `.relayflowd` |
| `--local-agent` | Run agent steps in this process (bound to this terminal unless --detach) | — |
| `--detach` | Start in a separate process, print the run handle and exit; follow with flows status | — |
| `--agent-capacity <n>` | With --local-agent, how many agent steps (and, separately, LLM steps) run at once (1-32) | `4` |
| `--no-spawn` | Require a running relayflowd rather than starting one | — |
| `--no-observer-link` | Do not mint an observer link for this run | — |
| `--cloud-mirror` | Also put this run on the Cloud dashboard (also FLOWS_CLOUD_MIRROR=1) | — |
| `--allow-human-influenced` | Proceed even though the run carries human-influenced state | — |
| `--input <json-or-file>` | Input for an authored .flow.ts, inline JSON or a file path | — |
| `--bucket <file-bucket-uri>` | File bucket to fetch a sealed bundle from | — |
| `--reuse-from <run-id>` | Reuse memoized step outputs from an earlier run | — |
| `--cloud` | Submit to Agent Relay Cloud instead of running locally | — |
| `--wait` | With --cloud, poll until the hosted run reaches a terminal state | — |
| `--sync-code` | With --cloud, upload the working directory as the run’s tree; pull results back with `flows sync` | — |
| `--no-connect` | With --cloud, refuse a missing integration instead of offering to connect it | — |

## flows runs

List the hosted runs this Cloud credential can read, newest first

| Option | Description | Default |
| --- | --- | --- |
| `--limit <n>` | How many runs to show | `20` |
| `--json` | Emit one machine-readable JSON object instead of text | — |

## flows schedule

Register a flow to run in Cloud on a cron or interval, or on the one it declares

| Argument | Required | Description |
| --- | --- | --- |
| `flow` | Yes | flow.yaml or flow.ts submitted on every fire |

| Option | Description | Default |
| --- | --- | --- |
| `--cron <expr>` | Cron expression to fire on; with neither this nor --every, the flow’s own schedule.* handler supplies it | — |
| `--every <duration>` | Fixed cadence, as &lt;n&gt;&lt;s\|m\|h\|d&gt;; not valid with --cron | — |
| `--tz <iana>` | IANA timezone the cron is read in | — |
| `--input <json-or-file>` | Input for an authored .flow.ts, inline JSON or a file path | — |
| `--name <name>` | Name for the schedule | — |
| `--no-connect` | Refuse a missing integration instead of offering to connect it | — |
| `--json` | Emit one machine-readable JSON object instead of text | — |

## flows schedules

List this workspace’s Cloud schedules

| Option | Description | Default |
| --- | --- | --- |
| `--json` | Emit one machine-readable JSON object instead of text | — |

## flows serve-webhook

Run the local webhook receiver that writes provider deliveries into the trigger inbox

| Option | Description | Default |
| --- | --- | --- |
| `--data-dir <dir>` | Daemon data directory | `.relayflowd` |
| `--port <port>` | Port to listen on, bound to 127.0.0.1; required | — |
| `--allow <names>` | Comma-separated flow names this receiver admits | — |

## flows status

Show a run’s steps, attempts, leases and last verdicts from its journal, or from Cloud with --cloud

| Argument | Required | Description |
| --- | --- | --- |
| `run-id` | No | Run to inspect; defaults to RELAYFLOW_RUN_ID inside a step |

| Option | Description | Default |
| --- | --- | --- |
| `--json` | Emit one machine-readable JSON object instead of text | — |
| `--data-dir <dir>` | Daemon data directory | `.relayflowd` |
| `--tail <n>` | Lines of each agent attempt’s transcript tail to show | — |
| `--cloud` | Read the run from Cloud instead of a local journal; needs the run id | — |
| `--watch` | With --cloud: redraw until the run ends, then exit with its outcome | — |

## flows sync

Apply a hosted run’s code changes to a local tree (replaces `agent-relay cloud sync`)

| Argument | Required | Description |
| --- | --- | --- |
| `run-id` | Yes | Hosted run id whose patch to apply |

| Option | Description | Default |
| --- | --- | --- |
| `--json` | Emit one machine-readable JSON object instead of text | — |
| `--dry-run` | Print the patch and apply nothing | — |
| `--dir <path>` | Tree to apply the patch to | `.` |

## flows tick

Interval scheduler: launch a flow on a fixed local cadence

## flows tick start

Start ticking in the foreground

| Argument | Required | Description |
| --- | --- | --- |
| `spec` | Yes | Flow spec.json to launch each tick |

| Option | Description | Default |
| --- | --- | --- |
| `--data-dir <dir>` | Daemon data directory | `.relayflowd` |
| `--schedule-id <id>` | Stable id identifying this schedule | — |
| `--interval-ms <ms>` | Milliseconds between ticks | — |
| `--epoch-ms <ms>` | Epoch the tick grid is aligned to | — |
| `--max-catch-up <n>` | Most missed ticks to replay after a gap | — |
| `--poll-interval-ms <ms>` | Milliseconds between schedule polls | — |

## flows undeploy

Remove a hosted trigger listener

| Argument | Required | Description |
| --- | --- | --- |
| `deployment-id` | Yes | Deployment id to remove |

| Option | Description | Default |
| --- | --- | --- |
| `--json` | Emit one machine-readable JSON object instead of text | — |

## flows unschedule

Remove a Cloud schedule, so it stops firing

| Argument | Required | Description |
| --- | --- | --- |
| `schedule-id` | Yes | Schedule id to remove |

| Option | Description | Default |
| --- | --- | --- |
| `--json` | Emit one machine-readable JSON object instead of text | — |
