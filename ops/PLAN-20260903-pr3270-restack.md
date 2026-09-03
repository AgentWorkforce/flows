# cloud #3270 restack plan — prepared 2026-09-03 by relayflow-lead-0903

Written ahead of time so the restack is mechanical the moment #3264 merges.
Do not start it while #3264's head is still moving.

## The situation, stated correctly

#3270 (`feat/relayflow-v2-executor`) is **stacked on #3264**, not on main:

    $ gh pr view 3270 --json headRefName,baseRefName
    head=feat/relayflow-v2-executor  base=feat/relayflow-dual-runtime-v2
    $ gh pr view 3264 --json headRefName,baseRefName
    head=feat/relayflow-dual-runtime-v2  base=main

An earlier handoff recorded #3270's CONFLICTING as "stale, GitHub is wrong,
local merge-tree vs main is CLEAN." That check used the wrong base. Against
`main` it is clean only because #3270 currently *contains* #3264's older
commits. Against its real base it genuinely conflicts:

    $ git merge-base --is-ancestor 9e1a83b6 refs/remotes/pr/3270   # YES
    $ git merge-base --is-ancestor dc3edc88 refs/remotes/pr/3270   # NO

#3270 was restacked onto #3264's then-head `9e1a83b6`. #3264 has since been
force-pushed twice, to `ba6effa7` and then `dc3edc88`.

## Conflicting paths against #3264 @ dc3edc88 (15)

    packages/core/src/db/schema.ts
    packages/web/app/api/v1/workflows/run/route.ts
    packages/web/app/api/v1/workflows/schedules/[scheduleId]/route.ts
    packages/web/app/api/v1/workflows/schedules/route.event.test.ts
    packages/web/drizzle/meta/0119_snapshot.json
    packages/web/drizzle/meta/_journal.json
    packages/web/lib/workflow-schedules/request.test.ts
    packages/web/lib/workflow-schedules/store.pglite.test.ts
    packages/web/lib/workflow-schedules/store.ts
    packages/web/lib/workflows.ts
    packages/web/lib/workflows/launch-job-envelope.ts
    packages/web/test/handlers/workflow-schedules.test.ts
    sst.config.ts
    tests/helpers/relayfile-writeback-pglite-db.ts
    tests/workflow-run-route.test.ts

## The migration renumber — this is the part that must not be botched

The plan of record said #3270's authority migration becomes **0119**. That is
now WRONG. #3264 at `dc3edc88` owns BOTH:

    packages/web/drizzle/0118_workflow_run_relayflow_version.sql
    packages/web/drizzle/0119_workflow_schedule_relaycron_reconcile.sql

so #3270's `relayflow_v2_authority` migration must move to **0120**, and
`0119_snapshot.json` in the conflict list above is exactly this collision.

Rule, learned the expensive way on this same stack: **regenerate the snapshot
from its true predecessor; never resolve the journal conflict by keeping one
side.** A keep-ours resolution silently drops the other migration from
`_journal.json`, which becomes a skipped migration in deployed environments.
After the renumber, run the journal gate and read its output, do not assume it.

## Sequence

1. Wait for #3264 to merge to main. Do not start before that — a restack onto
   an unmerged, still-moving branch has to be redone.
2. Re-fetch. Record the exact new `origin/main` SHA and the exact current
   remote `refs/pull/3270/head`. Both go in the report.
3. Restack #3270's product commits onto the new main. #3264's commits are now
   *in* main (squashed), so #3270's copies of them are redundant — drop them
   and keep only #3270's own executor work. Verify the resulting diff contains
   no #3264 content: `git diff origin/main..HEAD --stat` should show only
   executor files plus the 0120 migration.
4. Renumber the authority migration and its snapshot to 0120; regenerate the
   snapshot from main's post-0119 baseline so main's 0118 and 0119 objects are
   folded in, not overwritten; update `_journal.json` to a contiguous index.
5. Preserve the migration invariant: an omitted selector still means v1; v2 is
   explicit and authority-pinned. Do not remove or reinterpret v1.
6. Run the gates and capture literal output: the web drizzle journal test, the
   replay-migrations/schema-drift job, the registered suites, typecheck.
7. `git push --force-with-lease` pinned to the exact remote SHA recorded in
   step 2. Never a bare `--force`, never `--no-verify`. If the remote moved,
   stop and re-derive.
8. Retarget the PR base from `feat/relayflow-dual-runtime-v2` to `main` once
   #3264 is merged, or GitHub will keep computing against a dead branch.
9. Only then: fresh independent signoff at the new exact head.
10. Only after signoff: the live proof per
    `cloud-relayflow-v2-executor-wt/ops/reviews/20260902-1740-pr3270-proof.md`
    — real Cloud v2 execution, exported authoritative journal bytes, exact
    authority tuple (epoch, artifact key/SHA, source commit, protocol,
    manifest), exact expected step identities and count, exactly one terminal
    `run.completed`, no post-terminal entries, token lifetimes safe for both
    sequential polls — plus a SEPARATE omitted-selector v1 run that still
    succeeds. No local simulation, route mock, or control-plane
    acknowledgement satisfies this.

## Standing constraint

Merging a cloud PR push-deploys to prod; there is no branch protection. Per
[[feedback-prove-on-dev-first]] the change's own acceptance signal must be
OBSERVED on the dev-deployed artifact before merge. For #3270 that observation
IS the live proof in step 10. CI-green plus a green dev deploy does not
substitute for it.
