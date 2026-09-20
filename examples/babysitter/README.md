# Babysitter

Babysitter is the shared successor to `examples/pr-reviewer` and
`workflows/pr-review.flow.ts`. It combines the former's live-state gates with
parallel independent lenses and deterministic reconciliation. It is repository
agnostic. **This migration is not ready for unattended deployment:** the current
surface cannot guarantee the write and recovery contracts below. A blocked gate
returns `needs_human`, never a successful simulated publication or merge.

The implementation is split into the subscription contract, wake binding, input
validation, live state, edit/conflict safety, artifacts, CI attribution, GitHub
transport, workspace commands, trigger liveness, and the flow body. The original implementations remain only as regression baselines.

## The subscription contract

Babysitter is resident. It declares eleven GitHub subscriptions once, in
`subscriptions.ts`, and that declaration is the single source of the flow's
`.on(...)` registrations, of the event families `parseInput` accepts, and of the
set the liveness sweep expects. A handler cannot drift from what the validator
accepts, and the sweep cannot watch for something nothing registers.

| Subscription | Why the resident needs the wake |
| --- | --- |
| `pull_request.opened` | A new PR may be in scope |
| `pull_request.synchronize` | A new head invalidates every verdict bound to the old one |
| `pull_request.reopened` | A PR previously out of scope is back in it |
| `pull_request.ready_for_review` | A draft left draft state |
| `pull_request.closed` | Stop working a PR that live state will confirm is closed or merged |
| `pull_request.labeled` / `.unlabeled` | A skip or merge-policy label may now apply, or have been withdrawn |
| `pull_request_review.submitted` | An approval or change request may move the merge gate |
| `pull_request_review.dismissed` | A dismissal can withdraw the approval a merge gate rested on |
| `check_run.completed` | CI reached a conclusion the merge gate reads |
| `issue_comment.created` | An explicit, authorized conflict-repair directive may have arrived |

### A webhook is a wake hint, never evidence

This is the load-bearing rule and the code is arranged around it.

Every wake — all eleven subscriptions, and a direct operator run — reaches the
same body, which **rereads authoritative live state before it decides anything**
and binds its action to **the head that live read reports**. The delivered
payload supplies no fact. Its claimed head, state, labels, review verdict and
check conclusion are all re-read, so:

- A `closed` hint over a PR that is live-open does not stop work; an `opened`
  hint over a PR that is live-merged does not resurrect it.
- A `submitted`/`approved` hint cannot assert an approval that live reviews do
  not show, and a `completed`/`success` hint cannot assert a green check.
- A `labeled` hint cannot add a skip label that live labels do not carry, and an
  `unlabeled` hint cannot remove one that they do.

**Duplicate delivery** therefore repeats a decision rather than adding one: two
deliveries of the same event produce byte-identical command streams and one
decision key. **Out-of-order delivery** decides about the head that exists now:
a `synchronize` born on an older head, delivered after two more pushes, binds
the current live head and records `hint=stale-hint` — honest about being late
without acting on it. `wake.ts` holds this contract; `decisionKey` names the
subscription and the *live* head, never the payload's.

## Operator input

Pin configuration outside the PR and webhook, for example:

```json
{"owner":"acme","repo":"widgets","number":7,"testCommand":"npm test","botLogin":"babysitter[bot]","approvers":["alice"],"organizations":["acme"],"merge":false,"reviewAuthors":[],"skipLabels":["no-agent-relay-review"],"requiredChecks":["unit"]}
```

`headSha` is **optional and is not a coordinate**. Omitted — the resident
default — each wake binds whatever head the live read reports. Supplied, it is a
*constraint* for one-shot audits: the run declines once live state moves past
it. A webhook can never set it, and it is never a substitute for the reread.

A webhook is optional under `event`; it can never redirect the coordinates,
head, validation command, approvers or organization policy. The trigger router
must combine the raw webhook with **operator-owned** configuration; it must not
accept policy fields from PR content. Two classes of event check, and the
difference is deliberate: **routing** is enforced (an event naming another
repository or another PR is misrouted, and throws), while **content** is not (a
late or disagreeing payload is an ordinary hint). An action outside the declared
contract is refused — there is no "some other event" branch, because a branch
Babysitter cannot name is one it cannot gate. Raw events without pinned
configuration fail input validation. No handler acknowledges an event with a
no-op success.

Live reads include paginated checks, statuses and reviews, and a final head
recheck. Unknown state, missing metadata/checks, pending mergeability, red CI,
changes requests and requested reviewers without live-head approvals all hold
the gate. Empty check lists do not pass even when GitHub says CLEAN. Merge also
requires opt-in and an independent configured approver at the full live SHA.
The transport retains GitHub's server-side SHA merge guard, but the flow does
not call it until a live-head durable review receipt can be published.

## Preflight and liveness

`flows check` refuses this flow before deployment when the `github` inbox is
absent from `flows.json` (`REFUSED [no_executor]`, exit 2) and when a declared
subscription names an event type GitHub does not publish — the same registry
ingress reads. `evidence/12-flows-check-preflight.txt` carries both the pass and
the refusal.

Each wake emits one deterministic observation line naming the subscription, the
bound head, whether the delivered hint was already stale, and the decision key.
`liveness.ts` turns those records into a per-subscription status —
`live` / `stale` / `pending` / `never` — so a subscription that quietly stops
firing is distinguishable from one that is merely quiet (RFC-0001 gate 2's
trigger-liveness requirement; the Native silent-death failure class). The sweep
is pure and proven; what it still lacks is listed below.

Review uses an isolated checkout pinned to the bound live head and base SHAs and a full
three-dot diff. Independent maintainability/history/structure artifacts must
be nonempty JSON at the same bound SHA. Reconciliation retains every non-nit finding;
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

- **Durable subscription liveness:** the sweep in `liveness.ts` is pure and
  covered, but nothing durably records "subscription X fired at T" where the
  next run can read it. Until it does, a subscription that stops firing is
  indistinguishable from a quiet one across runs, and the within-run observation
  line is the only signal. `durableSubscriptionLiveness` stays false.

`tests/platform.test.ts` contains executable, deliberately failing TODO
assertions for the five missing capabilities. A test runner exit code of zero
with those TODOs does **not** mean the workload is accepted. No live workload or
cross-run exactly-once effect is claimed. See `evidence/` for literal commands
and output — including three mutation verifications of the wake contract
(`10-`, `11-`), which revert a specific behavior, capture the failure, restore
byte-for-byte and capture the pass — and `SCOPE.md` for the requested scope.

## Running the tests

The suites resolve `@relayflows/surface` from the repo root and the SDK's
provider-trigger contract from source, so no publish step is involved:

```bash
(cd packages/surface && npm ci && npx tsc)      # build the surface dist
mkdir -p node_modules/@relayflows && ln -sfn "$PWD/packages/surface" node_modules/@relayflows/surface
node --experimental-strip-types --test examples/babysitter/tests/*.test.ts
```
