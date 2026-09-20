# Babysitter v2 scope matrix

Base: flows origin/main 823d3b3f. Behavioral source: AgentWorkforce/agents
origin/main review/agent.ts and review/persona.ts. Consolidates the existing
pr-reviewer example and workflows/pr-review implementation.

| Area | Intended gate |
| --- | --- |
| PR lifecycle | opened, synchronize, reopened, ready_for_review; validated coordinates and exact live SHA |
| Review/check wakes | submitted reviews and completed checks; configured merge opt-in, organizations and approvers |
| Issue comments | generated issue_comment exists; explicit authorized conflict directive only |
| Review | parallel maintainability/history/structure lenses; nonempty JSON artifacts; deterministic reconciliation |
| State | reject missing/closed/merged/draft, skip labels, disallowed authors, missing/pending/red checks, stale approvals and heads |
| Edits | deterministic mechanical transforms only; protected paths veto; pinned validation in f.run; same-repository pushes; new head is never READY |
| Publication | one authenticated owned comment, idempotency, stale-write refusal; investigate cross-run atomicity before claiming strict guarantees |
| Compatibility | CI-red attribution, once-per-head notification, bounded 137/143 retry; expose concrete platform blockers |
| Evidence | capture failing tests before implementation, rerun with literal command/output; flows check, typecheck, SDK/surface tests |

Known platform constraints under investigation: Cloud source submission does not
resolve sibling imports (packages/sdk/src/cloud-run.ts); REST comment PATCH has
no head-SHA guard and scan/create is not atomic across runs. These must not be
papered over by successful mock responses.
