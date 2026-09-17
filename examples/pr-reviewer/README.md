# pr-reviewer

The [wepost-no/agents `review/agent.ts`](https://github.com/wepost-no/agents/blob/main/review/agent.ts)
PR reviewer, ported to a v2 relayflow. Same review prompt, same gates, same
"post the review; say it's a human's turn only when it really is" contract —
with every step the v4 platform did on the agent's behalf turned into a
journaled step the agent cannot forge.

**Like I'm 5:** a robot reads your pull request and writes a review. It's only
allowed to fix boring things (typos, formatting). Then a *different* part of
the machine runs your tests — the robot doesn't get to say whether they
passed. If the tests are green, the boring fixes are pushed; if they're red,
the fixes are thrown away and the review says so. The review is posted, and
it only says "ready for a human" when the robot said so **and** the tests
were green **and** GitHub agrees.

## The shape

```
PR state (REST) → skip gates → checkout PR head + write .workforce/{pr.diff,context.json,threads.json}
  → f.agent("review") [gated: review.md exists]
  → f.run(npm test) OUTSIDE the agent
  → green: commit + push mechanical fixes to the PR branch | red: discard + advisory
  → READY? = agent said so ∧ tests green ∧ live PR state allows it
  → f.github.comment (journaled effect) → done
```

An approval event from an allowlisted approver takes the short path:
`f.github.mergePullRequest` and done.

| v4 (`defineAgent`) | here |
| --- | --- |
| relayfile VFS `pulls/N/meta.json`, `checks/_summary.json`, `reviews/*.json` | `f.run` + `curl` against the REST API, parsed in TS (`prReviewStateFromRest`) |
| cloud materialized the checkout and `.workforce/pr.diff` | `f.run` git steps |
| `ctx.harness.run({ prompt })` | one `f.agent("review", …)` step, gated on `.workforce/review.md` |
| prompt asks the agent to run the tests | `f.run(npm test, { timeout: "15m" })` — the exit code is the kernel's |
| cloud commits/pushes whatever the agent left | the flow pushes **only** after its own test run is green; otherwise discards and posts an advisory |
| `runReviewHarnessWithRetry` on exit 137/143, log plumbing | not ported: the kernel owns retries and leases; the journal is the log |
| `githubClient().comment / mergePullRequest` | `f.github.comment / mergePullRequest` (journaled, exactly-once) |

The pure decision functions (`evaluateMergeOnGreenState`,
`prReadyStateAllowsHumanReview`, `reviewAuthorAllowlistDecision`,
`readPr`, the prompts, …) are ported verbatim and exported from the flow
file; [tests/pr-state.test.ts](tests/pr-state.test.ts) carries the upstream
suite (38 tests) plus six for the v2 seams (44 total, `npm test`).

One file on purpose: Cloud receives a single authored source and does not
resolve sibling imports, so the helpers live below the flow.

## Input

```json
{
  "owner": "AgentWorkforce", "repo": "flows", "number": 440,
  "approvers": "khaliqgant",
  "reviewAuthors": "",            "skipLabels": "no-agent-relay-review",
  "reviewerCli": "claude",        "githubTransport": "helper"
}
```

- `approvers` — logins whose approval event merges. Empty: any approval.
- `reviewAuthors` — only review PRs by these logins. Empty: everyone.
- `reviewerCli` — `claude` (default), `codex`, or a custom wrapper path. The
  operator chooses it, as they choose the flow: `flows check` resolves and
  probes it before anything runs, and a wrapper must identify itself with the
  `relayflows-agent-cli-v1` handshake or is refused `cli_unsupported`.
- `testCommand` — the verification command, default `npm test`. Pinned from
  input **before** the agent runs and never read from the checkout, so an
  agent edit to `package.json` cannot redefine "green".
- `githubTransport` — `helper` (default) uses the journaled `f.github` effect,
  which needs a relayfile GitHub mount (Cloud has one). `curl` posts through
  the REST API with `$GH_TOKEN` from a deterministic step, for a local
  checkout without a mount.
- `event` — a GitHub webhook payload, when one launched the run.

## What the flow will and will not push

Before any push, deterministically: the pinned test command was green; the
agent did not touch a **protected path** (`package.json`, lockfiles, test
files and directories, test-runner and TypeScript config, `.github/`,
`Makefile`, `Cargo.toml`/`go.mod`/`pyproject.toml` — the verification's own
inputs and the tests themselves, which are human-owned); and the PR head lives
in this repository (a fork's head is another repo, so fixes for fork PRs are
posted as advisory, not pushed). A protected-path edit also vetoes READY,
because a green run that came with a rewritten test script proves nothing.
Beyond that, "mechanical only" is the prompt's contract, as it was in v4 —
the review lists every changed path, and the push is a normal commit a human
can revert.

Merging on an approval is the one irreversible step, so it needs: an approval
from an allowlisted approver (empty `approvers` = anyone, the upstream
default — set it), the approval's `commit_id` equal to the current head (or
no `commit_id` at all), the live state green and mergeable, and the merge
call carries that head SHA so GitHub refuses if the head moves in between.
A webhook payload may enrich the configured coordinates (author, head, labels)
but never redirect them: an event naming a different PR is refused.

## Run it locally

From a checkout of the repository the PR belongs to:

```sh
export GH_TOKEN=$(gh auth token)      # in the SAME shell that starts the daemon, see below
flows check examples/pr-reviewer/pr-reviewer.flow.ts
flows run examples/pr-reviewer/pr-reviewer.flow.ts --local-agent \
  --input '{"owner":"o","repo":"r","number":7,"approvers":"you","githubTransport":"curl"}'
```

Deterministic steps run with the **daemon's** environment, not the CLI's:
`relayflowd` is spawned by the first `flows run` in a data directory and
outlives it. Set `GH_TOKEN` before that first run, or restart the daemon.

## Run it on Cloud

```sh
cd <checkout> && flows run --cloud --sync-code --wait \
  examples/pr-reviewer/pr-reviewer.flow.ts \
  --input '{"owner":"o","repo":"r","number":7,"approvers":"you"}'
```

The synced tree is the checkout; the sandbox has a relayfile GitHub mount, so
the default `helper` transport applies. `GH_TOKEN` for the REST reads comes
from the sandbox's repository credential.

## What is proven, and how

Everything below ran through the real kernel and the real authored runtime
(`flows run … --local-agent`, v2.0.16), with two stand-ins so nothing touched
a real repository: a `curl` on `PATH` that answers GitHub API shapes from
fixtures and logs every call ([evidence/curl-shim.sh](evidence/curl-shim.sh)),
and a wrapper agent CLI that writes `review.md` and one "mechanical" edit
([evidence/agent-wrapper.mjs](evidence/agent-wrapper.mjs)). The PR lived in a
bare scratch `origin` with `refs/pull/7/head`.

| Path | Result |
| --- | --- |
| happy: tests green | 18 steps `success`; review commit pushed to the PR branch ([origin-feature-after.txt](evidence/origin-feature-after.txt)); comment posted with the READY sentinel stripped and the `:white_check_mark:` line present; check runs **and** commit statuses read ([api-calls-success.txt](evidence/api-calls-success.txt)) |
| red: `npm test` exits 1 | 15 steps `success`; PR branch untouched; edits discarded; advisory posted; **no** ready line ([api-calls-red.txt](evidence/api-calls-red.txt)) |
| fork PR (`head.repo` ≠ base) | 19 steps `success`; base repo's branch untouched; advisory names the fork ([api-calls-fork.txt](evidence/api-calls-fork.txt)) |
| protected path: the agent rewrites `package.json`'s test script so tests "pass" | 15 steps `success`; nothing pushed; advisory names `package.json`; **no** ready line despite the green run ([api-calls-protected.txt](evidence/api-calls-protected.txt)) |
| draft PR | 3 steps `success`; one API read, no checkout, no agent, no comment ([api-calls-draft.txt](evidence/api-calls-draft.txt)) |

Bugs the proof caught before anyone else could: `checkout FETCH_HEAD`
after a two-ref fetch silently took the base branch (now a named
`refs/remotes/origin/pr-N`); `git add -A ':!.workforce'` exits 1 when the
directory is gitignored (now `add -A` + `reset -- .workforce`); and the READY
sentinel survived into the posted body without a `trimEnd()`. Review bots
then caught that `flow(...).on(...)` returns a *new* handle, so three
discarded `.on` calls registered nothing (now chained), and that a green run
with an agent-edited test script was being trusted (now vetoed).

Not proven here, honestly: a real Claude session writing a real review (the
wrapper stands in for it), the `helper` transport (needs a relayfile GitHub
mount), and the merge path (needs an approval event).

## Not yet wired

- **Cloud trigger path.** `flows deploy` listeners launch on
  `issues.opened`/`issues.labeled` only; PR events are filtered out before
  launch, and the repository grant checks out the default branch. Until
  Cloud admits PR events and grants the PR head, run this on Cloud with
  `--sync-code` from a checkout, or locally.
- **`check_run.completed` / `issue_comment.created`.** Merge-on-green and the
  `@relay fix conflicts` directive are ported as functions
  (`evaluateMergeOnGreenState`, `matchesConflictDirective`,
  `isAuthorizedConflictCommander`) and tested, but the generated trigger
  vocabulary has no such events yet.
- **`artifact_exists`.** The review step is gated with
  `{ type: "subprocess_gate", command: "test -s .workforce/review.md" }`.
  When the `artifact_exists` named gate lands, the swap is one line:
  `.gate({ type: "artifact_exists", path: REVIEW_FILE })`.
