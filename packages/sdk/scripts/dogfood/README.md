# PR close loop

`close-pr.flow.ts` is the companion to slice implementation. Invoke it after
the slice branch has been pushed. Running this flow opts into repair commits,
force-with-lease pushes, and squash merge with branch deletion.

Set `IMPL_CLOSE_INPUT` to JSON in the **daemon's environment** (deterministic
commands inherit that environment):

```json
{
  "worktree": "/absolute/path/to/slice-worktree",
  "repo": "owner/repository",
  "branch": "feat/slice",
  "base": "main",
  "title": "Implement slice",
  "body": "Closes #123",
  "cli": "codex",
  "model": "your-configured-model"
}
```

Launch with `flows run packages/sdk/scripts/dogfood/close-pr.flow.ts --input '{}'`
using the daemon carrying that input. Alternatively, save the JSON in a file and
pass `--input close-input.json`; this is also captured in a journaled step and
does not require setting the daemon's environment. The worktree must be clean
and on the named branch.
`gh` must be authenticated with access to checks, Actions logs, review threads,
PR creation and merging. Attach a workspace-capable agent worker holding the
worktree's revision pins, launched from that worktree. The stream-only
`--local-agent` worker cannot accept a workspace declaration in this SDK.

Optional `prNumber` selects an existing PR; otherwise the flow looks up the open
PR for the branch before creating one. `cli` defaults to `codex`; the model is
passed through to normal SDK preflight. `pollIntervalSeconds` defaults to 15
and `maxPolls` to 120 per pushed head. Three **repair attempts** are allowed;
pending polls do not consume them, and the third repair is re-verified.

Each poll reads checks, paginated Bugbot review comments, and paginated review
thread resolution state through separate `f.run` effects. A completed check
whose name contains `Bugbot` is required, so missing/delayed reviews cannot look
green. Failed/canceled checks and Medium/High/Critical (or P0–P2) Bugbot comments
block merging. Low findings and other bots' comments are ignored. Unresolved
findings remain blocking even on old commits or outdated diff lines; only a
resolved thread clears a finding. Bugbot must resolve addressed threads on
re-review, or the run hands them to a human after its repair budget.

Failed GitHub Actions checks supply `gh run view --log-failed` output to the
repair agent. Other check providers supply their description and link. The
agent edits the same declared worktree, then deterministic steps commit changes
and push. The flow checks the PR head before and after each snapshot and passes
`--match-head-commit` to merge. It confirms `MERGED`, since `gh pr merge` can
instead enqueue a PR. A queued merge is handed off for human follow-up.

Exhaustion prints accumulated blockers in a journaled effect and calls
`f.done('needs_human')`. The authored executor records this handoff in a terminal
effect and the CLI returns exit 3 / `parked`. This is an **authored handoff**, not
a new kernel completion reason or a resumable kernel wait. The current authored
executor has no durable root: effects have journals, but restarting the whole
script does not replay them automatically. Re-invocation reuses the open PR.

Local tests simulate GitHub, the repair agent and journal transport through the
real authored executor. They do not constitute a live GitHub/agent
acceptance run. The CLI handoff also has a test against the real local daemon.
