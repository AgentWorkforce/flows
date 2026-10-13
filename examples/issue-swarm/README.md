# issue-swarm

Open labeled GitHub issues become independently implemented pull requests. Each
issue gets a branch, worktree, and persistent broker implementer. Three reviewers
use `adversarial-review` with maintainability, git history, and code structure
lenses. Findings return to the same implementer. A bounded monitor sends CI,
conflict, and unresolved review-thread repairs using its `pr-comments` skill.
The flow never merges.

Run from a checkout of the target repository with its `origin` configured:

```sh
flows run examples/issue-swarm/issue-swarm.flow.ts \
  --input '{"label":"agent","count":3,"monitorMinutes":30}'
```

The source is self-contained and deploys as-is for manual runs by name:

```sh
flows deploy examples/issue-swarm/issue-swarm.flow.ts --repo owner/name
flows run issue-swarm --input '{"label":"agent","count":3}'
```

The example requires the surface/SDK broker transport with `f.message` timeouts
and `f.release`. Install and authenticate `gh`, `git`, Node 22+, Claude Code and
Codex (or the selected CLIs), and start the local Agent Relay broker. The broker
installs named skills from the canonical AgentWorkforce skills package. Broker
agents are ordinary sessions visible in Relay Desktop; the returned agent name
identifies the session receiving follow-up messages. The monitor has write
authority to push branches and address PR comments, so run on repositories where
those actions are intended.

| Input | Default | Meaning |
| --- | --- | --- |
| `repo` | `gh repo view` | `owner/name`; must match the current checkout |
| `label` | required | Open-issue label |
| `count` | `3` | Maximum selected issues, 1–20, in GitHub list order |
| `implementerCli` | `claude` | Broker implementation CLI |
| `reviewerCli` | `codex` | Broker review CLI |
| `reviewRounds` | `2` | Maximum three-reviewer passes per PR, 1–10, including the initial pass and reviews after monitor fixes |
| `monitorMinutes` | `30` | Monitor budget, 0–240; zero performs one status snapshot without monitor repairs |

Issue lanes run concurrently. Review findings trigger a repair only when another
review pass remains. All three GO summaries must name the current head. A push
invalidates that review, including a push made during monitoring. Exhausted review
passes leave the PR for a human. A `NO-GO` summary must contain concrete findings;
missing, malformed, contradictory, or stale summaries require human attention.

Monitoring reads every PR's current head, paginated check runs and commit statuses,
GitHub mergeability and merge state, changes-requested reviews, and paginated
unresolved review threads. Latest status per context wins. Unknown mergeability,
pending/failed checks, stale check SHAs, drafts, unresolved threads, and blocked
merge states keep the PR pending. A ready PR is open, non-draft, clean and mergeable,
with acceptable completed checks and current-head GO reviews. No checks is allowed
when GitHub reports clean mergeability. The flow reports readiness for human merge;
it does not claim to replace repository protection rules.

The monitor starts after implementation and initial review. Its deadline and poll
waits are journaled commands; repair/reviewer timeouts are capped to the remaining
budget. Budget expiry, provider errors, agent timeouts, exhausted review passes,
or cleanup failures complete with `needs_human` and details. Empty issue lists
complete successfully without allocating sessions or worktrees.

Worktrees live beneath the run directory's ignored `.relayflow/issue-swarm.*`.
Implementers are released before their worktrees are removed, including on error.
Removal never uses `--force`: dirty worktrees remain with their path in the result.
Branches and PRs remain available for humans. A failed release preserves that
agent's worktree. The broker also releases retained sessions when its worker closes.

Tests use fake flow contexts and a fake GitHub command port. They start no broker,
PTY, agent harness, or network request:

```sh
npm --prefix packages/surface install
npm --prefix packages/surface run build
npm --prefix examples/issue-swarm install
npm --prefix examples/issue-swarm run typecheck
npm --prefix examples/issue-swarm test
```
