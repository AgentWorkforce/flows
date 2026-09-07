# Running the workflows

There are two engines here. `flows` (this repository's SDK + `relayflowd`)
accepts the `version: '0.1.0'`, top-level `steps:` dialect. `relayflows` is
the previous engine: its `version: '1.0'`, `swarm:` / `workflows:` dialect is
not accepted by `flows`. Changing the launch location does not translate it.

| Workflow | Engine | Placement and external dependencies |
| --- | --- | --- |
| `drive-local.yaml` | `flows` / local kernel | Local, deterministic F8b work package from `ops/BACKLOG.md`. Requires built SDK, local kernel, Node/npm and a work branch. Runtime has no Cloud, Daytona, Relaycast, GitHub or model call. Installation needs package registries. |
| `preswarm-check.yaml` | `flows` / local kernel | Local review of a committed diff against `main` (or `BASE_REF`). Invokes installed/authenticated Claude, Codex and OpenCode CLIs; those use their model services. No Cloud admission or Daytona. Passing `flows check` proves only that `sh` resolves, not the nested reviewers' auth. |
| `drive.yaml` | Previous `relayflows` engine | Written for either an existing checkout or a cloud snapshot. Local operation requires that engine plus Claude/Codex and toolchains; PR delivery needs GitHub access. Cloud snapshot delivery uses the Cloud proxy or external recovery. Its sync step resets/checks out branches: do not run it over an active worktree. |
| `drive-cloud.yaml` | Previous `relayflows` engine | Generated cloud-oriented drive loop. Its documented delivery path relies on Cloud run artifacts and `agent-relay cloud sync`. Local execution would not reproduce that delivery contract. Do not hand-edit the generated file. |
| `bootstrap-gate1.yaml` | Previous `relayflows` engine | Bootstrap using the previous generation, per RFC §2.1. No intrinsic Cloud/Daytona command; needs Claude, Codex, OpenCode, Rust/npm and writable source. Historical bootstrap, not a harmless smoke test. |
| `review-swarm.yaml` | Previous `relayflows` engine | Repository CI launches this in Cloud with staged `.review-target` artifacts. The steps could run under a local legacy engine with those artifacts and all three authenticated reviewers; Cloud is the CI placement, not a kernel requirement. It writes `/tmp` review inputs and commits transcripts. |
| `watchdog.yaml` | Previous `relayflows` engine | Requires Cloud API access even with a local executor: it inspects `agent-relay cloud schedules`. Also needs GitHub, Claude and Relaycast channel delivery. |

These are dependency classifications from the checked-in workflows and
launchers, not claims that the legacy flows completed on this machine. Their
first observed failure with the current SDK is `invalid_spec`. Literal
checks and current execution evidence are in [RUNTIME-STATUS](../ops/RUNTIME-STATUS.md).

## Start a local run

After building the SDK and kernel (commands in RUNTIME-STATUS):

```sh
node scripts/run-local-workflow.mjs testdata/hello-deterministic.flow.yaml
node scripts/run-local-workflow.mjs workflows/drive-local.yaml
```

The launcher starts a fresh local daemon, submits through the journal
protocol, prints journal entries and the terminal report, then stops its
daemon. `LOCAL_DATA_DIR` contains the SQLite journal and a `journal.jsonl`
export. It can also attach the SDK worker for stream-only agent steps;
bare LLM steps and agent workspace/external surfaces are refused before
submission. This is a bounded local runner, not a cloud scheduler or sandbox.
Agent CLIs use the host's existing execution/auth configuration; it supplies
no filesystem isolation, workspace reset, or lease heartbeat loop. The agent
wiring test uses a deterministic wrapper, not a model service.

`drive-local.yaml` executes one explicitly selected package (F8b), rather than
autonomously choosing arbitrary engineering work. It refuses a dirty target,
changed source, or an already-applied package. Its implementation step checks
the before/after bytes. Existing SDK tests run as a dependent deterministic
step, with their stdout in the journal. Commit and PR delivery remain an
operator action; a human owns merge. After F8b is delivered, use the hello
flow for a repeatable smoke run. The scaffold commit recorded in
RUNTIME-STATUS is the reproducible starting point for the F8b tick.

`scripts/run-workflow.sh` is still the legacy launcher: it requires a
stored Relaycast workspace key and mints an observer link before invoking
`relayflows run`. Use the local launcher above when proving independence
from Cloud and Relaycast; local journals remain the source of truth.
