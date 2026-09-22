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
release commit pinned below. The Software Factory flow's own independently
versioned header remains `2.0.22`; a regression requires the hosted identity to
equal the identity obtained from that exact reviewed source.

The sandbox contract is deliberately narrower than #442. It re-verifies the
complete lock-backed installation and every manifest, binds it to the exact
reviewed Software Factory source in the same `loadHostedExtensionRuntime` generation, detects
cross-extension route ambiguity, accepts only the exact published Babysitter
ref/digest/manifest and native permission profile, imports the entry only
inside Linux bubblewrap plus Node's
permission model under an inherited 1.5 GiB hard address-space limit, mounts a
minimal trusted Surface facade (`flow`, `github`,
and `getFlowDefinition`) from six integrity-pinned private runtime files instead
of the general helper runtime, checks
normalized input against non-serializable verified dispatch authority, and
permits one queue call. The parent capability adapter
receives that original authority plus immutable extension provenance; the
capability request never carries workspace, activation, listener, session,
lineage, label, head, prompt, merge, route, or config authority. Cloud PR #3942 owns the
lineage/authority core and must inject workspace, activation, and listener from
persisted dispatch context, re-read live PR/label/head state, and return only
`{ receiptId, status: 'queued' | 'duplicate' }`. Refusal or in-doubt transport
rejects once with no fallback.

Only the parent validator is a security boundary. The isolated entry can write
its inherited protocol descriptor directly and bypass child-side routing,
context, call-count, and completion checks. Parent validation therefore treats
every frame as hostile, permits at most the one exact delivery already bound to
the branded dispatch, and waits for the adapter's authoritative outcome before
settling any premature child terminal frame. An authoritative adapter rejection
settles immediately with its original typed error even if the child hangs.

Before replacing #549's refusal, the hosted caller must obtain an opaque base
and installation as one generation with `loadHostedExtensionRuntime`, then call
`runHostedCapabilityExtension` with both values. Every dispatch rechecks the
current extension declarations and complete project source tree against that
generation. The loader never imports tenant base code to derive authority. It
requires the exact reviewed Software Factory flow-file SHA-256 and assigns its
pinned name/version in the parent; project `node_modules`, relative imports,
stdout, process termination, globals, and module caches therefore cannot forge
that identity. The sandbox separately requires exact SHA-256 pins for every
Surface runtime file it needs, copies those bytes into its private runtime, and
mounts only the copies. A final generation check runs after both private
snapshots exist and immediately before launch;
using the ordinary compose loader would import extension top-level JavaScript
in the host before the sandbox exists. Cross-project, cross-redeploy, stale,
and structural pairings fail before import. The selected store bytes are copied into a
private snapshot whose digest is recomputed before bubblewrap mounts it, so a
later live-store replacement cannot alter imported code. Independent review
must prove this path at the exact release head. Broader per-agent-step
file/network/access-preset enforcement remains open in #442 and is not claimed
by this slice.

The reviewed native source ref is
`github:AgentWorkforce/flows@8b33ebab8347514f80d9da5a81206a087f641714#extensions/babysitter`,
the commit included in the published 2.0.26 install. The earlier byte-identical
pre-release commit is not accepted as authority.

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
