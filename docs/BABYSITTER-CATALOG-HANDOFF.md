# Babysitter catalog artifact handoff

Babysitter is an optional extension on Software Factory/Garden, never a second
Recommended Flow. Activation accepts only top-level `babysitter: { enabled:
boolean }`; Cloud reserves the extension name and obtains its bytes from the
server-owned catalog. Client extension bytes cannot enable Babysitter.

## Current readiness

No native Babysitter artifact is released by this change. PR #549 merged the
authenticated dispatch boundary but intentionally refuses matched extension
handlers with `plugin_unsupported`. The existing `examples/babysitter` declares
Claude, GitHub comment writes, and a merge-gate hook; it is not the native
existing-session package. Keep enabled activation at 409 with zero writes.

The native handler must consume host-verified delivery authority, normalize the
repository/PR event, and call the Cloud lineage path. Cloud must recheck the
exact live `babysit` label and the bound session/head. Permission declarations
are not enforcement. Export success is byte verification, not execution approval.

The native package source is `extensions/babysitter` (see its README for the
turn contract). Flows 2.0.26 is published, but the package cannot execute
through the generic executor: #549 still refuses it. The SDK now has a separate Linux-only
capability sandbox that injects exactly
`capabilities.cloud.babysitterTurn.queue` without exposing the base context,
workspace, environment credentials, network, helpers, MCP, or harnesses. It is
not wired to hosted dispatch and must not be treated as enablement. The package's
`compat` requires the published 2.0.26 Surface/SDK release that routes
`labeled`, `unlabeled`, and `ready_for_review`. Export it only from the reviewed
commit pinned below.

The sandbox contract is deliberately narrower than #442. It re-verifies the
complete lock-backed installation and every manifest, binds it to the actual
base returned by `loadHostedExtensionBase` (which internally calls
`loadAuthoredFlow(..., { extensions: 'none' })`), detects
cross-extension route ambiguity, accepts only the exact published Babysitter
ref/digest/manifest and native permission profile,
permission profile, imports the entry only inside Linux bubblewrap plus Node's
permission model, mounts a minimal trusted Surface facade (`flow`, `github`,
and `getFlowDefinition`) instead of the general helper runtime, checks
normalized input against non-serializable verified dispatch authority, and
permits one queue call. The parent capability adapter
receives that original authority plus immutable extension provenance; the
capability request never carries workspace, activation, listener, session,
lineage, label, head, prompt, merge, route, or config authority. Cloud PR #3942 owns the
lineage/authority core and must inject workspace, activation, and listener from
persisted dispatch context, re-read live PR/label/head state, and return only
`{ receiptId, status: 'queued' | 'duplicate' }`. Refusal or in-doubt transport
rejects once with no fallback.

Before replacing #549's refusal, the hosted caller must use
obtain opaque base and installation authorities with
`loadHostedExtensionBase` and `loadHostedExtensionArtifacts`, then call
`runHostedCapabilityExtension` with both values;
using the ordinary compose loader would import extension top-level JavaScript
in the host before the sandbox exists. Independent review must prove this path
at the exact release head. Broader per-agent-step file/network/access-preset
enforcement remains open in #442 and is not claimed by this slice.

## Export reviewed bytes

After the native package is reviewed and committed, build the SDK and run:

```sh
npm run build --prefix packages/surface
npm install ./packages/surface --prefix packages/sdk --no-save --ignore-scripts
npm run build --prefix packages/sdk
node packages/sdk/scripts/export-babysitter-catalog.mjs \
  'github:AgentWorkforce/flows@<40sha>#<path>' \
  '<reviewed bundle sha256>' '<reviewed flows-plugin.json sha256>' \
  /tmp/babysitter-extension.json
```

The two digests come from the independently reviewed package, not from a client
request. The exporter reuses SDK GitHub fetch, manifest validation, file limits,
source checks, and canonical payload hashing. It rejects mutable refs, digest
drift, other repositories, non-Garden compatibility, extra permissions, and
hooks. It neither imports the handler nor overwrites an existing output file.

The output is the existing `FlowExtensionSubmission` shape: `name`, `version`,
`ref`, `digest`, `manifestSha256`, the unmodified JSON manifest, and files with
`path`, `sha256`, `bytes`, `encoding`, `content`. The exact permission declaration
is GitHub, Codex, no MCP, and only `cloud:babysitter-turn` writes.

The immutable source pin is `ref`. Optional manifest source metadata must match
that ref, including `source.sha` if supplied. Do not insert the enclosing commit
SHA into a committed manifest: that would require a Git hash fixed point. Do not
rewrite a manifest after computing its digests. A stronger generated-artifact
source convention must be agreed with the consumer before publication.

## Catalog and Cloud handoff

The catalog owner adds the reviewed output as the sole `babysitter` entry in
Software Factory's `extensions` in
`agentrelay.com/web/data/recommended-flow-catalog.v1.json`. Its exports are
`web/lib/recommended-flow-catalog.ts`, `/api/v1/flows/catalog`, and
`/api/v1/flows/catalog/software-factory`. These are the target paths; this PR
does not insert a placeholder bundle or claim those endpoints already expose it.

The list/detail provenance must cover extension ref and digest along with the
base flow. Cloud checks the same pins and passes the complete entry through
`packages/web/lib/flows/flow-extension-submission.ts`'s
`parseFlowExtensionSubmission`. A valid digest alone is not trusted provenance.

Before enabling, record the actual package version, release/tag (if any), full
source SHA/ref, both digests, catalog commit, and runtime release versions. Human
merge/release precedes catalog publication. Relay native delivery, Cloud lineage,
and RelayHistory receipts must be merged and released before deployment. Capture
the live label-to-original-session receipt before reporting end-to-end readiness.
