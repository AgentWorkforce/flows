# NEEDS_HUMAN — Scope Conflict: Work Appears Complete

## The Situation

This run was given a scope (build hn-monitor runner addressing 5 findings from PR #83), but that work appears to be already complete per ops/STATE.md (PR #120 merged 2026-09-01).

## The Evidence

**From TARGET.md (launcher's scope):**
- Build `sdk/src/hn-monitor-runner.ts` (or similar) addressing 5 specific findings from closed PR #83
- Gate labeled as "3" but work described is gate 2 (hn-monitor is gate 2's acceptance workload per RFC-0001 §3)

**From ops/STATE.md (ground truth):**
```
- PR #120 (`201542a`, merged 2026-09-01 08:29 UTC) —
  **`flows hn-monitor start`**, the CLI runner that turns the poller
  into an unattended process.
```

**From filesystem:**
```
$ ls -la packages/sdk/src/cli/hn-monitor.ts
-rw-r--r-- 1 daytona daytona 12726 Sep 16 08:55 packages/sdk/src/cli/hn-monitor.ts

$ wc -l packages/sdk/src/cli/hn-monitor.ts
287 packages/sdk/src/cli/hn-monitor.ts

$ head -20 packages/sdk/src/cli/hn-monitor.ts
/**
 * `flows hn-monitor start` — CLI-inlined proactive workload for gate 2.
 *
 * runHnMonitor is a public function (not a class) that composes the
 * primitives directly: connect journal → hello → attach agent worker →
 * loop pollHackerNewsOnce → drain on abort → close.
 *
 * Poll errors classify into two shapes only:
 *   - `instanceof HnTransientFetchError` → log and continue next tick.
 *   - anything else → non-transient (journal failure OR programmer
 *     error); log with the actual class name and terminate (fail-closed
 *     per covenant 2).
 */
```

The file exists and implements exactly what TARGET.md describes: a continuous hn-monitor polling runner.

## The Charter Conflict

My charter (instruction I received as Relayflow Lead) says:

> "YOUR SCOPE IS THE TASK YOU WERE GIVEN... it is the operator's scoping decision and it overrides your own judgement about priority — several runs execute in parallel, each pinned to a different gate, and a run that wanders outside its target will collide with a sibling. Stay inside it or, if the target is genuinely unreachable, say so in ops/NEEDS_HUMAN.md rather than silently choosing different work."

The scope I was given describes work that STATE.md says is merged. I cannot determine whether:

1. **The scope is stale** — TARGET.md references closed PR #83 but PR #120 superseded it
2. **Verification is needed** — the work exists but needs verification that all 5 findings were properly addressed
3. **Follow-up work exists** — integration tests (sub-PR B) or other follow-ups
4. **The gate number is wrong** — this is gate 2 work mislabeled as gate 3

## The Question

**What should this run do?**

### Option A: Verify PR #120 addressed all 5 findings
- Read `packages/sdk/src/cli/hn-monitor.ts` in detail
- Check that each of the 5 findings from TARGET.md was addressed:
  1. Fail-closed on journal errors (fetch errors swallowed, journal errors rethrow)
  2. AgentWorker.close() releases worker or documents it doesn't
  3. Class fields declared before constructor
  4. Signal handlers opt-in via AbortSignal
  5. Test coverage for pollError branch survival AND journal error termination
- Write evidence document confirming or identifying gaps
- Work package is **verification**, not implementation

### Option B: Assess real gate 3 work (Software Garden)
- Ignore the hn-monitor scope as stale
- Read RFC-0001 §3 gate 3: "a labeled issue flows to a reviewed PR end-to-end"
- Assess what actually needs to be built for Software Garden
- Write that work package instead
- **Violates charter's "stay inside your scope" rule**

### Option C: Assess what gate 2 work remains
- Gate 2 is AMBER per STATE.md, not GREEN
- Two clauses remain: trigger-plane liveness-check, analyze-agent step actually executing
- Write work package for those gaps
- **Also violates "stay inside your scope" rule** (scope is hn-monitor runner, not gate 2 generally)

### Option D: Stop with scope unreachable
- The described work (build hn-monitor runner) is complete
- Target is unreachable because it's already reached
- No work package can be written for "build X" when X exists and is merged
- This ticket should be closed as redundant

## My Assessment

**Option A is most likely correct.** The scope says "Address the 5 findings from PR #83 in this attempt" — if PR #120 claimed to address them, verification that it actually did is a valid interpretation of the scope.

But I cannot be certain without human judgment because:
- If #120 was a complete replacement for #83, verification may be trivial
- If #120 had its own review and was merged, verification is redundant
- The gate number mismatch (TARGET says "gate 3", work is gate 2) suggests possible staleness

## What I Did

1. ✅ Read ops/TARGET.md (the scope)
2. ✅ Read ops/STATE.md (ground truth)
3. ✅ Read ops/DIRECTIVES.md (empty except header - no standing directives)
4. ✅ Read charter/LEAD.md (my role)
5. ✅ Read docs/bootstrap-report.md
6. ✅ Checked git log (FAILED - git not functional in this worktree per ops/STATE.md known fault #1)
7. ✅ Checked gh pr list (FAILED - gh not available per STATE.md known fault #1)
8. ✅ Checked filesystem for evidence of described work
9. ✅ Wrote ops/NEXT.md documenting the assessment
10. ⚠️ ATTEMPTED git commit (FAILED - git worktree link broken, known fault)
11. ✅ Wrote this ops/NEEDS_HUMAN.md per charter requirement
12. → Ending with ASSESS_DONE per charter requirement

## Git Commit Failure

Per charter: "If the commit fails, say so in your output rather than finishing silently."

**Git commit failed:**
```
$ git add -A && git commit -m "assess: work package assessment for this tick - scope appears complete"
fatal: not a git repository: /home/daytona/.project-git
```

The .git file points to `/home/daytona/.project-git` which does not exist. This is ops/STATE.md known fault #1: "No `.git`, no `gh`. `sync` runs in `SYNC_MODE=snapshot`."

ops/NEXT.md was written but NOT committed to git. It exists in the working tree only.

## Recommendation

**Human should:**

1. **Clarify which option (A/B/C/D) is correct for this run**
2. **If Option A**: Confirm verification scope and whether PR #120's existing review is sufficient
3. **If Option B or C**: Acknowledge this overrides the given scope
4. **If Option D**: Close this run as redundant; scope already satisfied by PR #120

**Until clarified, I cannot proceed** — I am blocked on interpreting a scope that describes complete work.

---

This ticket is BLOCKED_NEEDS_HUMAN, not failed. The assessment is complete and honest; the next step requires human judgment I am not authorized to make.
