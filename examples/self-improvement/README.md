# self-improvement

A scheduled agent flow that improves another flow from how it has actually run.
It reads the target's last N completed runs, picks the step with the most
leverage, and opens a pull request. The PR edits **both** the target's agent
prompts and its structure, and carries a before/after hypothesis that future
runs can confirm or falsify.

```
collect (deterministic)    listCloudRuns → getCloudRunSteps, per run → runs.json + digest.json
checkout (deterministic)   gh repo clone; refuse if a self-improve PR is already open; compile-spec → before spec
analyst (agent, readonly)  pick the step, diagnose it, write proposal.json
  └ check-proposal         schema, real step ids, cited runs were collected   (one repair pass, then fail)
editor (agent, cwd=target) apply the proposal to the .flow.yaml
  └ check-proposal edit    only the flow file changed; flows check; compiled spec has ≥1 prompt AND ≥1 structural change
pr (deterministic)         branch self-improve/<flow>/<stamp>, push, gh pr create with the hypothesis
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
opened. Everything it produced is in `./improve/`:

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

Then put it on a schedule:

```sh
flows schedule examples/self-improvement/self-improvement.flow.ts \
  --cron "0 6 * * 1" --tz UTC \
  --input '{"flowName":"issue-triage","repo":"acme/flows","flowPath":"flows/issue-triage.flow.yaml"}'
```

| Input | Default | Meaning |
|---|---|---|
| `flowName` | — | The target's declared name, as `flows runs` prints it |
| `flowPath` | — | Repo-relative path of the target's `.flow.yaml` |
| `repo` | — | `owner/name`. If absent, a local copy of `flowPath` is edited and `dryRun` must be `true` |
| `baseBranch` | `main` | Branch to clone, and the base of the PR |
| `runs` | `10` | Terminal runs to read (1-50) |
| `scan` | `200` | Newest workspace runs to scan for them (the list route has no flow filter) |
| `minRuns` | `3` | Ends `declined` with fewer than this many runs |
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

- **The proposal is real.** It names a step that exists in the compiled flow,
  cites only runs that were collected, and proposes at least one prompt edit,
  at least one structure edit, and a hypothesis with a `falsified_if`.
- **The edit is the proposal, and only that.** Exactly one file changes (the
  flow), `flows check` passes, and diffing the compiled canonical spec
  before and after shows at least one `instruction`/`prompt` change *and* at
  least one structural change (steps, `dependsOn`, verification, iterations,
  timeouts, model, budget). The spec is compiled with the SDK's own
  `compileYamlToCanonicalJson`. Comment and formatting churn cannot pass for an
  edit.
- **There is one open proposal per flow.** If a PR from
  `self-improve/<flow>/…` is still open, the flow ends `declined` instead of
  stacking a second one.
- **Run output is not obeyed.** Output summaries and tool excerpts in
  `runs.json` are other agents' output. Both agent prompts treat them as data
  and never as instructions.

Each check gets one repair pass, which hands the agent the check's own
output. If the check fails again, the flow fails at that step.

## Credentials

| Need | Credential | Notes |
|---|---|---|
| Read other runs | `FLOWS_CLOUD_TOKEN`: a workspace API token with purpose `workflow` | Resolved by the SDK (`cloud-http.ts`). It falls back to the `agent-relay cloud login` store. |
| Clone, push, open the PR | `GH_TOKEN` | Locally, `gh auth token`. On Cloud, the GitHub App installation token in the sandbox. It cannot push to forks. |

`collect-runs.mjs` and `compile-spec.mjs` load `@relayflows/sdk` from the
installed `flows` CLI, so
the reader and the runtime are always one version. Set `RELAYFLOWS_SDK` to a
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
  rejected proposals. The one-open-PR rule and the closed PRs themselves are
  its only record.
- **No hosted cross-run read token.** A Cloud sandbox token reads only its
  own run, and Cloud has no first-class way to inject a workspace `workflow`
  token into a scheduled run. Until it does, run the flow where
  `FLOWS_CLOUD_TOKEN` is available: locally, from CI, or from a runner you
  control.
