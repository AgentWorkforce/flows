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

```sh
flows run examples/land/land.flow.ts --input '{
  "repo": "AgentWorkforce/relay-desktop", "sha": "<40 hex>",
  "sessionId": "<session id>", "intentFile": "/runs/<runId>/intent.md",
  "stateDir": "/runs/<runId>", "runUrl": "https://…/runs/<runId>"
}'
```

Run it from a fresh clone checked out at `sha` (Cloud's per-run sandbox).

| Input | Meaning |
| --- | --- |
| `repo` | `owner/name` |
| `sha` | 40-hex pinned commit; the checkout's `HEAD` must equal it and be clean |
| `baseBranch` | optional; must agree with `land.config.json` |
| `sessionId` | goes into the `Relay-Session:` trailer |
| `intentFile` | absolute, outside the checkout; given to context review and the fix agent only |
| `stateDir` | absolute, outside the checkout; every byte the run writes. Its basename is the `Land-Run:` id |
| `config` | inline config, or a repo-relative path read with `git show <sha>:<path>`; default `land.config.json` |
| `runUrl` | optional `https://` link for the escalation message |

## Stages

| | |
| --- | --- |
| A ∥ B | adversarial review, context review and local CI start together, each detached and polled in 13-minute steps (an `f.run` lease is at most 15 minutes; a review takes up to 45). Only context review gets `intentFile`; the adversarial command never names it. With `changelog: "required"` the change must add a bullet under `## Unreleased`. |
| gate | no surviving blocker/major, local CI green, changelog rule met → D; otherwise C |
| C | one fix agent (`fixLoop.harness`/`model`), committed locally, then A ∥ B again. The repo flows rerun incrementally from their own state under `stateDir/flows`. |
| D | fetch the base; if it moved, rebase and gate again. A conflict escalates. |
| E | the CI flow with `{"github":true}`. **Skipped in shadow mode** unless `mergePolicy.githubGateInShadow`, because relay-desktop's GitHub gate pushes a throwaway `ci/<sha>` branch. Red → C. |
| F | shadow: the would-be squash plan (base, tree, message, trailers) goes to `stateDir/land-report.json` with `pushed: false`. Nothing is pushed. |

The loop stops (`needs_human`) on: the round cap; the same finding surviving
two consecutive fix rounds; the blocking count not decreasing for two rounds;
the wallclock budget; or a fix round touching files outside (change files ∪
files named in findings), with crate-wide `cargo fmt` churn called out. The
escalation is ≤150 UTF-8 bytes:
`Land <repo>@<sha7> stuck: <n> blockers after <r> rounds. Fix or abort? <runUrl>`
— over the limit the repo owner is dropped, then the name is cut with `…`; the
ask and URL are never cut, and a URL that cannot fit is refused.

`mergePolicy.mode` `approval` and `auto` validate but are refused at the start
of a run (`declined`): phase 0-1 implements shadow only.

A finding's id is its source, file and normalized title. relay-desktop's
`report.json` carries no id, and its verifier moves lines and marks repeats
"raised before", so neither line numbers nor raw titles are stable.

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
