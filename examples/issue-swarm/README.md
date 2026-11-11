# issue-swarm

> **Legacy example:** this source demonstrates the retired retained-session
> broker API (`transport: 'broker'`, `keepAlive`, `f.message`, and `f.release`).
> Current releases refuse it before child-run admission. It remains as migration
> reference until a native retained-session design is approved; do not deploy or
> run it. See [the node-spawn migration note](../../docs/MIGRATION-NODE-SPAWN.md).

Open labeled GitHub issues become independently implemented pull requests. Each
issue gets a branch, worktree, and persistent broker implementer. Three reviewers
use `adversarial-review` with maintainability, git history, and code structure
lenses. Findings return to the same implementer. A bounded monitor sends CI,
conflict, and unresolved review-thread repairs using its `pr-comments` skill.
The flow never merges.

The example requires the surface/SDK broker transport with `f.message` timeouts
and `f.release`; those surfaces no longer have an execution backend. The
remaining description documents the former behavior for migration planning.

| Input | Default | Meaning |
| --- | --- | --- |
| `repo` | `gh repo view` | `owner/name`; must match the current checkout |
| `label` | required | Open-issue label |
| `count` | `3` | Maximum selected issues, 1–20, in GitHub list order |
| `implementerCli` | `claude` | Broker implementation CLI: `claude`, `codex`, or `cursor-agent` |
| `reviewerCli` | `codex` | Broker review CLI: `claude`, `codex`, or `cursor-agent` |
| `reviewRounds` | `2` | Maximum three-reviewer passes per PR, 1–10, including the initial pass and reviews after monitor fixes |
| `monitorMinutes` | `30` | Monitor budget, 0–240; zero performs one status snapshot without monitor repairs |

Each CLI has a fixed model: `claude/claude-sonnet-5`, `codex/gpt-5.6-sol`, or
`cursor-agent/gpt-5.6-sol-high`. These CLIs support the required broker skills.
Other CLIs require human attention before any commands or sessions start.

Issue lanes run concurrently. Review findings trigger a repair only when another
review pass remains. All three GO summaries must name the current head. A push
invalidates that review, including a push made during monitoring. Exhausted review
passes leave the PR for a human. A `NO-GO` summary must contain concrete findings;
missing, malformed, contradictory, or stale summaries require human attention.

Monitoring reads every PR's current head, paginated check runs and commit statuses,
GitHub mergeability and merge state, changes-requested reviews, and paginated
unresolved review threads. Latest status per context wins. Unknown mergeability,
pending/failed checks, stale check SHAs, drafts, unresolved threads, and blocked
merge states keep the PR pending. Pending checks and unknown mergeability wait
without repair messages; completed failures, conflicts, behind branches, drafts,
and review findings trigger repairs. Repairs get an immediate fresh snapshot.
A ready PR is open, non-draft, clean and mergeable,
with acceptable completed checks and current-head GO reviews. No checks is allowed
when GitHub reports clean mergeability. The flow reports readiness for human merge;
it does not claim to replace repository protection rules.

The monitor starts after implementation and initial review. Its deadline and poll
waits are journaled commands; repair/reviewer timeouts are capped to the remaining
budget. Budget expiry reports the last observed status and starts no further
GitHub reads; a completed clean snapshot takes precedence over expiry. Budget
expiry, agent timeouts returned as results, invalid summaries, exhausted review
passes, or refused dirty-worktree removal complete with `needs_human` and details.
Failed journal steps and session-release errors propagate their failure after
cleanup attempts; catching them cannot overwrite the runtime's verdict. Empty issue lists
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
