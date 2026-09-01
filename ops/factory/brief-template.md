# Brief for factory worker `<TASK_ID>`

This file is templated by `ops/factory/spawn-worker.sh` and handed
to `agent-relay fleet spawn claude` as the agent's task. Placeholders
in `<ANGLE_BRACKETS>` are substituted at spawn time.

## Task

<TASK_SUMMARY>

<TASK_BRIEF_BODY>

## Rules of engagement

You are working on repository `AgentWorkforce/flows` at branch
`factory/<TASK_ID>` in worktree `<WORKTREE_PATH>`. This is an
isolated scratch worktree — you have exclusive write access, no
other agent is on this branch.

Non-negotiables:

1. **You are ALREADY on the correct branch and worktree.** The
   driver has done `git worktree add -b factory/<TASK_ID>
   <WORKTREE_PATH> origin/main` for you. Do NOT run `git checkout
   -b factory/<TASK_ID> origin/main` — that would fail with
   "branch already exists." Just `cd <WORKTREE_PATH>` and begin
   your work; every commit you make lands on
   `factory/<TASK_ID>`.
2. **Do NOT touch any judge — the full refused-path set is:**
     - `ops/factory/**`             (this driver, briefs, template)
     - `ops/preswarm-check/**`      (local pre-swarm runner)
     - `workflows/preswarm-check.yaml`  (pre-swarm workflow)
   All three are gates you are judged by. Editing any from
   inside a factory-authored PR violates RFC-0001 settled
   decision #6 ("no gate editable by the agents it judges"). If
   your task requires such a change, ABORT and emit
   `FACTORY_RESULT: STATUS=failed REASON="refused: touches protected gate paths"`
   as your last line — the queue line will be marked `- [!]` and
   a human will take the task. The DRIVER ALSO enforces this at
   diff-check time using the same path list: even a PR that
   gets opened will be refused if its diff touches any of the
   three.
3. **Run pre-swarm-check locally as an ADVISORY check** — after
   your code is ready and committed, run:

       flows run workflows/preswarm-check.yaml

   If any lens returns `REVIEW_FAILED`, address the finding and
   re-run. Only push when all three lenses PASS locally.

   **This is advisory, not the merge gate.** You are running the
   pre-swarm workflow from your own worktree, on your own branch,
   against a rulebook you could theoretically edit — that is why
   rule #2 above forbids touching `ops/preswarm-check/**` and
   `workflows/preswarm-check.yaml`, and why the DRIVER's
   post-worker diff check refuses either regardless of local
   preswarm output. The enforcement gates on this PR are: (a)
   the driver's diff check (refuses protected paths), (b) the
   post-push review-swarm (M/H/S lenses on the diff), (c) the
   auto-merge loop, which only fires on
   `🎯 review-swarm: PASSED`. Treat local preswarm as a fast
   quality signal, not authority.
4. **Do NOT bypass safety rails** — no `--no-verify`, no
   `--force` without `--force-with-lease`, no editing gates, no
   secrets in tracked files.
5. **One commit, truthful message** — squash your work into one
   commit before pushing. The commit body should include:
   - What ships (per-file numstat from `git diff main..HEAD --numstat`)
   - Behavior summary
   - Test roster + captured `test result:` output
   - FAIL-first mutation evidence (mutate → capture output → restore)
   - Known limitations / non-goals

## What "done" looks like

- Branch pushed to `origin/factory/<TASK_ID>`.
- PR opened with a body summarizing the change + linking to the
  brief. The post-push `review-swarm` (already running as a
  launchd loop on the host) will review it; `auto-merge` will
  merge on all-lens PASS.
- You emit ONE final line to stdout in this exact shape:

      FACTORY_RESULT: PR=<pr-number> STATUS=opened

  The driver keys on this line to mark the queue.

- If you cannot complete the task, emit:

      FACTORY_RESULT: STATUS=failed REASON="<one-line reason>"

  The driver marks the queue `- [!]` and moves on.

## What NOT to do

- Do not merge the PR yourself — the human owns merge.
- Do not iterate against the post-push swarm — the driver's
  spawn does not track that; a new worker will handle any
  follow-up.
- Do not update `ops/factory/queue.md` — the driver writes it.
- Do not modify `ops/BACKLOG.md`, `ops/DRIVE-LOG.md`, or any file
  in `ops/reviews/` unless your task specifically calls for it.
