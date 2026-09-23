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

There is deliberately **no MCP server or invocation handler** in this slice.
The authored runtime currently returns a completion reason and journal-step
references, not this flow-defined result object or a verified bundle-admission
receipt. A callable adapter must first bind verified execution to the manifest,
validate input before effects and validate the real result after execution.
This module does not implement hosted auth/admission, permission enforcement,
async events, cancellation, resume, idempotency, or business-result guarantees.
