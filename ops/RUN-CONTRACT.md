# Autonomous run contract — flows + harness programs

Operating under the `autonomous-actor` contract (cloud
`.agentworkforce/workforce/personas/autonomous-actor.json`). Authored
2026-08-27 when Khaliq stepped away. Re-read before every irreversible action.

## 1. Deliverable

Drive both programs to their next milestones without babysitting:
- **flows**: close gate 1 (`agent` rung landing now), then gate 6 → gate 2 → gate 5.
- **harness** (`sales/harness`): proof points 1–4, under its own directives.

## 2. Authorities — granted by Khaliq, 2026-08-27, verbatim:
> "u have permissions to merge moving forward if all green and pr feedback is
> addressed. im stepping away for a while so use the cloud autonomous actor
> contract to continue driving this autonomously"

- **AUTO-MERGE — GRANTED**, bounded by the bar in §3.
- **SWARM — GRANTED**: dispatch codex-impl + claude-review pairs (never
  codex-lead + codex-impl) with written sub-contracts and status files.
- **ROLLBACK — PRE-AUTHORIZED** on the triggers in §5: revert the merge
  immediately, then diagnose. Never wait-and-see.
- **FLIP — NOT APPLICABLE**: no prod cutover in scope. If one appears, freeze
  and escalate.
- **NOT GRANTED**: production SQL writes (the one enrollment-token mint was
  explicitly requested and is closed), customer-visible actions, any change to
  RFC-0001 covenants or a program's DIRECTIVES.

## 3. The merge bar (all must hold, verified live within 60s of merging)

1. `gh pr view <n> --json mergeable,mergeStateStatus,statusCheckRollup` →
   `MERGEABLE` + `CLEAN`, every check SUCCESS. Snapshots go stale; re-verify.
   **A green check is not review signal.** On PR #8 both bots were green while
   neither had reviewed — CodeRabbit rate-limited into skipping, Devin's trial
   expired. Confirm a bot actually produced findings (or an explicit
   "reviewed N files") before counting it; otherwise treat the PR as having no
   external review and lean entirely on the adversarial gate plus my own
   reading of the diff.
2. Every inline review comment triaged **at HEAD**, with a reply recording the
   audit. Never silently wave, never silently dismiss.
3. The tick's own gates genuinely ran: `VERIFY_PASS` from a suite that
   executed (a gate that runs nothing is a failure — harness directive 5), and
   an adversarial verdict whose text I read, not just its token.
4. No secrets, credentials, or run artifacts in the final tree.
5. Serialize through green main: after merging A, pull main, confirm the next
   PR rebases clean, and re-verify its bar before merging B.

Anything short of the bar → the PR stays open and the reason is recorded.

## 4. Standing constraints

- A gate that runs nothing fails. A "succeeded" that did nothing is a bug.
- Instrument, don't guess, after two consecutive failed fixes on one symptom.
- Battle-tested ≠ works-once.
- **Isolated git worktrees for ALL my repo operations while a tick is live** —
  not only edits. On 2026-08-28 I ran `git checkout main && git reset --hard`
  in the primary checkout to re-register a cloud schedule while tick 14 was
  building there; it yanked the branch from under a running tick. The work
  survived (`5b1226e`, rescued to `rescue/tick14-live-kernel`), but only by
  luck of it being committed. If a command needs the repo, it runs in
  `/tmp/flows-ops`; if it needs the flows CLI, it runs from a worktree, never
  from the checkout a tick owns.
- File-based reporting: `ops/DRIVE-LOG.md` per program, `ops/SCOREBOARD.md`
  for gate state. Surface to Khaliq only at action points.

## 5. Rollback triggers (execute immediately, then diagnose)

- Main's build or test suite goes red after a merge I made.
- A merged change causes a subsequent tick to fail its verify.
- Any credential or customer-visible artifact discovered post-merge.

Rollback = `git revert` the squash commit on a branch, verify green, merge.

## 6. Escalate to Khaliq (ping with context; keep driving everything else)

- A directive or covenant would have to change to proceed.
- A customer-visible or irreversible external action is required.
- Two consecutive ticks fail the same way after an instrumented attempt.
- Spend or scope materially exceeds what this contract implies.
- Anything touching production data beyond reads.
