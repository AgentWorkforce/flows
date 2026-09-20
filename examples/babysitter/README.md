# Babysitter

Babysitter is the shared successor to `examples/pr-reviewer` and
`workflows/pr-review.flow.ts`. It combines the former's live-state gates with
parallel independent lenses and deterministic reconciliation. It is repository
agnostic. **This migration is not ready for unattended deployment:** the current
surface cannot guarantee the write and recovery contracts below. A blocked gate
returns `needs_human`, never a successful simulated publication or merge.

The implementation is split into input validation, live state, edit/conflict
safety, artifacts, CI attribution, GitHub transport, workspace commands, and the
flow body. The original implementations remain only as regression baselines.

## Operator input

Pin configuration outside the PR and webhook, for example:

```json
{"owner":"acme","repo":"widgets","number":7,"headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","testCommand":"npm test","botLogin":"babysitter[bot]","approvers":["alice"],"organizations":["acme"],"merge":false,"reviewAuthors":[],"skipLabels":["no-agent-relay-review"],"requiredChecks":["unit"]}
```

A webhook is optional under `event`; it can never redirect those coordinates,
head, validation command, approvers or organization policy. The trigger router
must combine the raw webhook with **operator-owned** configuration; it must not
accept policy fields from PR content. Seven generated handlers call the same
body: opened, synchronize, reopened, ready_for_review, review submitted, check
completed, and issue comment created. Raw events without pinned configuration
fail input validation. No handler acknowledges an event with a no-op success.

Live reads include paginated checks, statuses and reviews, and a final head
recheck. Unknown state, missing metadata/checks, pending mergeability, red CI,
changes requests and requested reviewers without exact-head approvals all hold
the gate. Empty check lists do not pass even when GitHub says CLEAN. Merge also
requires opt-in and an independent configured approver at the full live SHA.
The transport retains GitHub's server-side SHA merge guard, but the flow does
not call it until an exact-head durable review receipt can be published.

Review uses an isolated checkout pinned to head and base SHAs and a full
three-dot diff. Independent maintainability/history/structure artifacts must
be nonempty JSON at the same SHA. Reconciliation retains every non-nit finding;
an empty lens cannot erase another's dissent. Operator validation runs in
`f.run`, outside the agent. Any checkout change fails verification. No agent
READY sentinel, proposed semantic fix, or agent assertion can authorize a push,
approval, merge or READY notification.

## Current dependencies (red tests, not implemented effects)

- **Owned comment writeback:** `workflows/pr-review-post.cjs` historically uses
  REST scan/create/PATCH and commit dates to order rebases. Concurrent runs can
  both create, or race after re-reading before PATCH. REST comment endpoints
  have no PR-head precondition; per-step journal receipts are not a per-PR
  cross-run lock. Required: provider-backed serialized idempotent owned-comment
  upsert with a durable current-head/review receipt and stale-write fencing.
  `publicationDecision` models refusal, but `atomicPrPublication` stays false.
  No comment is posted or approval/merge claimed by this migration.
- **Safe editing:** `packages/surface/src/context.ts` says permissions are
  validated declarations, not enforcement (gate 8 / #442). A prompt is not a
  security boundary. `editAllowed` accepts only a narrowly mechanical operation
  on inert text paths, rejects test/gate/workflow/script/config edits, forks,
  failed validation and unresolved conflicts. No automatic edit or push is
  enabled. Explicit authorized conflict directives are recognized but handed to
  humans; semantic conflict resolution is not mechanically provable.
- **CI attribution and notifications:** `packages/surface/src/memory.ts`
  explicitly reserves `learn` and currently refuses writes. Recall is local,
  not a durable write receipt. The sticky legacy attribution helper and stable
  repository/PR/head notification key are preserved. Required: journal-backed
  cross-run observations and atomic per-head delivery receipts. They are not
  substituted with local files or Slack success mocks.
- **Infra retry:** `AgentResult` exposes only summary/artifacts, while the worker
  journals exit code internally. The authored step has no typed selective
  retry. `retryInfra` pins exactly one retry for 137/143; it cannot be wired to
  `f.agent` by parsing an error string or assuming all worker errors are OOM.
- **Cloud source imports:** `packages/sdk/src/cloud-run.ts` documents that hosted
  authored submissions do not resolve siblings. `node build.mjs` bundles the
  small source modules into one generated file with the surface external.
  This solves source delivery only; it does not solve the effect blockers.

`tests/platform.test.ts` contains executable, deliberately failing TODO
assertions for the five missing capabilities. A test runner exit code of zero
with those TODOs does **not** mean the workload is accepted. No live workload or
cross-run exactly-once effect is claimed. See `evidence/` for literal commands
and output, and `SCOPE.md` for the requested scope.
