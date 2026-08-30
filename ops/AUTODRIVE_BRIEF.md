Wire the review-swarm to fire on PR open via GitHub Actions + `agent-relay cloud run`. CODE task, `.github/workflows/`-side.

## Do not re-do these

Merged and closed; a PR redoing any will be closed:
  - picker actionability (#42), unterminated backticks (#45)
  - deterministic-command preflight refusal (#47) — do not touch preflight
  - the gate-1 race regression test (#48) — do not touch
    kernel/relayflowd/src/server/tests.rs or server.rs
  - ops/NEXT.md validation (#50) — do not touch
    sdk/src/work-package-validator.ts
  - **the SDK agent worker (#53, `9681f11`)** — `sdk/src/worker.ts` (91 lines) is
    the shipped worker. It attaches on `hello`, listens for `step.dispatch`, runs
    the step's declared CLI as a subprocess, and reports back via
    `step.complete`. **Do NOT rewrite it, replace it, or "fix" it.** PRs #54,
    #55, #56 all tried to and were closed as duplicates. If a lens flags a
    concern about worker.ts, address it AS-IS with the smallest possible diff.

## Why this matters

`workflows/review-swarm.yaml` already exists in this repo — three model-diverse
reviewers (claude/codex/opencode) that read a PR diff and produce three
independent transcripts + one aggregate verdict. Today it only fires when a
human writes `.review-target` and runs `agent-relay cloud run` by hand. It has
run zero times against a drive PR on cloud.

Meanwhile the reviewers this repo actually depends on (CodeRabbit, Devin) are
external SaaS bots: CodeRabbit rate-limits into silence and Devin's trial
expired. RFC-0001 §2 rule 7 says the review team must be OUR own — the swarm is
that team, and it is not firing.

The fix is one GitHub Actions workflow: on PR open/synchronize, write
`.review-target`, invoke `agent-relay cloud run workflows/review-swarm.yaml`,
poll for completion, `agent-relay cloud sync` the transcripts back, and post
each as a PR comment with an aggregate marker.

## The task

Add `.github/workflows/review-swarm.yml`. That is the only file this tick
should create; the workflow it invokes already exists.

Scope it small and honest:
  - trigger: `pull_request` events `opened`, `synchronize`, `reopened`
  - only run if `github.event.pull_request.user.login` is a drive-loop author
    (`kjgbot`, `miyaontherelay`) — do not review human PRs
  - concurrency group per PR so a second push cancels the first review
  - job steps:
    1. checkout the PR's head at the merge commit
    2. install `agent-relay` (curl the release, or use `mise install` if that's
       how this repo does it — check `.mise.toml` and `.env.example`)
    3. `echo "$PR_NUMBER" > .review-target`
    4. `agent-relay cloud run workflows/review-swarm.yaml` with
       `RELAY_WORKSPACE_KEY` from a repo secret; capture the runId
    5. poll `agent-relay cloud status <runId> --json` every 30s until
       `status == completed` or 45 min elapse
    6. `agent-relay cloud sync <runId>` to fetch the run's artifacts
    7. read `ops/reviews/*-pr<N>-*.md` produced by the swarm; post each as
       a PR comment via `gh pr comment`
    8. post one aggregate marker comment: `🎯 review-swarm: PASSED|FAILED
       (M:<v> H:<v> S:<v>)` — the aggregate step of review-swarm.yaml prints
       `SWARM_PASSED` or `SWARM_FAILED` on stdout; grep for that.

## Definition of done, all of it

  - `.github/workflows/review-swarm.yml` exists and passes `actionlint` if
    installed, or `yamllint` otherwise
  - `README.md` or `docs/` describes the required repo secret
    (`RELAY_WORKSPACE_KEY`) and what it does — one sentence is enough
  - the workflow's `jobs.review.if` correctly gates on drive-loop author only
    (test the expression by hand: verify it evaluates true for kjgbot and
    false for khaliqgant)
  - a dry-run test that proves the shell logic works: a companion shell script
    `.github/workflows/scripts/swarm-post.sh` (or inline) that TAKES a runId as
    an argument and posts the comments. Show it working against an EXISTING
    completed cloud run by running:
      `bash .github/workflows/scripts/swarm-post.sh <some-real-runId> <some-PR>`
    and quoting the posted comment URL
  - `cd sdk && npm test` green (should be unaffected by this change)
  - EVERY new test confirmed to FAIL against current code, with the literal
    failing output quoted in your summary
  - as your LAST action, run `git status --porcelain` and paste it

## Prerequisites this brief cannot satisfy — surface, don't try to fix

  - **`RELAY_WORKSPACE_KEY` must exist as a GitHub Actions secret** on
    `AgentWorkforce/flows`. `gh secret list --repo AgentWorkforce/flows` will
    show if it's there. If it is missing, write ops/NEEDS_HUMAN.md saying so
    and STILL end with ASSESS_DONE — this is a human step (add the secret in
    repo settings; workspace key is on the laptop at
    `~/.agentworkforce/relay/cloud-auth.json`).
  - **`agent-relay cloud run` invoked from GHA must reach the same cloud
    workspace as the laptop.** If the run fails with an auth error, DO NOT
    invent a workaround (a scoped token, a different endpoint); file it as a
    NEEDS_HUMAN and stop.

## If you cannot finish

Say so and file what you learned. A working `.github/workflows/review-swarm.yml`
that stalls at the auth step, plus a NEEDS_HUMAN naming the missing secret, is
a complete deliverable — the runbook is the artifact.
