# Flow Tool manifests (local contract slice)

`FlowToolManifestV1` is an explicit, opt-in SDK contract. It does **not** infer
runtime schemas from TypeScript generics or change existing flow headers/runs.

```ts
import {
  createFlowToolManifest, validateFlowToolInput, validateFlowToolResult,
  flowToolFunctionDefinition, flowToolMcpDefinition,
} from '@relayflows/sdk';

const manifest = createFlowToolManifest({
  name: 'review_pull_request',
  description: 'Review a pinned PR. A hold verdict is not approval to merge.',
  flow: {
    name: 'pr-review', version: '1.0.0',
    // Replace this example value with the separately verified bundle digest.
    digest: `sha256:${'a'.repeat(64)}`,
  },
  inputSchema: {
    type: 'object', properties: { pr: { type: 'integer', minimum: 1 } },
    required: ['pr'], additionalProperties: false,
  },
  resultSchema: {
    type: 'object', properties: { verdict: { enum: ['hold', 'pass'] } },
    required: ['verdict'], additionalProperties: false,
  },
});

const input = validateFlowToolInput(manifest, { pr: 42 });
const result = validateFlowToolResult(manifest, { verdict: 'hold' });
const nativeDefinition = flowToolFunctionDefinition(manifest);
const mcpDefinition = flowToolMcpDefinition(manifest);
```

These calls validate/describe data; **none executes a flow**. Input/result
validation returns a frozen snapshot without coercing types, filling defaults,
removing extra fields, or mutating the caller's data. A structurally valid
`hold` result is not a successful business decision.

## Identity and schema contract

The flow name, semantic version and `sha256:<64 lowercase hex>` bundle digest
are immutable declarations. The separate manifest `digest` hashes the UTF-8
canonical JSON of every manifest field except `digest`: recursively sorted
object keys, array order preserved, JSON number/string encoding, no whitespace
or trailing newline. This uses the SDK's existing canonical serializer; it
is not a new cross-language JCS claim. `canonicalFlowToolManifest` returns the
canonical complete envelope. `parseFlowToolManifest(json, trustedDigest)` checks
the version, full schema contract and digest, optionally pinning it to a
caller-trusted catalog value. Reordering keys preserves identity; changing a
schema, description, version or flow digest changes it.

A digest is **not a signature, provenance proof or authorization**. This module
does not verify that the referenced bundle exists, contains this manifest or
was admitted/executed by Cloud. An attacker can rehash changed metadata; callers
must establish their trusted catalog/digest separately.

V1 is a closed JSON Schema 2020-12 profile. Both roots must explicitly declare
`type: 'object'`. Supported keywords are `$schema`, `$defs`, document-local
JSON-Pointer `$ref`, `title`, `description`, `type`, `enum`, `const`, `properties`,
`required`, `additionalProperties`, `items`, `minItems`, `maxItems`, `uniqueItems`,
`minLength`, `maxLength`, `minimum`, `maximum`, `exclusiveMinimum`,
`exclusiveMaximum`, `multipleOf`, `minProperties`, `maxProperties`, `anyOf`,
`oneOf`, `allOf`, and `not`. References must resolve locally and must not form
non-consuming cycles. Invalid schemas are refused at construction/parse time.

Unsupported keywords are rejected, never dropped: notably remote references,
`format`, `pattern`, `patternProperties`, `default`, custom keywords and other
drafts. This intentionally narrower first profile avoids silent validation or
provider-translation differences. JSON snapshots are limited to depth 64,
4,096 nodes/properties and 256 KiB encoded bytes, for the complete manifest
and independently for each input/result. Non-finite numbers, cycles, proxies,
accessors, functions, sparse arrays and non-plain objects are refused using
the SDK's existing behavior-free JSON snapshot boundary.

## Adapter boundaries

The native descriptor has `{type:'function', name, description, parameters}`.
The MCP descriptor has `{name, description, inputSchema, outputSchema}` and
passes the installed MCP SDK's Tool schema. Both preserve schema content. The
native shape is a neutral function-call descriptor: individual providers may
require a wrapper or a stricter schema subset; no provider-specific strict mode
is enabled, and no constraint is silently rewritten. Neither definition carries
credentials or asserts read-only, destructive, idempotent or business-success
annotations. Keep its manifest identity in the adapter's trusted binding.

The descriptor-only functions above deliberately have no invocation handler.
The authored runtime currently returns a completion reason and journal-step
references, not this flow-defined result object or a verified bundle-admission
receipt. A callable adapter must first bind verified execution to the manifest,
validate input before effects and validate the real result after execution.
The new control-plane client below supplies transport and validation, not the
hosted admission ledger, permission enforcement or execution implementation.

## Acceptance for this SDK slice

The contract is independently usable for authoring, catalog serialization and
adapter metadata. Its acceptance path is: import the built public SDK, create
an explicit manifest, serialize/reload it against a trusted digest, validate
input/result fixtures and emit schema-equivalent native/MCP descriptors.
`tests/flow-tool-public-api.test.ts` exercises that path in a separate Node
process; `tests/flow-tool-manifest.test.ts` covers malformed schemas, tampering,
resource limits and behavior-free snapshots. These are local contract tests,
not a hosted end-to-end run or evidence of business-result correctness.

The unchanged package and Linux kernel/SDK CI gates protect existing consumers.
Passing them does not satisfy the RFC's live workload gates. Execution/admission
and a real callable-flow journey remain separate implementation and acceptance
work: they are prerequisites for shipping an enabled callable product, not
capabilities that this SDK's transport implementation claims to provide.

## Canonical control-plane client and call adapters

`FlowToolClient` speaks one versioned, digest-pinned contract. It has no default
production endpoint and never falls back to `runInCloud` source submission.
The deployment must implement the explicit contract in
[FLOW-TOOLS-IMPLEMENTATION.md](./FLOW-TOOLS-IMPLEMENTATION.md). An unsupported
executor must refuse before admission; a metadata match is not provenance.

```ts
import { FlowToolClient, createFlowToolHttpTransport, createFlowToolAdapters } from '@relayflows/sdk';

async function review(apiUrl: string, scopedToken: string, operationKey: string) {
  const client = new FlowToolClient(createFlowToolHttpTransport({ apiUrl, token: scopedToken }));
  const catalog = await client.discover(); // server filters scope before returning metadata
  const selected = catalog.tools.find(tool => tool.manifest.name === 'review_pr');
  if (!selected) throw new Error('No authorized revision');
  const adapters = createFlowToolAdapters(client, selected);
  // The host persists this key for the logical operation; it is not a model argument.
  const receipt = await adapters.native.call({ pr: 42 }, { idempotencyKey: operationKey });
  if (receipt.terminal === null) return receipt; // accepted is not completed
  return receipt.terminal; // inspect business_verdict even when terminal_reason is success
}
```

Native `call`, MCP `call` and action `invoke` pass the same input and host-owned
operation metadata to that client. MCP returns the canonical run in
`structuredContent` and a JSON text fallback; its output schema is the **run
envelope**, not the eventual business-result schema. Existing metadata APIs
remain unchanged. A host registers these handlers with its authenticated
native/MCP/Relay session; this package does not start a public server or register
Relay actions automatically. Provider-specific schema translation remains the
host's responsibility. Never mistake a Relay dispatch acknowledgment for the
canonical handler result.

`status`, `events`, `evidence`, `cancel`, `resume` and yes/no `answer` all require
the selected immutable entry and an accepted receipt. Persist that binding and
the last validated event sequence to reconnect after a client restart; the
server reauthorizes every operation, including reads. Do not re-resolve an
alias to a newer revision for an old run. Events reject backwards/duplicate IDs
and identity changes. Run envelopes reject incomplete terminal claims, invalid
result schemas, unknown verdicts and mutation of a previously terminal result.
The server still owns trusted result production, redaction and evidence ACLs.

Async is the default. Sync supplies a server observation bound of at most
25 seconds and may still return an unfinished receipt. Transport failure means
the outcome may be unknown: retry only with the same logical operation key.
No implicit retry, background polling or cancellation is performed. All POST
commands need stable idempotency keys; human identity is derived from server
authentication, never an `answered_by` model argument. Observation aborts and
SSE reconnects do not cancel the run.

Protocol v1 intentionally accepts only read-only catalog entries and `*:read`
effect labels. Labels are not effect enforcement; enabling a deployment still
requires the server's real scope controls. Hosted crash/effect proof, generic
MCP server registration, signed publication/authoring integration and the live
read-only pilot remain acceptance work. See the gap matrix, not test-fixture
success, for the current release blockers.
