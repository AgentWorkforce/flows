# land

One pinned change — `(repo, sha, session)` — reviewed, gated, fixed and, in
shadow mode, planned as a squash commit that is **never pushed**. This is the
flows piece of the autonomous land flow spec,
[AgentWorkforce/cloud#5806](https://github.com/AgentWorkforce/cloud/issues/5806)
(§5, §7, §8), at rollout phase 0-1: **shadow mode only**.

It is generic. Each repository names its own review and CI flows in a
`land.config.json` at its root ([schema](land.config.schema.json)); this flow
runs them as nested `flows run` processes. It lives under `examples/` beside
the other deployable flows because Cloud deploys an authored flow by path from
this repository, and it is self-contained for the same reason: Cloud submits an
authored `.flow.ts` as one source and refuses local imports
([CLOUD.md](../../docs/CLOUD.md), "Current limits and scope"). That is why the
config validator and the pure helpers share the flow file instead of their own
modules.

## One hosted run per stage (Decision A)

**Status:** cloud#5806 Decision A (one hosted run per stage, 40-min cap
unchanged): relayed as final by emgrok on 2026-10-29, awaiting Khaliq's direct
confirmation. Cloud's 40-minute hosted run ceiling
(`relayflow-v2-run-ceiling.ts`) stays as it is. Each invocation runs exactly
one stage against `<stateDir>/land-state.json`, then ends with a JSON
completion detail. Cloud's land queue chains the next run from that detail:

```sh
flows run examples/land/land.flow.ts --input '{
  "stage": "A-adversarial", "repo": "AgentWorkforce/relay-desktop", "sha": "<40 hex>",
  "sessionId": "<session id>", "intentFile": "/runs/intent/<runId>/intent.md",
  "stateDir": "/runs/<runId>", "runUrl": "https://…/runs/<runId>", "ref": "land/<user>/<sha7>"
}'
# completion detail: {"land":"next","stage":"A-context","seq":1}
#               or:  {"land":"terminal","state":"needs_human","seq":7,"detail":"Land relay-desktop@abc1234 stuck: …"}
```

Run it from a fresh clone of the repository, checked out at `sha`.

| Input | Meaning |
| --- | --- |
| `stage` | the one stage this run executes; it must equal the state's cursor |
| `repo` | `owner/name` |
| `sha` | the pinned 40-hex commit; the checkout's `HEAD` must equal it and be clean |
| `baseBranch` | optional; must agree with `land.config.json` |
| `sessionId` | goes into the `Relay-Session:` trailer |
| `intentFile` | absolute, outside the checkout; given to context review and the fix agent only |
| `stateDir` | absolute, outside the checkout, persisted between stage runs; every byte the run writes. Its basename is the `Land-Run:` id |
| `config` | inline config, or a repo-relative path read with `git show <sha>:<path>` at the first stage; default `land.config.json` |
| `runUrl` | optional `https://` link for the escalation message |
| `ref` | optional land ref (branch name); each stage checks it still points at `sha` |

| Stage | One hosted run does | Next |
| --- | --- | --- |
| `A-adversarial` | the repo's adversarial review flow. Never given the intent | `A-context` |
| `A-context` | the repo's context review flow, given `intentFile` | `B` |
| `B` | the repo's local CI flow, plus the changelog rule. Closes the gate | `D`, `C-<n>`, or `needs_human` |
| `C-<n>` | fix round n: one fix agent, a local fixup commit, the formatter guard | `A-adversarial` or `needs_human` |
| `D` | fetch the base; rebase if it moved | `A-adversarial` (rebased), `E`, or `needs_human` (conflict) |
| `E` | shadow: records the GitHub gate it would dispatch (`githubGate`, `dispatched: false`). Nothing is dispatched or pushed | `F` |
| `F` | shadow: writes the squash plan into the state with `pushed: false`. Nothing is pushed | `landed` |

Terminal states and their run verdicts: `landed` (success), `needs_human`,
`cancelled` (canceled) and `failed` (step_failed). Every completion detail is
JSON. A refused invocation reports `{"land":"refused"}` or
`{"land":"declined"}` and writes no state.

**Stage E in shadow mode (Decision B, decided).** Shadow runs never get a
write token, and relay-desktop's GitHub gate pushes a throwaway `ci/<sha>`
branch, so a shadow run could never pass it. Stage E therefore always records
what it would dispatch (the CI flow, `{"github":true}` and the head sha) and
moves on to F. There is no flag to turn it on: `mergePolicy.githubGateInShadow`
was removed, and the validator now rejects it as an unknown key. A real
stage E, including "red → C", belongs in phase 2. A full GitHub run takes
about 30–125 minutes, so it needs a dispatch run and an await run to fit under
the 40-minute ceiling.

### Why A splits into one run per review flow

The three gate flows each get their own run, one after another. A
launch-and-collect split was rejected: a detached review process does not
survive the end of its hosted run, because the next stage gets a fresh
sandbox. Running the flows one per run also keeps every run to a single repo
flow plus setup. The cost is wallclock: the gate's three flows run in sequence
instead of in parallel. Running them as parallel runs would need fan-out in
Cloud's queue and merged writes to the state file, which is more than phase
0-1 needs.

**The 45-minute review budget does not fit as is.** Inside a run, a repo flow
is still started detached and polled in 5-minute `f.run` steps, because one
`f.run` lease is at most 15 minutes. It is never polled past
`runner.stageMinutes` (default 30, range 5–35), which leaves room for clone
and setup under 40 minutes. relay-desktop's review flows declare
`wallclock: "45m"`, and their fleet plus verifier take about 26 + 12 minutes.
So one of two things has to change: the repo keeps a review inside
`stageMinutes`, or the repo flow itself splits (for example, one run per lens).
A review that runs past `stageMinutes` ends the land run `needs_human`, and
names the log.

### State, idempotency and the land-ref sha

`land-state.json` (`version: 1`) holds:

- the stage cursor and `seq`, which every transition bumps
- the fix round and rebase count
- the open gate's lane results
- every closed gate's blocking finding ids, which feed convergence, and per-gate results
- the pinned sha, and `headSha`: the current land-ref sha after fixups and rebases
- the base sha, the config pinned at the first stage, the log, the escalation and the squash plan

It is written to a temporary name, then renamed. That write is the stage's
commit point:

- A rerun of a stage whose write landed is a no-op. It reports the cursor
  again with `"noop": true`.
- A run reaped before its write reruns the same stage from the same state.
- An invocation for a stage that is not the cursor never runs.
- A terminal run reports its terminal state again.

Repo review flows keep their own incremental state under `stateDir/flows`. A
rerun of a reaped review may therefore see "nothing changed since the last
review" and reuse that review's report.

Each run starts from a fresh clone of the pinned sha. When `headSha` differs,
the run restores it from `<stateDir>/land.bundle`. That is a git bundle of the
local fixup and rebase commits, written before the state. The bundle is how
fixups survive between runs without a push. When `ref` is given, each run
first checks with `git ls-remote` that the land ref still points at the pinned
sha. If it has moved or been deleted, the run is superseded: it ends
`cancelled` before doing any work.

All transitions go through the pure `nextLandStage(state, result)`, which
`tests/transition.test.ts` covers.

### Stop rules

The fix loop stops (`needs_human`) on any of these:

- the round cap
- the same finding id surviving two consecutive fix rounds
- the blocking count not decreasing for two rounds
- the wallclock budget, counted from the first stage
- a fix round touching files outside (change files ∪ files named in findings), with crate-wide `cargo fmt` churn called out

The escalation message is at most 150 UTF-8 bytes:
`Land <repo>@<sha7> stuck: <n> blockers after <r> rounds. Fix or abort? <runUrl>`.
Over the limit, the repo owner is dropped first, then the name is cut with
`…`. The ask and the URL are never cut. A URL that cannot fit is refused at
the first stage.

`mergePolicy.mode` values `approval` and `auto` pass validation, but a run
refuses them (`declined`): phase 0-1 implements shadow only.

A finding's id is its source, its file and its normalized title.
relay-desktop's `report.json` has no id field. Its verifier moves lines and
marks repeats "raised before", so neither line numbers nor raw titles are
stable across rounds.

## Placeholders pending decisions

These defaults are the spec's proposals, not decisions; each is marked
`PLACEHOLDER pending decision (cloud#5806 Qn)` in the source and schema.

| Field | Default | Question |
| --- | --- | --- |
| `fixLoop.maxRounds` | 4 | Q2 |
| `fixLoop.wallclockMinutes` | 180 | Q2 |
| `fixLoop.model` | unset (harness default) | Q2 |
| `mergePolicy.squashAuthor` | `session-human` | Q3 |
| `landRef` | `land/{user}/{sha7}` | Q5 |
| `mergePolicy.approvalDropAfterCleanLandings` | `null` | Q6 |

## Not in this flow

Session resolution and `intent.md` materialization, the Relay DM delivery of
the escalation, the approval gate, queueing and superseding, the sandbox clone
and GitHub token are Cloud's (cloud#5806 §12). Each repository flow must read
`RELAYFLOW_STATE_DIR` and write under `$RELAYFLOW_STATE_DIR/<flow-name>/`
(`report.json`, `report.md`), where `<flow-name>` is the flow file's basename
without `.flow.ts`; relay-desktop's flows do not do that yet.

## Tests

Fake flow contexts only: no broker, agent, network or git.

```sh
npm ci --prefix ../../packages/surface --ignore-scripts && npm run --prefix ../../packages/surface build
npm ci && npm test && npm run typecheck
flows check land.flow.ts
```
