# self-improvement

A scheduled agent flow that improves another flow from how it has actually run.
It reads the target's last N completed runs, picks the step with the most
leverage, and opens a pull request. The PR edits **both** the target's agent
prompts and its structure, and carries a before/after hypothesis that future
runs can confirm or falsify.

```
checkout (deterministic)   gh repo clone; decline if self-improve/<flow> exists; compile-spec → before spec
collect (deterministic)    listCloudRuns → getCloudRunSteps, per run → runs.json + digest.json; seal them
analyst (agent, readonly)  pick the step, diagnose it, write proposal.json
  └ check-proposal         seal intact; schema, real step ids, cited runs were collected  (one repair pass)
editor (agent, cwd=target) apply the proposal to the .flow.yaml
  └ check-proposal edit    seals intact; only the flow changed; flows check; compiled diff == the proposal
pr (deterministic)         commit → push self-improve/<flow> → gh pr create; each step safe to re-run
```

The flow stops at the PR. It does **not** replay, evaluate, merge or deploy.
A human reviews and merges, and deploying the merged flow is a separate,
manual step. See [What it does not do](#what-it-does-not-do).

## Run the example (offline, no PR)

[`example/`](example/) holds a small `issue-triage` YAML flow and six recorded
runs of it ([`runs.fixture.json`](example/runs.fixture.json), in the exact
`CloudStep` shape `getCloudRunSteps` returns). In those runs, `classify` fails
its `LABEL:` check in 2 of 6 runs and `draft-reply` accounts for most of the
spend. Neither Cloud nor GitHub is touched. The agents run locally.

```sh
flows run examples/self-improvement/self-improvement.flow.ts --local-agent \
  --input examples/self-improvement/example/input.json
```

The run ends `success` with the checked diff and the PR body it would have
opened. Everything it produced is in `./improve/`. The flow refuses to run if
`./improve` exists and is not its own scratch directory from an earlier run.

- `digest.json`: the per-step ranking;
- `proposal.json`: the analyst's choice and hypothesis;
- `pr-body.md`: the body of the PR it would have opened;
- `target/`: the edited flow, with `git diff --cached` showing the change.

The deterministic helpers have their own tests:

```sh
npm --prefix examples/self-improvement test
```

## Run it against a real flow

The target must be a **YAML** flow (`.flow.yaml`) in a GitHub repository.
A YAML flow's prompts are data (`instruction:` / `prompt:`), so an edit is a
diff that can be checked against the compiled spec. Editing a `.flow.ts`
target would mean editing source code, which v1 does not do.

```sh
export FLOWS_CLOUD_TOKEN=…        # workspace API token, purpose `workflow` (runs:read)
export GH_TOKEN=$(gh auth token)  # or a GitHub App installation token with contents+pull_requests write

flows run examples/self-improvement/self-improvement.flow.ts --local-agent --input '{
  "flowName": "issue-triage",
  "repo": "acme/flows",
  "flowPath": "flows/issue-triage.flow.yaml",
  "runs": 10
}'
```

### Schedule it

Run that same command from cron, or from a CI job on a schedule, on a host
where `FLOWS_CLOUD_TOKEN` is available:

```cron
0 6 * * 1  cd /srv/flows && flows run examples/self-improvement/self-improvement.flow.ts --local-agent --input /srv/self-improvement/issue-triage.json
```

`flows schedule` (a hosted Cloud schedule) does **not** work for this flow
yet. A hosted fire holds only a run-scoped sandbox token, which cannot read
other runs, and Cloud has no way to give a scheduled run a workspace read
token. Every hosted fire would fail at the collect step. See
[What it does not do](#what-it-does-not-do).

| Input | Default | Meaning |
|---|---|---|
| `flowName` | — | The target's declared name, as `flows runs` prints it |
| `flowPath` | — | Repo-relative path of the target's `.flow.yaml` |
| `repo` | — | `owner/name`. If absent, a local copy of `flowPath` is edited and `dryRun` must be `true` |
| `baseBranch` | `main` | Branch to clone, and the base of the PR |
| `runs` | `10` | Terminal runs to read (1-50) |
| `scan` | `200` | Newest workspace runs to scan for them (the list route has no flow filter) |
| `minRuns` | `min(3, runs)` | Ends `declined` with fewer than this many runs |
| `fixture` | — | Read runs from a file instead of Cloud |
| `dryRun` | `false` | Stop after the checked edit: push nothing, open nothing |
| `cli`, `model` | `claude`, `claude-sonnet-5` | Agent for the analyst and editor steps |

### How the step is chosen

`digest.mjs` scores every executed step on four signals:

- `failing`: the share of the step's executions that failed;
- `weak`: the share that succeeded but had a gate reject an attempt, retried, or ended in a CLI error;
- `costly`: the step's share of all spend;
- `slow`: the step's share of all wallclock.

Leverage is the largest weighted signal. Failures weigh most (×2.0): a failed
step throws away the whole run, upstream spend included. The two shares are
discounted (×0.5, ×0.4), because some step always holds the largest share.

The ranking is where the analyst *starts*, not the verdict. The analyst reads
every per-step row and may pick a different step. For example, it may find
that a step fails because an upstream step handed it bad input. It has to cite
collected run ids for its evidence, and the check refuses a proposal that
cites any other run.

### What the gates guarantee

- **The proposal is real.** It names steps that exist in the compiled flow (or
  that a structure edit adds), cites only runs that were collected, and has at
  least one prompt edit, at least one structure edit, and a hypothesis with a
  `falsified_if`. Every edit names the step it changes (`flow` for a
  flow-level field).
- **The edit is the proposal, and only that.** Exactly one file changes (the
  flow), and `flows check` passes. The compiled canonical spec (from the
  SDK's own `compileYamlToCanonicalJson`) is diffed before against after,
  and the diff must match the proposal. There must be at least one prompt
  change and at least one structural change.
  - Each prompt edit carries its complete `new_text`. The step's compiled
    `instruction`/`prompt` must equal it exactly, apart from the single
    trailing newline a YAML `|` block adds. Any prompt change the
    proposal does not list is refused. A step the proposal adds counts as a
    prompt change too.
  - Each structure edit names its step and the compiled-spec `field` it
    changes (`max_iterations`, `verification`, `added`, … or `budget` on step
    `flow`). Every proposed (step, field) pair must appear in the diff. Every
    structural change must be one of three things. It can be a proposed
    pair. It can be a change to `<step>.gate`, the one step id the compiler
    derives (a named gate lowers to it), and only for a step whose proposal
    changes `verification` or adds the step. A user-authored dotted id such
    as `classify.audit` is never exempt. Or it can be a `depends_on` change
    whose added and dropped dependencies are all steps the proposal adds or
    removes, or a derived gate step replacing its parent.
  - Structural *values* are not compared. The YAML an agent writes and its
    compiled form differ (for example, a named gate lowers to an extra step),
    so the field is the finest grain that can be checked without guessing.
    Reviewers should read the YAML diff for the values.
  - Comment churn and dependency reordering do not count as edits.
- **No agent can move the goalposts.** `permissions.accessPreset` is
  recorded, not enforced, so an agent could write anywhere the run can. The
  gate scripts are embedded in the flow source and rewritten from it before
  every check, so an edited copy on disk is simply replaced. The evidence
  (`runs.json`, `digest.json`, the before spec, then `proposal.json` once it
  passes) is sealed with sha256 hashes. The seal is carried in the later
  steps' journaled command text, and any change refuses the check. The
  target checkout must still be at its base commit.
- **What is published is what was checked.** After the agents run, git runs
  with hooks and the fsmonitor command disabled, because an agent could have
  planted either in `.git`. An agent-defined `clean` filter could still
  rewrite what `git add` stages. The staged blob is therefore compared byte
  for byte with the file the checks read, that file is sealed, and the
  committed blob is compared again before anything is pushed.
- **The flow is not tricked by a symlink.** A `flowPath` that resolves outside
  the checkout is refused before it is read.
- **There is one proposal per flow at a time.** All proposals use the branch
  `self-improve/<flow>`. If a PR has ever used that branch, whether it is
  still open or was closed without the branch being deleted, the flow ends
  `declined`. Delete the branch to re-arm it. A branch that no PR has used
  may belong to a run that has pushed and is about to open its PR, so the
  flow declines that too, unless the branch tip is over an hour old. The run
  budget is 45 minutes, so no live run can own a branch that old. Such a
  branch is left over from a run that failed between the push and the PR.
  It is taken over with `--force-with-lease`, pinned to the sha seen at
  checkout, after re-checking that no PR has appeared. When two runs race,
  the second run's push fails closed.
- **Publishing survives a crash.** Commit, push and PR creation are separate
  steps, and each is safe to repeat: it skips the commit when it is already
  there, pushes the same commit again as a no-op, and reuses an open PR
  instead of creating a second one.
- **Run output is not obeyed.** Output summaries and tool excerpts in
  `runs.json` are other agents' output, and the target YAML comes from a
  repository. Both agent prompts name those files as untrusted data.

Each check gets one repair pass, which hands the agent the check's own
output. If the check fails again, the flow fails at that step.

### Whose runs are read

Cloud's run list identifies a flow only by its declared name. Two flows that
share a name, in two repositories for example, would otherwise pool their
runs. A run is therefore kept only when at least half of the steps it
executed are steps of the target's compiled spec. This keeps the target's own
history (a step added or renamed since) and drops a namesake. Dropped runs are
counted in `runs.json` (`dropped_foreign`) and do not count toward `runs`.

Costs are as Cloud reports them. An unmetered attempt makes a step's cost a
lower bound, and `getCloudRunSteps` carries no flag that says so.

## Helpers

The `.mjs` files here are the source of truth for the deterministic steps.
`self-improvement.flow.ts` embeds them, and a hosted run receives only that one
file. After editing a helper, regenerate the embedded copy:

```sh
node examples/self-improvement/bundle.mjs --write
```

The test suite fails if the embedded copy is stale.

## Credentials

| Need | Credential | Notes |
|---|---|---|
| Read other runs | `FLOWS_CLOUD_TOKEN`: a workspace API token with purpose `workflow` | Resolved by the SDK (`cloud-http.ts`). It falls back to the `agent-relay cloud login` store. |
| Clone, push, open the PR | a credential `gh` can use | Locally, your `gh` login (or `GH_TOKEN`). On Cloud, the GitHub App installation token in the sandbox. It cannot push to forks. |

### Credential exposure

The agent steps can reach both credentials. Agent CLIs inherit the run's
environment, and the SDK has no per-step environment scoping.
`permissions.accessPreset` is recorded but not enforced. A local `gh` login
is ambient to every process you run anyway.

The gates above keep an agent from *forging what this flow publishes*. They
do not stop a misbehaving or prompt-injected agent from using `gh` or the
Cloud token directly, for example to push a branch of its own. Contain that
outside the flow:

- Give the run a GitHub credential scoped to the target repository only, with
  `contents` and `pull_requests` write, such as a fine-grained token or an App
  installation. Do not use your personal login.
- Protect the target's default branch. No agent, and no step of this flow,
  can then merge or push to it.
- Mint `FLOWS_CLOUD_TOKEN` with the narrowest scopes Cloud allows. The
  collect step needs only `workflow:runs:read`. A `workflow`-purpose token
  can also carry `flows:listeners:write`, which deploys any flow its owner
  owns, so do not give this flow a token that holds that scope.

Closing this properly needs credential scoping per step in the SDK: a step
declares which secrets it may see. That is out of scope here.

`collect-runs.mjs` and `compile-spec.mjs` load `@relayflows/sdk` from the
installed `flows` CLI, so the reader and the runtime are always one version. Set `RELAYFLOWS_SDK` to a
`dist/index.js` path to override.

## What it does not do

This flow uses only primitives that exist today. RFC-0001 gate 9 routes
prompt and structure changes through gated PRs, and that is where this flow
stops. These are the gaps that stop the loop at the PR:

- **No replay or eval.** `flows replay` dumps a journal and does not
  re-execute it. `--reuse-from` is local-only, and editing a prompt
  invalidates the memo for that step anyway. The hypothesis is therefore
  checked by *future production runs*: the next scheduled pass reads them.
- **No deploy.** `deployToCloud` needs an interactive `cli:auth` session,
  and a run's sandbox token has no deploy scope. Merging the PR does not
  redeploy anything.
- **No memory writes.** `f.memory.learn` throws, so the flow cannot remember
  rejected proposals. The `self-improve/<flow>` branch is its only record: it
  stays until a human deletes it.
- **No hosted cross-run read token.** A Cloud sandbox token reads only its
  own run, and Cloud has no first-class way to inject a workspace `workflow`
  token into a scheduled run. Until it does, run the flow where
  `FLOWS_CLOUD_TOKEN` is available: locally, from CI, or from a runner you
  control.
