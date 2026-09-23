# RFC-0002: Relayflows as callable agent tools

- **Status:** Proposed
- **Date:** 2026-09-23
- **Relationship:** Companion to `RFC-0001-everything-is-a-relayflow.md`;
  proposes a control-plane and adapter contract without changing the kernel's
  closed vocabulary.

**Analysis baseline:** `AgentWorkforce/flows` `origin/main` at
`46d994c205cb2d45bab30701a76d57650c938d6c` (2026-09-23). This is a product
proposal, not an implementation plan that claims functionality already exists.

## Executive proposal

Turn a published Relayflow into a capability an agent can discover and invoke
as a tool. A skill tells an agent how it should behave; a Flow Tool declares
the accepted input, runs a pinned executable workflow, exposes its state, and
returns a typed terminal verdict with inspectable evidence.

The prospect-facing message should be:

> Give the agent a bounded business operation, not a long instruction sheet.
> It calls `review_pull_request`, `prepare_release`, or `approve_vendor` with
> validated data. Relayflows runs the declared sequence, stops at declared
> gates, records the proof, and returns a verdict your systems can act on.

This is **not** a promise of guaranteed business results. Once the controls in
this RFC are implemented and their acceptance gates pass, a Flow Tool can
enforce: input validation; a deterministic state machine for the declared
steps; bounded retries and timeouts; explicit gates; durable resume and
idempotent effects within declared surfaces; a recorded evidence trail; and a
typed terminal verdict. It cannot guarantee that a model's judgment is right,
that a third-party API or human responds, that inputs are truthful, or that a
business outcome is desirable. Quality-sensitive decisions therefore need a
deterministic verifier, an independent review gate, or a human gate.

The initial wedge is an agent calling a small catalog of high-value,
high-repeatability operations such as PR babysitting. The differentiator is not
another tool wrapper: a tool invocation becomes an auditable, resumable flow
run with a revision, policy, budget, and evidence bundle.

Unless a section is explicitly labeled as existing foundation, the interfaces,
controls, and behaviors below are proposed. Guarantee language describes the
acceptance bar for a finished implementation, not the repository's current
capability.

## The experience the prospect should see

### Discover

An agent receives only the Flow Tools it is allowed to invoke in its current
tenant/workspace. Each catalog item has an operator-authored name, description,
input JSON Schema, result contract, permissions/effect summary, budget ceiling,
and immutable flow digest. Tool descriptions are control-plane metadata; they
are never derived from a PR, ticket, email, or other untrusted run input.

Example catalog item:

```json
{
  "name": "github_pr_babysit",
  "title": "Review and babysit a pull request",
  "description": "Re-read live PR state, run independent review lenses, validate the pinned head, and return a hold/pass verdict. It never merges unless a separately approved policy permits it.",
  "flow": "github-pr-babysit@sha256:8f…",
  "input_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["repository", "pull_request", "mode"],
    "properties": {
      "repository": {"type": "string", "pattern": "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"},
      "pull_request": {"type": "integer", "minimum": 1},
      "mode": {"type": "string", "enum": ["review", "repair_then_review"]},
      "head_sha": {"type": "string", "pattern": "^[0-9a-f]{40}$"}
    }
  },
  "result_schema": {"$ref": "https://schemas.relayflows.dev/flow-tool-result/v1"},
  "effects": ["github:read", "github:comment:conditional"],
  "requires_human": ["merge", "semantic_conflict_repair"],
  "max_wallclock": "45m"
}
```

Discovery must be filtered before it reaches the model: caller entitlement,
workspace, deployment/environment, allowed effect class, and tool version all
belong in catalog resolution. The model never gains a tool merely by naming it.

### Invoke

An agent can use the same tool in two modes.

* **Synchronous:** wait for a terminal result up to a small caller-specified
  observation bound (for example, 25 seconds). It returns a terminal result if
  one is available; otherwise the response is an accepted run, not a timeout
  presented as a failure.
* **Asynchronous:** immediately return a stable `run_id`, event URL, and
  resume/cancel links. This is the default for agent, human, or provider work.

The invocation contract is intentionally independent of any particular model
provider:

```http
POST /v1/flow-tools/github_pr_babysit:invoke
Authorization: Bearer <scoped-flow-tool-token>
Idempotency-Key: 30ff2f0a-…
Content-Type: application/json

{
  "flow": "github-pr-babysit@sha256:8f…",
  "input": {"repository":"acme/widgets","pull_request":42,"mode":"review"},
  "mode": "async",
  "caller": {"kind":"agent","id":"chief/session-123"},
  "correlation_id": "support-case-781"
}
```

The service validates the body against the tool's pinned input schema before
admission. The server owns the selected deployment, effective identity,
credentials, capabilities, and maximum budget; the caller cannot raise them in
the payload. An idempotency key is scoped to `(tenant, deployment, flow digest,
caller principal)`. Reuse with byte-different canonical input returns a
conflict, not a second run.

Accepted response:

```json
{
  "accepted": true,
  "run_id": "run_01J…",
  "flow": "github-pr-babysit@sha256:8f…",
  "state": "running",
  "status_url": "/v1/flow-runs/run_01J…",
  "events_url": "/v1/flow-runs/run_01J…/events",
  "cancel_url": "/v1/flow-runs/run_01J…:cancel",
  "evidence_url": "/v1/flow-runs/run_01J…/evidence"
}
```

### Follow progress, handle people, cancel, and resume

`GET /v1/flow-runs/{run_id}/events` is a resumable SSE projection of the
journal. Event IDs are journal sequence numbers; `Last-Event-ID` resumes a
reader without inventing state. Webhook and Agent Relay delivery are optional
projections of the same event stream, never the run's source of truth.

```text
id: 118
event: step.completed
data: {"step_id":"tests","type":"deterministic","verdict":{"status":"pass"}}

id: 119
event: human.required
data: {"wait_id":"human-1","title":"Approve release notes","input_schema":{"type":"object","required":["approved"],"properties":{"approved":{"type":"boolean"}}},"expires_at":"…"}
```

For the first MVP, retain the existing yes/no human wait as a constrained form.
The public interface should already be shaped for typed human input so a later
form does not break callers:

```http
POST /v1/flow-runs/run_01J…/human/human-1:answer
{ "input": {"approved": true}, "answered_by": "user_123", "note": "Approved in CAB-17" }
```

`POST …:cancel` records a durable cancellation request and returns the current
or terminal state. It is not a best-effort HTTP disconnect. `POST …:resume`
is idempotent; it only drives runnable work after a valid answer, recovery, or
available worker. A cancelled or terminal run never becomes a new invocation.

### Return a structured result and evidence

Every invocation ends in one envelope. `business_verdict` is flow-defined but
must be one of a published enum; `terminal_reason` is platform-defined. This
separation prevents a green transport response from being confused with a
successful business decision.

```json
{
  "run_id": "run_01J…",
  "flow": "github-pr-babysit@sha256:8f…",
  "status": "completed",
  "terminal_reason": "success",
  "business_verdict": "hold",
  "result": {
    "head_sha": "c0ffee…",
    "blocking_findings": 1,
    "next_action": "repair_then_rerun"
  },
  "gates": [
    {"name":"live_head","status":"pass","evidence_ref":"ev_01"},
    {"name":"tests","status":"pass","evidence_ref":"ev_02"},
    {"name":"independent_review","status":"fail","evidence_ref":"ev_03"}
  ],
  "evidence": {
    "journal_digest": "sha256:…",
    "flow_digest": "sha256:8f…",
    "artifacts": [{"name":"consensus.md","ref":"artifact_01","media_type":"text/markdown"}],
    "redacted_transcript_refs": ["tr_01"]
  },
  "spend": {"tokens_in": 1234, "tokens_out": 567, "dollars": "0.42", "dollars_unmetered": false}
}
```

`success` means the flow completed according to its declared control flow; it
does not mean a PR is mergeable, a campaign performed well, or a prospect was
converted. Evidence references are access-controlled and redacted by default;
raw prompts, environment variables, secrets, and unrestricted transcripts do
not travel in normal tool output.

## Recommended canonical interface and adapters

Build one canonical **Flow Tool API v1** first. Native provider function calls,
Agent Relay actions, and MCP are adapters, not separate execution paths.

| Concern | Canonical Flow Tool API | Native function calling | MCP adapter |
| --- | --- | --- | --- |
| Discovery | `GET /v1/flow-tools` | Generated function definitions | `tools/list` |
| Input schema | JSON Schema 2020-12 | Provider-compatible JSON Schema subset | MCP `inputSchema` |
| Invoke | `POST …:invoke` | Function handler calls invoke | `tools/call` calls invoke |
| Long work | run receipt + events | Returns run receipt; agent polls/subscribes | Returns structured receipt plus resource/event link |
| Result | terminal result envelope | Function result JSON | MCP structured content + JSON text fallback |
| Authority | scoped bearer/service identity | Adapter passes caller identity | Adapter passes MCP session principal |

Do not register a separate function per live run or embed credentials in a
definition. At most, publish one function per selected Flow Tool revision.

Native function-call definition generated from the catalog item:

```json
{
  "type": "function",
  "name": "github_pr_babysit",
  "description": "Run the pinned PR review workflow. Returns a durable run receipt; inspect its terminal verdict before claiming the PR is ready.",
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "required": ["repository", "pull_request", "mode"],
    "properties": {
      "repository": {"type":"string"},
      "pull_request": {"type":"integer","minimum":1},
      "mode": {"type":"string","enum":["review","repair_then_review"]}
    }
  }
}
```

The MCP server exposes `list_flow_tools`, `invoke_flow_tool`, `get_flow_run`,
`answer_flow_human_gate`, and `cancel_flow_run`. It should offer a dynamic MCP
tool only for a small, policy-filtered catalog; the generic invocation tool is
the safe fallback for large catalogs. MCP tool annotations must accurately
describe destructive/effectful behavior and idempotency. The agent should be
instructed to call the status tool after an async result rather than inferring a
result from a receipt.

For Agent Relay, register each approved Flow Tool as an action whose schema is
the generated input schema and whose action handler is only the canonical
invoker. The existing Agent Relay MCP action bridge already lists actions and
registers dynamic per-action MCP tools, but currently describes invocation as
fire-and-forget. The adapter must return the Flow Tool receipt and use the run
event projection for completion; it must not treat an Agent Relay action ack as
a completed Flow outcome.

## Replacing a SKILL.md without losing its useful parts

The right migration is **not** “convert Markdown into a prompt inside one
agent step.” It is to extract the operational contract from the skill and make
each verifiable part executable.

| A skill currently says | A Flow Tool should make executable | It remains prose/policy |
| --- | --- | --- |
| Required inputs and preconditions | Flow-level JSON Schema, preflight, capability/auth checks | Why those inputs matter; examples |
| “First inspect, then change, then test” | Ordered deterministic/agent steps; pinned inputs and workspace state | Coding conventions and heuristics |
| “Do not do X” | Permissions/effect declarations, allowlists, gates, output checks | Non-mechanical judgment and escalation guidance |
| “Ask for approval before Y” | Durable typed `human` gate and delivery policy | Who is authorized and how they deliberate |
| “Report these facts” | Result schema, evidence artifacts, terminal verdict | Tone and audience-specific explanation |
| “If it fails, retry carefully” | Explicit retry class, max iterations, timeout, recovery mode | Troubleshooting playbook for humans |

Recommended authoring addition:

```ts
export default flow<PrInput>("github-pr-babysit", {
  version: "1.0.0",
  input: PrInputSchema,                 // proposed: explicit, runtime schema
  tool: {
    name: "github_pr_babysit",
    description: "Review a pinned pull request and return a hold/pass verdict.",
    result: PrBabysitResultSchema,       // proposed: explicit terminal contract
    exposure: "workspace"
  },
  budget: { dollars: 8, wallclock: "45m" }
}, async (f, input) => { /* declared steps and gates */ });
```

TypeScript generics are erased at runtime; no caller should be told an
authored `flow<Input>` has a validated public input schema until the author
supplies one (or it is generated and reviewed from a trusted source). An input
schema must be snapshot into the built bundle and verified again at admission.

**Nested calls:** do not allow arbitrary Flow Tools to call arbitrary Flow
Tools in MVP. `f.dispatch` is a promising composition surface but is not a
publicly implemented durable child-flow capability in the current SDK. Phase 2
may allow only statically declared child digests with a parent-issued,
attenuated capability token, a depth limit (recommend 3), a descendant budget
reservation, a run-tree concurrency limit, and cycle detection over flow
digests. A child may never inherit wider credentials, write scope, human
approval authority, or the ability to alter its parent’s gates. A model calling
the external tool endpoint from inside an agent step is prohibited by default;
it bypasses those controls and makes recursion unaccounted for.

## What exists today, and the exact gap

### Existing foundation in `flows` at the analyzed revision

* The Rust kernel has a journal/state machine, leases, retries, memoization,
  durable wait/event machinery, stream/channel primitives, state folding, and
  `run.cancel` / `run.resume` protocol verbs. See
  `kernel/relayflowd-core/src/{journal.rs,machine.rs,retry.rs,state.rs}` and
  `kernel/relayflowd/src/{engine.rs,server.rs}`.
* The authoring surface has `run`, `llm`, `agent`, `human`, `done`, headers for
  budgets, identity, tools and workspace, and a TypeScript flow loader. See
  `packages/surface/src/{context.ts,flow.ts}`. `f.human` is presently a
  yes/no wait and `Ctx.dispatch` is typed but lacks a corresponding SDK
  implementation.
* Declarative step outputs can be gated with JSON Schema; SDK and kernel share
  bounded schema validation. See `packages/sdk/src/{json-schema.ts,
  json-schema-bound.ts,output-schema.ts,validate.ts}` and
  `kernel/relayflowd-core/src/schema.rs`. This is step output validation, not
  a public Flow Tool input/result contract.
* `flows check` validates spec/preflight conditions and has closed refusal and
  warning taxonomies. It checks CLI/model resolution, declared MCP servers,
  commands, triggers, budgets and declared scopes where possible. See
  `packages/sdk/src/{preflight.ts,failure-kinds.ts,cli/check.ts}`.
* `flows run`, `resume`, `answer`, `status`, `replay`, and local journal reads
  are real SDK/CLI surfaces. `answer` records the who and a yes/no response;
  `resume` is durable. See `packages/sdk/src/cli/{run.ts,answer.ts,status.ts,
  replay.ts}`.
* A direct/hosted authored flow requires JSON input, but current parsing only
  checks JSON syntax, size (1 MiB) and JSON compatibility; it does not validate
  an author-provided root input schema. See `packages/sdk/src/direct-input.ts`
  and `packages/sdk/src/cloud-run.ts`.
* Cloud supports source/spec submission, polling status, read-only run lists,
  status and logs, plus deployment/schedule paths. Its terminal reader rejects
  inconsistent completion records. See `packages/sdk/src/{cloud-run.ts,
  cloud-run-record.ts}` and `packages/sdk/src/cli/{cloud-read.ts,
  cloud-live.ts,cloud-status-view.ts}`.
* MCP is already a Flow *dependency*: declared stdio/HTTP servers are
  preflighted, their inventory is captured, and a call lowers to a journaled
  agent effect with an idempotency key. See `packages/sdk/src/{authored-mcp.ts,
  mcp-client.ts,mcp-config.ts}`. This is not an MCP server that exposes a Flow
  to another agent.
* Bundles can be locally built, content-addressed, signed and verified by
  `flows build`. See `packages/sdk/src/{cli/build.ts,bundle.ts}`. Cloud’s
  current run endpoint submits source/spec and documents that `specHash` is a
  local correlation hash, not proof of sealed-bundle execution
  (`docs/CLOUD.md`).
* Agent Relay already has action definitions with input/output validation and
  an MCP action bridge that can list/register dynamic actions. See sibling
  `../relay/packages/sdk/src/actions/{types.ts,registry.ts}` and
  `../relay/packages/cli/src/cli/mcp/action-tools.ts`. It is a useful adapter
  foundation, not a durable Flow Tool control plane.

### Gaps that must be closed before the promise is sellable

1. No catalog/registry maps a public tool name to a scoped, immutable Flow
   deployment and its input/result schemas.
2. No Flow-level runtime input or terminal result schema exists for authored
   `.flow.ts`; TypeScript input types cannot provide it.
3. Cloud has no Flow Tool invoke/status/event/cancel/resume/human-answer API;
   current `runInCloud` POST is intentionally non-idempotent at the SDK layer
   and observation interruption explicitly does not cancel the hosted run.
4. Cloud is not yet admitting a verified local sealed bundle digest; source
   submission and `specHash` are insufficient provenance for a callable tool.
5. There is no server-side invocation idempotency record, tool-level
   concurrency policy, tool-event stream, or stable external evidence model.
6. Agent permissions are validated declarations but are explicitly not enforced
   (`packages/surface/src/context.ts`, `packages/sdk/src/failure-kinds.ts`).
   That blocks any claim that a tool safely constrains an agent’s file/network
   effects, especially for prompt-injected or untrusted content.
7. Current budget reporting can be `dollars_unmetered` for models without a
   frozen price. Token ceilings still work, but a dollar ceiling is not a full
   spend guarantee in that state.
8. Existing evidence/status is strong for a run but lacks a policy-controlled,
   tenant-safe external evidence envelope and artifact retention/ACL contract.
9. `f.dispatch`, general typed human forms, public channels, and durable
   cross-run composition are not ready to support arbitrary nested tool calls.

## Target architecture

```text
Agent / MCP client / native function call
                 |
        Flow Tool adapters (identity + schema only)
                 |
      Flow Tool API / registry / admission ledger       [new control plane]
       |          |               |         |
  entitlement  digest verify   idempotency  event/evidence projection
       |          |               |         |
            Cloud cell orchestrator / deployment binding [extend]
                              |
                     relayflowd journal protocol         [existing boundary]
                 /             |             \
      deterministic         LLM/agent       human/MCP/relayfile effects
                              |
                    scoped credentials + declared surfaces [gate-8 dependency]
```

The kernel remains tenant-unaware, as RFC-0001 requires. The tool registry and
Cloud admission layer resolve tenant, principal, deployment, policy, secrets,
and capability scope *before* starting a tenant cell. `relayflowd` continues to
see a compiled spec and journal protocol, not a customer/tool identity.

### Required controls and their placement

| Concern | Design | Current relevant code | Gap / decision |
| --- | --- | --- | --- |
| Auth and tenant scoping | Registry resolves caller to tenant/workspace/deployment; mint per-run attenuated token; check action/effect grants before admission | Cloud token usage in `cloud-http.ts`; Flow headers in `surface/flow.ts` | New tool authorization and run-scoped credential issuance; kernel stays tenant-blind |
| Secrets | Registry references secret bindings by name; inject only into approved worker/effect boundary; never echo into schema/events/evidence | Cloud connection/preflight and redaction path `sdk/redact.ts` | Add secret-binding manifest, brokered injection, redaction/retention tests |
| Version pinning | Tool alias resolves once to signed `flow@sha256`; journal, event, result and evidence repeat digest | local `build.ts`/`bundle.ts`; `docs/CLOUD.md` says Cloud does not yet use it | Publish/verify bundle registry and bind Cloud admission to digest |
| Idempotency | Admission ledger does atomic `(scope,key)` claim with input digest; return original run on replay; effects retain kernel keys | kernel memoization/effect protocol; `authored-mcp.ts` | New cross-request admission idempotency; do not rely only on step keys |
| Concurrency | Per-tool and per-key limits, queue/decline policy, capacity reservation; include limits in tool manifest | kernel worker slots/leases | New control-plane scheduler policy; never use best-effort client locks |
| Budgets | Tool declares non-escalatable token/dollar/wallclock ceilings; reserve descendant budget; terminal `budget_exceeded` | `surface/flow.ts`, `sdk/authored-budget.ts`, kernel budget tests | Block/label unmetered-dollar deployments or use a conservative policy |
| Audit and evidence | Immutable journal digest + invocation/authorization/effect decision records; scoped redacted artifact URLs; retention policy | journal, `cli/status.ts`, Cloud logs/status rendering | New evidence projection, ACL and retention contract |
| Prompt injection | Schema separates untrusted data; catalog metadata is signed/operator-owned; agents receive explicit data boundaries; verifier/gates decide effects | Babysitter explicitly treats PR input as untrusted in `examples/babysitter/babysitter.flow.ts` | Enforced surfaces/credentials, taint-aware templates or review rules, adversarial E2E |
| Recursion | Static child digests, depth/cycle/concurrency/budget limits, attenuation; prohibit raw outward tool calls in steps | `Ctx.dispatch` type only | Implement deliberately after MVP, not a loophole |
| Failures | Canonical status/reason taxonomy, retry policy per failure class, event replay, human wait expiry, cancel semantics | `failure-kinds.ts`, `protocol.ts`, `run-state.ts`, kernel retry/cancel | Map host API failures precisely; no “completed” without a valid terminal verdict |

## MVP and phased delivery

### Phase 0 — contract and design-partner proof (1–2 weeks)

* Agree `FlowToolManifestV1`, JSON Schema dialect/subset, terminal envelope,
  idempotency semantics, evidence redaction/retention, and authorization
  vocabulary.
* Select one read-only or tightly constrained flow: Babysitter in `review`
  mode, with no merge, push, comment, or repair effect.
* Build a contract test fixture usable by SDK, Cloud, Agent Relay action
  adapter, and MCP adapter. Do not expose generic Flow Tools yet.

### Phase 1 — callable immutable read-only tools (3–5 weeks)

* Add explicit flow-level `input` and `tool.result` JSON Schemas to
  `@relayflows/surface`, compile/snapshot them into a Flow Tool manifest, and
  validate root input before a run is admitted.
* Extend `flows build`/publication to create a signed registry entry; add
  Cloud endpoint(s) that accept only a verified digest and deployment ID.
* Implement registry discovery, scoped invocation, atomic idempotency ledger,
  run status and journal-to-SSE event projection, and terminal evidence
  envelope.
* Implement an Agent Relay action adapter and an MCP generic adapter. Keep
  native function definitions generated server-side.
* Support synchronous observation only as a bounded convenience over the same
  async run lifecycle.

**Exit:** a design partner’s agent invokes `github_pr_babysit` against a
synthetic/review-only PR; rerunning the same idempotency key returns the same
run; the agent receives a terminal hold/pass verdict and a human can inspect
the pinned digest and evidence.

### Phase 2 — human gates and controlled write effects (4–7 weeks, dependent)

* Add typed, schema-validated human input and routed delivery with actor audit.
* Implement hosted cancel/resume and event replay, plus per-tool concurrency
  and budget policies.
* Land/enforce gate-8 scope controls for workspaces, relayfile paths, network,
  and credentials. Only then enable small, externally visible effects such as
  a fenced GitHub comment upsert.
* Add effect-specific evidence: provider receipt, idempotency key, expected
  revision/head, and stale-write fencing.

**Exit:** a write-capable tool survives process interruption and retry with
exactly one provider effect, a scoped evidence receipt, and no escape from its
declared surface.

### Phase 3 — composition and catalog scale (4–6 weeks)

* Implement durable `f.dispatch`/child tool policy with static digest graph,
  depth/cycle/budget/concurrency limits and capability attenuation.
* Add dynamic MCP tools for small catalogs, catalog search/ranking for large
  ones, policy/approval templates, and version rollout/rollback controls.
* Add organization analytics that aggregate declared outcomes without exposing
  tenant prompts or sensitive evidence.

### Acceptance tests and live proof

The unit suite is necessary but not sufficient. The release gate should include:

1. Invalid/missing/oversized input is rejected before any run, worker,
   credential access, or provider effect.
2. Tool discovery cannot reveal another tenant’s tool, a disabled revision, or
   a tool outside the caller’s grants.
3. Identical concurrent invocations with the same idempotency key and input
   create one run; a reused key with different input is a conflict.
4. The journal/result/event stream reports the exact digest and has monotonic,
   replayable sequence IDs; reconnect does not duplicate or omit an event.
5. Kill/restart at admission, step boundary, in-flight agent work, human wait,
   and effect confirmation. Completed steps are not re-executed and a declared
   external effect is observed once.
6. A deterministic gate failure, model/agent failure, budget exhaustion,
   human rejection/timeout, and cancellation all return distinct documented
   terminal reasons and do not become `success`.
7. The event/evidence projection contains no secret fixture, raw credential,
   or unredacted protected transcript; an unauthorized artifact URL fails.
8. A prompt-injected PR/ticket/email cannot change a tool’s digest, effect
   permissions, budget, or declared policy; a write attempt outside scope is
   denied by enforcement, not merely by prompt text.
9. Adapter parity: native function call, Agent Relay action, and MCP call of
   the same request produce the same canonical receipt/result semantics.
10. A live Cloud E2E records: build digest/signature verification, invoke
    request hash and idempotency key, scope decision, run ID, journal/event
    trace, gate evidence, terminal result, and a redacted observer link.

The first live proof should use a dedicated test repository and non-production
credentials. It should demonstrate a read-only PR review and an intentionally
red gate, then a positive run. Do not use a customer production PR as the
first crash/idempotency test.

### Rollout and compatibility

* Existing `flows run`, deployments, schedules, direct authored input, and
  existing MCP-as-a-dependency behavior remain unchanged. Flow Tools are opt-in
  via a new manifest header and published deployment.
* Version the manifest and result envelope independently from the journal and
  spec; read N-1 manifest versions during rollout. Alias changes affect new
  invocations only; an accepted run remains pinned to its digest.
* Start with allowlisted tenants and read-only tools. Make write effects an
  explicit migration that needs a human-approved deployment policy.
* Keep generic `invoke_flow_tool` available while native/dynamic tool names
  are being rolled out; deprecate neither until telemetry shows parity.
* Roll back by disabling an alias or moving it to a prior verified digest;
  never mutate the bytes behind an already published digest.

### Rough effort, dependencies, and risks

Phase 1 is approximately 3–5 engineering weeks across a Flow SDK/kernel owner,
Cloud/control-plane owner, and Agent Relay/MCP owner, plus security review and
design-partner test time. Phase 2 is 4–7 additional weeks and should not be
committed as a date until enforced scope controls and Cloud cancel/answer
capabilities are scheduled. Phase 3 is 4–6 weeks after Phase 2 proves effect
and policy inheritance.

The critical path is Cloud bundle admission + registry/idempotency/event
projection, not the adapter code. The largest risks are presenting an agent
gate as a business guarantee, secret/evidence leakage, source-versus-digest
provenance drift, current unenforced agent permissions, and hidden duplicate
effects across host/API retries. The mitigation is deliberately narrow MVP
scope: read-only, digest-pinned, one design partner, one evidence-driven use
case.

## Three concrete Flow Tool examples

### 1. PR babysitter / review-fix loop

**Tool:** `github_pr_babysit({repository, pull_request, mode, head_sha?})`

1. Validate coordinates and mode; bind caller to an allowed repository.
2. Re-read GitHub live state and bind the decision to the current head, rather
   than trusting webhook or model-provided facts.
3. Run independent read-only review lenses in isolated workspaces; reconcile
   nonempty structured artifacts.
4. Run deterministic tests and recheck the exact head.
5. If the result is a mechanical, policy-approved fix, dispatch a constrained
   repair step; rerun only the declared review/test loop up to its bounded
   iteration count. Semantic edits, stale head, fork PRs, missing evidence, or
   merge remain human gates.
6. Return `pass`, `hold`, `needs_human`, or `declined` with findings and pinned
   evidence. No model sentence can return “ready” by itself.

This maps directly to the existing `examples/babysitter/babysitter.flow.ts`:
it re-reads live state, binds to head, runs independent lenses, validates
artifacts, and intentionally returns `needs_human` where capability guarantees
are absent. Its README is unusually candid: current write/recovery, scope,
cross-run liveness, and full live merge proof remain blockers. The pilot must
keep those blockers as part of the demo narrative, not hide them.

### 2. Software delivery

**Tool:** `deliver_ticket({repository, ticket, target_branch, change_class})`

1. Validate a normalized ticket schema and policy (repository, allowed branch,
   ticket origin, spend cap); create a pinned worktree.
2. Implementation agent writes code and a required structured change summary.
3. Deterministic build/test/security checks run outside the implementer.
4. Independent adversarial review agent produces a pass/block artifact; test
   again after mechanical fixes.
5. A deterministic PR metadata/branch gate creates a draft PR on a block and
   a reviewable PR on pass. Merge is a separately declared human gate.
6. Return PR URL, commit/head, test evidence, review verdict, costs, and the
   exact source digest.

The current `examples/software-factory/software-factory.flow.ts` already models
much of this: implementer, deterministic tests, adversarial reviewer, artifact
gates, PR metadata validation, draft-on-block behavior, and human-controlled
merge. The Flow Tool work supplies the external schema, durable invocation
semantics, deployment scope, and evidence envelope; it should not rewrite the
use-case flow to a single prompt.

### 3. Non-code business workflow: evidence-backed campaign approval

**Tool:** `prepare_campaign_asset({brand, topic, audience, approver})`

1. Validate campaign brief, brand policy revision, allowed channels, and an
   explicit publication mode (`prepare_only` for MVP).
2. Research agent writes a cited source artifact; copywriter writes a draft;
   independent fact-check agent writes a pass/reject artifact against the
   source file.
3. A deterministic policy gate checks required disclosures, prohibited claims,
   content length, and that every required artifact exists.
4. The flow parks at a human approval form. On approval, a later write-enabled
   revision can post through a scoped provider effect; in MVP it returns the
   approved package without publishing.
5. Result includes draft/creative artifacts, claim citations, fact-check
   verdict, approver identity, and terminal action.

`examples/social-post-pipeline/social-post-pipeline.flow.ts` already shows the
useful pattern: separate researcher/writer/fact-checker/designer steps, file
artifact gates, and a human publish decision. It is a strong demonstration that
this product is not only a coding-agent wrapper, while making clear that
“fact-check passed” is evidence of the declared process—not a guarantee every
claim is true or that the campaign will succeed.

## Meeting-ready one-page narrative

**Problem.** Skills are useful guidance but they are interpreted afresh by a
probabilistic agent. The hard parts of a real operation—what input was accepted,
which checks passed, whether an effect happened once, why it stopped, and who
approved it—live outside the skill. That makes a successful-looking chat an
unsafe control surface for repeatable work.

**Wedge.** Start where customers already babysit: PR review/fix loops. Expose a
single `github_pr_babysit` tool. The lead agent supplies a PR number; the flow
does the repeatable work, binds it to the live head, runs tests and independent
reviews, and returns either evidence-backed `pass`, `hold`, or `needs_human`.

**Demo.** Show the agent discovering the tool and submitting valid JSON. Show
the immediate durable run receipt, a live stream with gate progress, an
intentional failing test/review gate, then a successful read-only review. End
on the result card: exact flow digest, head SHA, gate verdicts, spend, evidence
links, and a human gate instead of an invented merge. Re-submit the same
idempotency key and show that it returns the original run—not a duplicate.

**Differentiation / moat.** The tool contract is backed by a journaled state
machine and immutable flow revision, not a prompt template. It carries evidence
and effect identity across retries and restarts. Customers can use their chosen
agent/harness and call it via native functions, MCP, or Agent Relay without
forking execution semantics. As deployments accumulate, the catalog contains
organization-specific operational contracts, gates, evidence, and eval data—not
just generic instructions.

**Likely objections.** “Can you guarantee the result?” No: we guarantee the
declared process properties and make quality claims inspectable; uncertain
judgment needs verifiers or people. “Why not a function wrapper?” A wrapper
does not provide durable waits, effect idempotency, provenance, gates, or
evidence. “Can it write to production?” Only after enforced least-privilege
scopes, effect fencing, and explicit approval; the pilot is read-only. “Will
this lock us into one model?” No: the canonical interface sits above model
adapters and the flow declares its verified harness/model policy.

**Recommended pilot.** A four-week, one-repository pilot with a limited
catalog: `github_pr_babysit` in read-only mode and `deliver_ticket` that opens
draft PRs only. Success is not “the agent merged code.” Success is that a team
can invoke the tools from its existing agent, inspect every terminal verdict,
replay the evidence, observe zero duplicate invocations/effects under retries,
and measure fewer manual follow-ups. Make write/merge authority a post-pilot
decision based on those artifacts.

## Open product decisions and recommendations

| Decision | Recommendation | Why |
| --- | --- | --- |
| Is a Flow Tool a new step type? | No. It is a control-plane admission and adapter around an existing flow run. | Preserves the closed kernel vocabulary and journal boundary. |
| Which JSON Schema dialect? | 2020-12 canonical; generate constrained provider/MCP views. | Existing SDK/kernel already support modern JSON Schema; do not let each adapter redefine validation. |
| How are tool input/output schemas authored? | Explicit runtime schemas in the flow header/manifest; do not infer TS generics. | Makes admission, discovery, audit, and compatibility real. |
| Sync or async default? | Async receipt by default; bounded sync is a convenience. | Agent/human work cannot safely fit a function-call timeout. |
| Who may publish a tool? | A deployment owner with a signed bundle and reviewed manifest; no auto-exposure from a repository. | A public tool is an authority boundary, not metadata. |
| Can tool callers choose versions? | Caller chooses only catalog-visible pinned revisions; aliases resolve at admission and are journaled. | Enables deliberate rollout/rollback without mutable execution. |
| What counts as success? | Platform terminal reason plus a flow-specific business verdict and gate list. | Separates completed execution from a business claim. |
| How should human input work? | Typed schema-backed forms, starting with a compatibility yes/no implementation. | Avoids forever baking UI prose into a bool wait. |
| When can write tools launch? | After enforced scopes, provider effect fencing, evidence ACLs, and crash/idempotency E2E pass. | Current permissions are declarations, not a security boundary. |
| Can flows call flows? | Static, attenuated, depth-limited composition in Phase 3 only. | Prevents recursive budget/authority escape and unclear provenance. |
| What evidence is visible to the agent? | Redacted summaries and scoped references by default; privileged viewers can retrieve more. | Evidence must help decisions without becoming a secret exfiltration channel. |
| How broad is the first catalog? | Two coded workflows plus one prepare-only business workflow for one allowlisted customer. | A narrow catalog makes policy, support, and proof tractable. |

## Recommendation

Commit to **Flow Tool API v1 as a digest-pinned, async, read-only-first
control plane**, and pilot it with the existing Babysitter flow. Do not market
it as “skills replaced with guaranteed outcomes.” Market it as “skills made
executable: validated inputs, declared gates, durable runs, and evidence-backed
verdicts.” The first commercial proof should be a trustworthy `hold` as well
as a `pass`; the ability to stop safely is the product.
