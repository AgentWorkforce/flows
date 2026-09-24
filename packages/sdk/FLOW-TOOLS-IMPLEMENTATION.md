# RFC-0002 implementation and Cloud handoff

Baseline: main `e07a190651159a4bd3bfe329a2425aeb7cf949f6`; PR #568.
The RFC is the target, not a claim that its hosted acceptance gates have passed.

## Spec-to-code gap matrix and dependency order

| RFC requirement | Existing foundation | This Flows slice | Remaining owner/dependency |
| --- | --- | --- | --- |
| Explicit immutable schemas | FlowToolManifestV1, bounded snapshots, canonical digest | Keep backwards-compatible manifest APIs; validate catalog and lifecycle envelopes | Surface authoring headers and signed bundle publication binding |
| Scoped discovery | No hosted tool registry | Validated canonical catalog; native/MCP/action views of the same selected revisions | Cloud must filter tenant/workspace/deployment/grants before response |
| Digest-pinned invoke | Local bundle verification; source-based Cloud run is not admission | Mandatory manifest/deployment/flow binding; embedded runtime verifies the exact sealed digest and admits only its closed no-effect template | Cloud verifies signer trust, embedded manifest and general deployed programs |
| Durable idempotency | Kernel admission keys atomically bind a spec | Caller key is scoped by principal/deployment/digest and delegated to kernel admission; different canonical input conflicts | Cloud atomic tenant ledger and durable cross-process launch reconciliation |
| Async lifecycle | Journal protocol run/status/cancel/resume | Stable receipt plus real kernel run/status/event/evidence projection for the conformance program | Cloud journal projection and durable command/human execution |
| Terminal verdict/evidence | Run completion reason, journal, spend | Separate platform reason/business enum/result schema; closed redacted evidence references | Trusted result producer, evidence ACL/retention/redaction and journal-digest calculation |
| Scope/budget enforcement | Declarations are not enforcement | No caller-selected identity, deployment authority or budget in model arguments; read-only catalog v1 only | Cloud gate-8 credentials/effects enforcement; deny write-enabled tools |
| Adapter parity | Descriptor-only functions | Native, MCP and Relay-compatible action handlers call the same client | Actual authenticated server/session/action registration and provider-specific schemas |
| Restart/crash proof | Kernel crash suite | Live relayflowd admission, execution, journal replay and principal-bound reconstruction tests | Hosted process/worker/effect crash tests; live pilot proof |

Dependency order: (1) strict shared wire contract and schema/binding validators;
(2) explicit authenticated transport and canonical client; (3) adapters with
host-owned idempotency metadata; (4) negative/parity/replay conformance tests;
(5) Cloud admission and projection implementation; (6) non-production read-only
pilot plus RFC acceptance gates. PR remains draft until its declared acceptance
is satisfied. The narrow embedded runtime and fixture tests do not complete the
hosted RFC.

## Embedded kernel conformance runtime

`createKernelFlowToolControlPlane` is an actual `FlowToolTransport` over a
connected `JournalClient`, not a manifest adapter or in-memory run ledger. It
verifies the pinned sealed bundle, requires a successful bundled preflight,
reauthorizes discovery/invoke/read operations from server-bound grants, and
uses relayflowd's atomic admission key for durable deduplication. Status,
events, spend, terminal result, and evidence digest are projected from the
journal. Principal identity is hashed into the journaled run binding, allowing
a reconstructed transport to reauthorize old runs without a process-local map.

The accepted executable contract is deliberately tiny and fail-closed: one
effect-free deterministic step, direct `/usr/bin/printf` or `/bin/printf` argv,
an exact JSON-input placeholder, no shell interpolation, no plugins, agents,
LLMs, triggers, human waits, or effect claims. The runtime substitutes only the
canonical schema-validated JSON argv element and validates stdout against the
manifest result schema. This is a real admission/execution/result path useful
for control-plane conformance; it is not the Babysitter pilot or general Flow
execution. Cancel/resume/human commands are unsupported for this synchronous
one-step program, and the hosted Cloud control plane remains unimplemented.

## Cloud implementation contract (not implemented by this SDK)

Implement the versioned `/api/v1/flow-tools` and `/api/v1/flow-runs` API consumed by
`FlowToolClient`, using the exact exported schemas/types. No existing source-run
endpoint may be substituted. A missing route is an unsupported deployment,
not permission to weaken provenance.

Shared wire fixture: `tests/fixtures/flow-tool-api-v1.json` (explicitly
`fixture_only:true`). Both repositories should validate these exact catalog,
request, receipt, terminal, evidence and event bytes/hashes. Routes use Next.js
path segments: `/api/v1/flow-tools/{name}/invoke`, run `/cancel`, `/resume`, and
`/human/{waitId}/answer`; this is an intentional routable spelling of the RFC's
conceptual colon commands. Every POST carries `Idempotency-Key`; every JSON
envelope carries `api_version:1`. SSE uses sequence as `id`, type as `event`,
JSON as `data`, and `Last-Event-ID` as an exclusive resume cursor. Non-2xx errors
are `{api_version:1,code}`; no server error prose is reflected to a model.

Supported HTTP mappings: 400/422 invalid_contract, 401/403 not_authorized,
404 not_found, 409 idempotency_conflict, 501 unsupported, other non-2xx
unavailable. Transport failure is separately ambiguous. Run `state:cancelled`
maps to terminal reason `canceled`, matching the existing SDK/kernel reason.

The general bundle executor does not admit authored/agent/LLM bundles. The
build probe rejects nonempty authored headers and the local digest runner only
supports declarative deterministic specs without assets/requirements/triggers.
The SDK's embedded conformance runtime implements one such exact, no-effect
allowlist while actually passing validated JSON through relayflowd and reading
the result from its journal. That is not the RFC Babysitter pilot. General authored artifacts,
surface headers, signed publication and journaled business-output binding remain
real implementation dependencies, not capabilities provided by this client.

1. Authenticate each request and resolve tenant, workspace, principal and
   deployment server-side. Filter disabled/unauthorized revisions before
   discovery; reauthorize invocation and every status/events/evidence/command
   request. Never trust a principal/tenant supplied in model input. Model
   arguments are exclusively the manifest's input schema. Bind the bearer to
   this API audience; use dedicated scoped credentials, not Relay workspace keys.
2. Verify the sealed bundle digest/signature against trusted publication keys,
   the embedded manifest digest, allowed deployment revision and read-only
   policy. Validate input before worker launch or credential retrieval. Reject
   unmetered deployments if policy requires a dollar ceiling. Include the
   effective non-escalatable budget/effects in the catalog policy.
3. In one transaction claim `(tenant, deployment, flow_digest, principal,
   idempotency_key)`, storing canonical input digest, manifest identity, run ID
   and a durable launch intent. Same input returns the original run; different
   input returns 409 `idempotency_conflict`. Reconcile the outbox after crash;
   never acknowledge acceptance before durable commit, never launch before
   durable intent, and deduplicate run creation when launch acknowledgment is
   lost. Client-side maps/locks are not a substitute.
4. Drive existing tenant cell journal protocol, not a second workflow engine.
   Persist mapping from admission ID to kernel run. Status, journal sequence
   events and terminal envelopes must repeat pinned identity. SSE resumes
   strictly after Last-Event-ID; gaps in the public stream may reflect redacted
   journal entries, but duplicate/out-of-order visible IDs are invalid.
5. Project only allowlisted public event fields. Produce the flow-defined
   result/verdict from a trusted completion binding, not a model sentence or
   successful HTTP response. Validate the result schema, distinct failure
   reasons, gate evidence references and spend. A failed/cancelled run cannot
   carry a fabricated successful business verdict. Evidence refs are opaque,
   redacted, tenant-scoped and retention-controlled; retrieval rechecks ACLs.
6. Journal cancel requests durably; resume only existing runnable runs and
   never restart terminal runs. Human answers are yes/no in v1, authorized by
   the authenticated human principal, with durable answer-idempotency and
   audit. Do not trust `answered_by` from a model. Replay of a command key
   cannot apply another action or changed answer.
7. Bound synchronous observation to 25 seconds and return the existing
   receipt if unfinished. An observer disconnect/request timeout does not
   cancel the run. SDK transport errors explicitly leave admission unknown.

## Evidence needed before readiness

The contract test backend is a fixture: persistence/reconstruction proves the
client does not own run state, not that Cloud has an atomic ledger. No production
Cloud route is contacted by tests. Linux full SDK/kernel CI protects regressions
but does not prove live-model, provider-effect or Cloud admission behavior.

Required external proof: dedicated non-production repository/credentials;
signed build and manifest admission; unauthorized discovery/read/write denial;
concurrent and interrupted admission retries; restart during work/human wait;
monotonic reconnect events; one declared external effect; redaction/ACL checks;
negative and positive Babysitter terminal verdicts; adapter parity; redacted
observer link and exact journal/artifact digests. No merge-ready or hosted
guarantee claim is made until that evidence and independent review exist.
