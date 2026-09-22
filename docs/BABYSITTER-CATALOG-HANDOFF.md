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
turn contract). It is unreleased and cannot execute: #549 still refuses it,
the SDK context has no `capabilities.cloud.babysitterTurn`, and its
`compat` requires a surface release after 2.0.25 that routes `labeled`,
`unlabeled`, and `ready_for_review`. Export it only from a reviewed, merged
commit.

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
