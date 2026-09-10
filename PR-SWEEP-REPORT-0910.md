# Launch PR sweep — 2026-09-10

Scope: nine assigned flows PRs, inspected newest first. #268 and #269 were not
touched. The shared `flows-lead` checkout was detached at `be8689e`; this report
uses a separate worktree and branch `sweep/v2-launch-prep-0910`, based on
`origin/main` at `a42ca161658f9f4c3ff22c7d158d6c65dd219473`.

**GitHub operations are blocked, not complete.** Every requested `gh pr view`,
`gh pr diff`, and `gh pr checks` invocation returned HTTP 401. SSH fetch works;
all nine PR head refs were fetched and their Git diffs read. Current PR state,
body, check conclusions, run IDs, and GitHub mergeability could not be read.
No reruns, merges, closures, or PR/issue comments have been performed. The
verdicts below describe this sweep's evidence; RED does not claim a newly
observed CI failure. Draft PR creation is pending authenticated API access.

For each PR:

- flows#261 HELD — stale hn-monitor assessment, recommended superseded closure; ask: “Restore an authenticated GitHub route so #261 can be closed with the supersession evidence below.”
- flows#257 HELD — obsolete review-swarm assessment and repair narratives, recommended superseded closure; ask: “Restore an authenticated GitHub route so #257 can be closed with the supersession evidence below.”
- flows#256 HELD — stale target assessment of hn-monitor work already delivered by #120, recommended superseded closure; ask: “Restore an authenticated GitHub route so #256 can be closed with the supersession evidence below.”
- flows#253 HELD — stale README work package plus a unique Node type dependency bump; ask: “Should the Node type bump be preserved in a separately scoped PR, or discarded with this stale drive output?”
- flows#251 HELD — normative wake-context contract adds gate-2 obligations and epoch-rollover sequencing; ask: “Do you approve the wake-context contract, including transient versus permanent failure semantics and engine-side epoch rollover → D2 → gate 2 sequencing?”
- flows#244 HELD — acceptance argv can execute an agent-edited judge; existing owner contacted; ask: “Should acceptance checks declare immutable inputs, or run in an independently preserved acceptance workspace that tests the changed source?”
- flows#242 RED — selected-package completion and scope are not enforced: the report command exits zero with an out-of-scope edit and the selected implementation still broken; #244 is the related hardening work.
- flows#240 HELD — contains a new gate-5 memory-provider contract as well as the scoreboard edit; ask: “Do you approve the gate-5 memory-provider contract in this PR, or should it be split from the gate-7 scoreboard correction?”
- flows#238 RED — migration script crashes with AttributeError on a scalar step instead of returning its documented REFUSED diagnostic (reproduced at the fetched head).

## Evidence and limits

Captured commands and literal output are in
[ops/runtime-evidence/pr-sweep-0910.txt](ops/runtime-evidence/pr-sweep-0910.txt).
That file includes all nine failed API read sequences, exact fetched head SHAs,
diff statistics, local merge simulations, supersession history, and the two
executed defect probes. Full Git diffs remain accessible from the recorded SHAs.

`git merge-tree --write-tree origin/main refs/sweep/<n>` returned zero for all
nine fetched heads at the recorded main commit. This is a local merge simulation,
not a claim about GitHub's current `mergeable` or `mergeStateStatus` fields. No
PR branch was checked out, rebased, or pushed. No merge was attempted, so there
is no merge SHA to verify. The captured `git ls-remote origin refs/heads/main`
matched the recorded baseline.

The two platform fixes are present in that main history: #258 at `78ae4b8` and
#259 at `4dd9277`. Their presence does not prove any old review run now passes.
Run IDs and current failure modes remain unavailable; no speculative rerun was
submitted. A rerun may retain the old workflow definition, so its actual logs
must establish which fix it exercised.

The configured GitHub CLI account reports an invalid token. A read-only GitHub
API call through the existing `sf-mini` SSH route also returned 401, including
under its login shell. No credential was printed, changed, or transmitted.

## Supersession analysis and pending closure comments

These comments are prepared, **not posted**, and the PRs are not labeled CLOSED.
Before posting, refresh the PR's state and head and ensure the recorded diff
still applies.

### #261

Changed files: `ops/ASSESSMENT_SUMMARY.txt`, `ops/NEEDS_HUMAN.md`, `ops/NEXT.md`.
There is no implementation change. It assesses an obsolete hn-monitor target
and proposes a one-line export. #120 (`201542a`) already delivered the runner;
#226 (`2bae00c`) established the current NEXT assessment, and #234 (`6f50591`)
updated NEEDS_HUMAN with the cloud launch evidence. The newly added summary has
no main history; it is a redundant assessment, not a byte-for-byte landed file.
The export suggestion is not claimed implemented or superseded.

Prepared comment:

> Superseded drive assessment: hn-monitor was delivered by #120 (`201542a`), and the current ops state is recorded by #226 (`2bae00c`, ops/NEXT.md) and #234 (`6f50591`, ops/NEEDS_HUMAN.md). This diff adds no implementation and replaces the active review-swarm assessment with an obsolete hn-monitor target. Closing the stale drive output; the suggested public runHnMonitor export remains a separate proposal, not a change delivered by this PR.

### #257

Changed files: `REPAIR_SUMMARY.md`, `REPAIR_VERIFICATION.txt`, `ops/NEXT.md`.
The new files narrate repairing a sandbox's Git pointer and manufacturing an
assessment artifact after agent initialization failed. They do not fix relay
registration or the workflow executor. The current NEXT package at #226
(`2bae00c`) already records completed swarm preflight/documentation work;
#234 (`6f50591`) explicitly says end-to-end swarm completion remains unproven.
This PR's replacement calls the implementation COMPLETE without that evidence.

Prepared comment:

> Superseded drive output: #226 (`2bae00c`, ops/NEXT.md) already records the completed preflight/documentation work, while #234 (`6f50591`, ops/NEEDS_HUMAN.md) preserves the outstanding end-to-end review requirement. This PR adds sandbox-repair narratives and replaces that assessment with a COMPLETE claim; it contains no registration or executor fix. Closing the stale assessment rather than reinstating its obsolete work package.

### #256

Changed files: `ops/NEEDS_HUMAN.md`, `ops/NEXT.md`. Like #261, this is an
assessment of a stale target for the hn-monitor runner delivered by #120. It
also misidentifies RFC gate 3 as the product-chief gate (the RFC assigns chief
to gate 4). The operational files already have the #226/#234 state described
above; replacing them with this run-local target conflict would lose that state.

Prepared comment:

> Superseded drive assessment: the requested hn-monitor runner landed in #120 (`201542a`), and the current ops/NEXT.md and ops/NEEDS_HUMAN.md state comes from #226 (`2bae00c`) and #234 (`6f50591`). This PR changes only those assessment files and carries an obsolete run-local target conflict, not new implementation. Closing it so the current operational assessment remains intact.

### #253 — do not close as wholly superseded

`ops/NEXT.md` asks to add README secrets documentation that #226 (`2bae00c`)
already supplied. However, `packages/sdk/package.json` and its lockfile also
bump `@types/node` to `^22.20.2` / `22.20.2`. Main's manifest still declares
`^22.7.0`; this dependency change is not proven superseded. Preserve the author
decision instead of silently discarding it with the stale assessment.

## Pending human-decision comments

These are prepared, **not posted**.

- #253: @khaliqgant The NEXT.md proposal is superseded by #226's README secrets documentation, but this diff also changes the SDK Node type dependency and lockfile to 22.20.2. That change is outside the stated documentation package and is not already represented by main's manifest. Should the Node type bump be preserved in a separately scoped PR, or discarded with this stale drive output?
- #251: @khaliqgant This is a normative RFC amendment, not implementation-only documentation. It defines wake_context preservation, additive reader compatibility, transient retry versus permanent needs_human handling, and makes engine-side epoch rollover precede D2 and gate-2 completion. Do you approve the wake-context contract, including transient versus permanent failure semantics and engine-side epoch rollover → D2 → gate 2 sequencing?
- #244: @khaliqgant The pinned-Git gate inputs address earlier trust findings, but the PR explicitly retains an acceptance-input bypass: arbitrary argv can invoke a check script the implementation agent edits. Its captured probe reports PACKAGE_VERIFIED while IMPLEMENTATION=broken. I contacted flows-threads-0909 about existing ownership and have not touched the branch. Should acceptance checks declare immutable inputs, or run in an independently preserved acceptance workspace that tests the changed source?
- #240: @khaliqgant The actual diff also introduces docs/GATE5-MEMORY-CONTRACT.md, including retrieval exit-code interpretation, provider placement, token-accounting expectations, and trajectory-service responsibilities. This exceeds the title's scoreboard correction and needs an explicit scope/spec decision. Do you approve the gate-5 memory-provider contract in this PR, or should it be split from the gate-7 scoreboard correction?

## Defect details

### #238 — malformed-step refusal boundary remains open

Fetched head: `bcafd4218c7011cc3ec4214d1c14703547a59fac`.
`ops/schema-migration/migrate-legacy-workflow.py:120` calls `s.get('type')`
without validating each step as a mapping. A valid YAML document containing
`steps: [invalid-scalar]` raises `AttributeError` instead of returning a
REFUSED result. Executed with PyYAML 6.0.3 in a temporary virtual environment;
the source was extracted byte-for-byte from the fetched head. This is a
diagnostic-contract defect; no successful migration or data loss was asserted.

Reproduction input:

```yaml
version: '1.0'
name: test
workflows:
  - name: test
    steps:
      - invalid-scalar
```

The exact command and traceback are in the evidence file. Pending PR comment:

> Sweep finding at bcafd421: migrate-legacy-workflow.py:120 assumes every step is a mapping. A valid YAML input with `steps: [invalid-scalar]` raises `AttributeError: 'str' object has no attribute 'get'`, exit 1, instead of returning the documented REFUSED diagnostic. Please validate the step element shape before using `.get`; the latest refusal-boundary fix does not cover this case.

### #242 — report does not enforce the package

Fetched head: `c4831e29ae0e99020edb7282e0ec40c7abbbb427`.
The `verify` workflow step only rebuilds and runs the general SDK suite; it
does not execute selected-package acceptance checks or a scope check. The
`report` function checks HEAD equality, prints unrestricted `git diff --stat`,
and prints the DoD strings without asserting them.

The isolated report probe used the exact fetched helper, a committed
`src/value.txt` containing `broken`, metadata declaring only that file in scope
and requiring `fixed`, and an uncommitted edit to `outside.txt`. Reporting exited
zero and printed the outside edit. This proves the helper's missing checks;
**the full agent workflow and SDK suite were not run by this sweep**. #244 is
related hardening and should remain coordinated with its owner.

Pending PR comment:

> Sweep finding at c4831e2: the verify step runs only the general SDK build/suite, and report checks only HEAD equality. An isolated execution of the exact report helper returned exit 0 with an out-of-scope outside.txt edit while the declared src/value.txt task remained broken. The DoD is printed, not enforced. Please coordinate with #244's scope/acceptance hardening before treating this as safe unattended local drive execution.

## Failure taxonomy and completion work

The repository history identifies [flows#255](https://github.com/AgentWorkforce/flows/issues/255)
as the review infrastructure taxonomy issue (`c8cfe4f`, `576e5ee`). This sweep
observed a local GitHub authentication failure, not a fresh `review` run's
infrastructure mode. No taxonomy comment claiming a new review failure is
justified yet.

After GitHub authentication is restored: refresh each PR newest first; check
ownership, current heads, mergeability and checks; post the prepared findings
and decision asks; close confirmed superseded outputs with comments; rerun an
eligible review gate at most once; record any new infrastructure mode on #255.
Do not merge the two reproduced defects or the unresolved human decisions on
the strength of a green check alone. For any eventual authorized merge, post
`merged: <reason>` first and compare its merge SHA to `git ls-remote origin main`
immediately after merging. Create the report as a draft PR, and update this
report's HELD/CLOSED/MERGED statuses only after the remote actions succeed.
