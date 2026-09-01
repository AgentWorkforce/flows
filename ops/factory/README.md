# Factory driver

Long-running bash loop that produces PRs against
`AgentWorkforce/flows` by spawning up to N concurrent Claude Code
agents on `agent-relay`. Each agent picks one task from
`ops/factory/queue.md`, works on it in an isolated scratch worktree,
runs `flows run workflows/preswarm-check.yaml` before pushing,
opens a PR, and returns. The existing
`com.agentworkforce.review-swarm` + `com.agentworkforce.auto-merge`
launchd loops handle review + merge.

## Scope and RFC-0001 posture

**This is scaffolding, not the end state.** RFC-0001 §3 gate 3
explicitly targets "Factory's ~10 hand-rolled claim protocols" for
migration onto the kernel — a bash driver whose queue lives in a
markdown file and whose claim state is regex-parsed is a NEW
hand-rolled protocol of exactly the shape the RFC intends to kill.
Shipping it now is a deliberate trade: the concurrent-authoring
unblock has to happen before gate 3 lands (otherwise no one is
authoring the gate-3 PR either), so this ships with the migration
receipt written into it. The follow-up brief
(`ops/factory/briefs/factory-as-relayflow.md`, to be added) is to
port this driver to `workflows/factory-tick.yaml` — one flow run
per task, kernel-owned claim/lease, no markdown mutation — as soon
as an agent-relay spawn primitive is available in the SDK.

## Why this exists

Everything shipped up to PR #125 was authored by me sitting in a
session. When the session ends, no new PRs get authored — the
review/merge loops keep spinning but there is nothing to review.
The factory driver IS the "runs for hours" authoring loop the
gate-2/3/4 program needs.

The old `ops/autodrive.sh` played the same role and shipped
garbage — no pre-swarm-check, no rulebook-parity gate, prose task
selection. The factory addresses each:

- **Parseable queue** (`ops/factory/queue.md`) — one line per
  task, claim status in the leading brackets. See "Concurrency
  model" below for the honest description of what actually
  serializes claims.
- **Pre-swarm-check runs BEFORE push** — the same three-lens flow
  that landed in PR #123 runs against each worker's diff; a
  REVIEW_FAILED locally means the worker keeps iterating, not
  pushing.
- **Self-modification refused (at the diff, not the brief)** —
  after a worker reports success, the driver checks its worktree
  diff against `origin/main` and refuses to record `- [x]` if any
  file under `ops/factory/**` was touched. See "Self-modification
  rail" below.

## Layout

    ops/factory/
      README.md                — this file
      queue.md                 — parseable task queue
      driver.sh                — main loop; run this
      spawn-worker.sh          — spawns ONE agent for ONE task
      brief-template.md        — the brief handed to each agent
      briefs/                  — per-task brief documents
        <task-id>.md

## Usage

Run the driver from a checkout of the repo that CONTAINS
`ops/factory/` — this is `AgentWorkforce/flows` (the repo
`driver.sh` computes `REPO_ROOT` from
`$FACTORY_ROOT/../..`, so the driver expects to sit two
levels down from the repo root):

    cd ~/AgentWorkforce/flows
    sh ops/factory/driver.sh

By default the driver spawns up to 3 concurrent workers, claims
tasks from `ops/factory/queue.md`, waits for each to finish, then
picks the next batch. Cadence is bounded by task duration
(typically 15-60 min per PR including swarm iters).

Configuration via env vars:

- `FACTORY_MAX_WORKERS` (default `3`) — concurrent agent-relay
  spawns.
- `FACTORY_NODE` (default `sf-mini`) — agent-relay node to spawn
  workers on.
- `FACTORY_WORKSPACE_KEY` — passed to `agent-relay fleet spawn`
  when the node is not in the current workspace.
- `FACTORY_ITERATION_CAP` (default `50`, unit: ticks) — abort
  after this many outer-loop iterations; belt-and-suspenders
  against a runaway loop.

## Concurrency model

- The DRIVER itself is single-instance. `driver.sh` writes
  `factory-driver.lock` at start and refuses to run if the file
  exists. This is the only mechanism that prevents two claim
  loops from racing on the same queue line.
- Within one driver, `claim_tasks` and `rewrite_line` are called
  sequentially from a single loop; there is no in-driver
  concurrency on queue mutation. Workers themselves NEVER touch
  `queue.md` — the driver writes the outcome after each worker
  returns.
- No queue-file lock ships. Earlier iters carried a
  `factory-queue.lock` (flock/mkdir) sold as defense-in-depth,
  but the design was wrong — `list_unclaimed` read line numbers
  OUTSIDE the lock while `rewrite_line` wrote them INSIDE, so a
  sibling script could still shift lines between read and write.
  Shipping documented-dead, provably-broken code violated
  AGENTS.md #6, so it was deleted. If a sibling script ever
  needs to mutate `queue.md`, the fix is a single lock spanning
  the whole read-modify-write, not a half-lock reintroduced.
- Each worker gets its own agent name (`factory-t<tick>-w<i>-<task-id>`)
  so agent-relay does not collide.

## Self-modification rail

Three layers, only the last is proof.

**Refused paths — all THREE judges the factory uses:**
- `ops/factory/**`             (this driver, briefs, template)
- `ops/preswarm-check/**`      (local pre-swarm runner)
- `workflows/preswarm-check.yaml`  (pre-swarm workflow)

RFC-0001 settled decision #6 makes this categorical: no gate is
editable by the agents it judges. Missing any of the three in
the refuse-list would let a worker replace the workflow that
invokes its own judges — the whole rail collapses.

The three enforcement layers:

1. `brief-template.md` names each refused path in rule #2.
   Advisory — the agent may or may not read it.
2. Pre-swarm-check M lens reviews the diff before push. Catches
   most, but the lens can miss and the agent could bypass it.
3. `driver.sh` checks `git diff --name-only origin/main..HEAD` in
   the worker's worktree AFTER the worker reports STATUS=opened.
   The check is FAIL-CLOSED across every code path:
   - Missing PR number in `FACTORY_RESULT` → refuse.
   - Missing worktree (external cleanup, disk pressure) → refuse.
   - `git diff` exits non-zero (corrupted git state) → refuse.
   - Any file matching the refuse-list appears in the diff →
     refuse.
   Refused tasks go to `- [!]` with an explicit reason string;
   a human triages.

The brief-template list and the driver grep read the same three
paths; if you edit one you must edit the other. This is called
out in the inline comment on `driver.sh`'s `forbidden=` line.

A spawn-time grep of the brief text is deliberately NOT used:
every brief mentions the refused paths in its rules block
(telling the agent "do not touch these"), so a text grep would
refuse every brief. The DIFF is the source of truth.

## Known limitations

- **Not a real relayflow yet** — see "Scope and RFC-0001 posture"
  above. The migration is planned, not immediate.
- **Failed tasks are NOT auto-retried.** `- [!]` items sit in the
  queue for a human to triage — a task that fails from a real
  bug in the brief is a human's problem to fix; the driver does
  not know how to re-scope.
- **No cross-task coordination.** Two workers picking tasks that
  touch overlapping files will produce PRs that conflict at merge
  time. Concurrency limit of 3 is a soft mitigation; genuine
  parallel-safety is on the task-author to check.
- **No cost tracking.** Each `agent-relay fleet spawn claude`
  is billable; the driver just runs.
- **No `git fetch` timeout.** A hung network hangs the driver
  indefinitely at `prepare_worktree`; operator can kill and
  restart safely (the driver lock will be cleaned by the trap on
  most exits, or removed by hand if the process is `-9`'d).
- **No auto-recovery for stranded `- [~]` claims.** If the driver
  dies (SIGKILL, host reboot, `prepare_worktree` OOM) between
  `claim_tasks` writing `- [~]` and the result loop writing
  `- [x]` / `- [!]`, that task is stranded — `list_unclaimed`
  only matches `^- \[ \] ` and will never re-pick a `- [~]`
  line. Operator recovery is manual: after a hard crash, grep
  `queue.md` for `^- \[~\]` and hand-edit each stale line back
  to `- [ ] TASK_ID: <summary>`. Age-out via the embedded ISO
  timestamp is a reasonable follow-up (the timestamp is already
  written; the reclaimer just needs to read it and reset lines
  older than a threshold), deferred until observed. Until then,
  do not treat `- [~]` as ephemeral.
- **INT/TERM traps clean only the driver lock**, not worktrees
  or per-tick TSV files under `${FACTORY_LOG_DIR}`. A
  `prepare_worktree` retry self-heals a leaked worktree for the
  SAME task ID; different-task runs accumulate `/tmp/factory-
  worktree-*` until the operator runs `git worktree prune` and
  `rm -rf /tmp/factory-*`.
- **No tests for `driver.sh` yet.** The state-cycle transitions
  and the diff-check refuse logic are exercised in production
  only. A shell-harness test is on the human backlog (see
  `queue.md`'s trailing comment for why it can't be a factory
  task).
