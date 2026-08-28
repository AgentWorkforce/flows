# Audit — making the drive loop execute in Agent Relay Cloud without the laptop

Date: 2026-08-28. Branch: `flow/cloud-execution`. Worktree: `/tmp/cloud-exec`.

## 1. Why every cloud tick died at step 1

`sync` ran `git fetch origin`. A cloud workflow sandbox has no `origin`, and it
never did. Traced end to end:

- The CLI tars the **`git ls-files` set only — no `.git`** and uploads it as
  `code.tar.gz` (`relay/packages/cloud/src/workflows.ts:798-810`). Code sync is
  on by default (`relay/packages/cloud/src/workflow-paths.ts:403-405`).
- The bootstrap extracts it into the code mount and then **synthesizes** a repo:
  `git init` plus a baseline commit
  (`cloud/packages/core/src/executor/executor.ts:283`,
  `cloud/.../bootstrap-inner.mjs:1708-1725`).
- **Nothing in the workflow-launch path ever runs `git clone`.** The platform's
  clone helper `buildGitWorkspaceSyncShell`
  (`cloud/packages/web/lib/integrations/git-workspace-sync-script.ts:73`) has
  exactly two callers, neither of them workflows: the cloud-agent box manager
  and proactive deployment triggers.
- `/project` is not the workdir. `command:` steps run in
  `/project/workflows/runs/<uuid>` — a relayfile-mirrored directory, not a FUSE
  mount and not a clone (`cloud/packages/web/lib/workflows/relayfile-mount.ts:6,169-172`;
  `cloud/packages/core/src/bootstrap/launcher.ts:2370-2381`).

So there is a repo, with files, and no history and no remote. `git fetch origin`
is the one thing that cannot work there.

## 2. What changed

`workflows/drive.yaml`, two steps.

**`sync`** — asserts materialization instead of assuming a clone, then branches
on what the environment actually is:

- Missing repo → `SYNC_FAIL_NOT_MATERIALIZED`, exit 78, naming the missing
  paths and the `--no-sync-code` cause. Fails closed and typed.
- `origin` exists (laptop, fleet node) → `SYNC_MODE=remote`: real fetch and
  `origin/main` checkout. Unchanged behavior for the path that works today.
- No `origin` (cloud sandbox) → `SYNC_MODE=snapshot`: the uploaded snapshot IS
  the base; commit it so `main` exists for the review step's `git diff main`.

**`pr`** — names each delivery precondition before using it. A sandbox with no
remote now emits `PR_BLOCKED_NO_REMOTE` (exit 75) pointing at
`agent-relay cloud sync $RUN_ID`, and one with a remote but unauthenticated `gh`
emits `PR_BLOCKED_NO_GH_AUTH`, instead of dying on an opaque git error after
five expensive agent steps.

## 3. Evidence — run `404a8386-a129-40b0-9e5b-8ec9ad433038`

Submitted from this worktree: `agent-relay cloud run workflows/drive.yaml --json`

```
{
  "runId": "404a8386-a129-40b0-9e5b-8ec9ad433038",
  "status": "pending",
  "launchJobId": "9202f8cc-d206-4620-871d-e4e7895662c4"
}
```

`workflow_launch_jobs` row:

```
id           | 9202f8cc-d206-4620-871d-e4e7895662c4
run_id       | 404a8386-a129-40b0-9e5b-8ec9ad433038
status       | launched
attempts     | 2
sandbox_id   | b02dd914-d10e-432d-af0d-5a809190019d
last_error   | (none)
started_at   | 2026-08-28 05:16:43.09+00
completed_at | 2026-08-28 05:16:50.767+00
created_at   | 2026-08-28 05:15:39.802054+00
```

Step transitions, verbatim from `agent-relay cloud logs 404a8386-...`:

```
[bootstrap] Code extracted to /project/workflows/runs/861f3cce-f349-4be8-b6be-e7aaea3cf907
[bootstrap] Mounted setup-token env for anthropic
[bootstrap] Mounted credentials for openai at /home/daytona/.codex/auth.json
[bootstrap] Baseline committed with 212 tracked files (clean tree).
[workflow 00:00] Starting workflow "drive-tick" (8 steps)
[workflow 00:01] [sync] Output:
```
SYNC_WORKDIR=/project/workflows/runs/861f3cce-f349-4be8-b6be-e7aaea3cf907
SYNC_MATERIALIZED=ok
SYNC_MODE=snapshot
SYNC_BASE=3fdb63c
SYNC_BRANCH=flow/drive-3fdb63c-08280517
SYNCED
```
[workflow 00:01] [assess] Started (owner: lead, specialist: lead)
[workflow 00:01] [assess] Spawning owner "lead" (cli: claude)
[workflow 02:09] [assess] Output:
```
ASSESS_DONE
...
```
[workflow 02:09] [build] Started (owner: builder, specialist: builder)
[workflow 02:09] [build] Spawning owner "builder" (cli: codex)
```

That is `sync` green, `assess` green, `build` running — the first cloud tick to
get past step 1.

Note on capture: `workflow_steps` rows are written at run completion, not per
step, so the transition evidence above is the run log rather than a DB query.
Queried at 05:31Z the step table was empty for this run while the run was live.

## 4. What credentials a cloud sandbox actually gets

Verified against `provider_credentials` for the flows workspace
`50587328-441d-4acb-b8f3-dbe1b3c5de99` and against the run log above.

**Working, no action needed:**

- `claude` — anthropic `oauth_token` (a `claude setup-token`), `is_active = t`,
  `last_used_at 2026-08-28 05:01:58Z`. The launcher exports
  `CLAUDE_CODE_OAUTH_TOKEN` (`cloud/packages/core/src/auth/cli-credentials.ts:249-257`).
  Log line: `[bootstrap] Mounted setup-token env for anthropic`.
- `codex` — openai `relay_managed`, active. Mounted to `~/.codex/auth.json`.
  Log line: `[bootstrap] Mounted credentials for openai at /home/daytona/.codex/auth.json`.

Both agent CLIs authenticate today. The `assess` step above is the proof.

**Missing — this is the blocker:**

- **`gh` is installed but unauthenticated, and there is no GitHub token in a
  workflow sandbox.** `gh` is in the image
  (`cloud/deploy/daytona/Dockerfile:102-107`); neither `GH_TOKEN` nor
  `GITHUB_TOKEN` is ever written by the launch path. `envSecrets` is the only
  channel (`launcher.ts:2293-2300`) and `agent-relay cloud run` has **no
  `--env` flag** (`relay/packages/cli/src/cli/commands/cloud.ts:1264-1290`), so
  a `cloud run` launch sends none.
- **The GitHub-App-via-Nango path exists but does not cover this repo.**
  `WORKFLOW_GITHUB_WRITE_GRANTS`
  (`cloud/packages/web/lib/workflows/invocation-registry.ts:78-107`) is a
  hardcoded array of three entries, all `AgentWorkforce/cloud`, all with
  `envTokenNames: []` — so `mintWorkflowGithubWriteToken` is never even reached
  from the sandbox path. `AgentWorkforce/flows` appears nowhere in the cloud
  repo.
- Both the grant path and `POST /api/v1/github/pull-request` additionally
  require `auth.source === "relayfile"` with a `relayfileSponsorId` whose
  deployed persona name equals the grant slug, plus scope
  `workflow:invoke:write` (`.../github/pull-request/route.ts:88-92,131-168`).
  A sandbox's scoped cloud token is not `cli:auth` and is not relayfile-sourced,
  so it cannot call that endpoint either.
- The repo allowlist is **not** the obstacle: enforcement is relaxed unless
  `CLOUD_REPO_ALLOWLIST_ENFORCED=true`, and relaxed mode returns
  `pushAllowed: true`
  (`cloud/.../workflow-repository-allowlists.ts:138-207`). The table is empty
  and that is fine. The workspace does have a GitHub App install
  (`workspace_integrations`, provider `github`, installation `136074460`).

`AgentWorkforce/flows` is **private**, so even a read-only `git fetch` from the
sandbox would need credentials.

## 5. A second, independent defect: the cron runs a frozen spec

Editing `workflows/drive.yaml` in the repo does **not** change what the schedule
executes. `agent-relay cloud schedule` stores a copy of the YAML in the schedule
row; the scheduled run never reads the repo.

```
name        | cron        | workflow_bytes | schedule id
flows-drive | 0 */4 * * * | 4871           | d646ad61-7d4b-44d4-be0d-71a892c9d8cc
flows-drive | 0 */4 * * * | 4869           | c8b6b7d0-f7cd-4a4e-99bc-354c9e562dda
```

Matching those byte counts against git:

```
7262 bytes  f59d9cd0  fix(drive): verdict reads the last verdict token   <- origin/main
...
4871 bytes  053b93b3  fix(drive): adversary cli grok -> claude           <- schedule d646ad61
4869 bytes  3ebcff74  ops: autonomy layer                                <- schedule c8b6b7d0
```

Two consequences:

1. Both schedules run a spec from **nine commits ago**. Six subsequent gate
   fixes — verify-cannot-fail, typed review verdicts, covenant 3 — are not in
   what the cloud executes.
2. There are **two active `flows-drive` schedules on the same cron**, which is
   why 02:00Z produced two runs (`4cf36ea7` and `b33c2c9a`), both dying at
   `sync`. One should be deleted.

Re-registering the schedule is a cloud state change and was out of scope for
this audit; it is listed as a required manual step below.

## 6. Fleet path (sf-mini / finn-mini) — evaluated, not recommended as-is

The control plane is genuinely laptop-independent: each node holds an outbound
WebSocket to `cast.agentrelay.com` (`relay/crates/broker/src/node_control.rs:30-56`),
and `fleet spawn` dispatches through the cloud engine, not through
`chief-broker`. A spawned agent is a PTY child of the *remote* broker and
survives the laptop disconnecting. `agent-relay fleet status` reports no local
broker running here, yet `fleet nodes` works — that is the evidence.

But:

- **`fleet spawn` spawns one CLI agent, not a workflow DAG.** No node advertises
  any `workflow:*` capability; the relayflows runner has no node awareness. The
  node-local workflow runner (`agent-relay node workflow run`) must be invoked
  *on* the node.
- **Fleet has no scheduler.** Fleet triggers are message-driven only
  (`FleetTriggerDescriptor.type` is `'message'`). Cron exists only in Cloud and
  cannot target a node. A scheduled tick on a mini means hand-rolled `launchd`.
- Live inventory (over SSH, both nodes reachable):

| | sf-mini | finn-mini |
|---|---|---|
| flows checkout | **absent** | **absent** |
| `relayflows` | shim present, no version set | **absent** |
| `cargo` / `rustc` | present | **absent** (needed by `verify`) |
| `claude` / `codex` / `gh` / `git` / `node` | present | present |
| `claude -p` probe | `Not logged in - Please run /login` | `Failed to authenticate: OAuth session expired and could not be refreshed` |
| `gh auth status` | `The token in default is invalid` (kjgbot) | `The token in default is invalid` (miyaontherelay) |

So the fleet path needs a checkout, a Rust toolchain on finn-mini, a `launchd`
job, **and** two interactive re-authentications — versus the sandbox path, which
already has working `claude` and `codex` and needs only GitHub write.

**Recommendation: keep the cloud sandbox as the primary path.** It now gets past
`sync`, and its one remaining gap (GitHub write) is a narrower, better-understood
fix than re-establishing four things on a mini. sf-mini is the better fallback of
the two nodes (it has the Rust toolchain); finn-mini is not viable for `verify`
without one.

## 7. What remains manual — exact commands

1. **Re-register the schedule** so cron stops running the nine-commit-old spec,
   and delete the duplicate. From a checkout of this branch after merge:
   ```
   agent-relay cloud schedules            # confirm the two flows-drive rows
   agent-relay cloud schedule workflows/drive.yaml --cron "0 */4 * * *" --name flows-drive
   ```
   Then delete the two stale schedules (`d646ad61-...`, `c8b6b7d0-...`).
   Until this is done, the fix in this PR only affects manual `cloud run`s.
2. **Give the sandbox GitHub write.** No PAT, no `gh auth login`. The App path
   needs a cloud-side change Khaliq must approve and deploy:
   add an `AgentWorkforce/flows` entry to `WORKFLOW_GITHUB_WRITE_GRANTS` in
   `cloud/packages/web/lib/workflows/invocation-registry.ts`, and route the `pr`
   step through `POST /api/v1/github/pull-request` (App-authored, via Nango)
   rather than `git push` + `gh pr create`. That endpoint also requires the run
   to carry a relayfile persona sponsor whose deployed name matches the grant
   slug. Until that lands, cloud ticks do useful work and cannot deliver it.
3. **Optional, if the fleet fallback is wanted:** on `sf-mini`,
   `gh auth login`, `claude` `/login`, `git clone` the repo, and a `launchd`
   plist invoking `agent-relay node workflow run workflows/drive.yaml`.

## 8. Not done

- No production deploy, no production DB write, no secret rotation, no merge.
- The schedule was not re-registered (cloud state change, out of scope).
- Run `404a8386` was left running past `build`; its `pr` step is expected to emit
  `PR_BLOCKED_NO_REMOTE`, which is the honest outcome of §4, not a regression.
