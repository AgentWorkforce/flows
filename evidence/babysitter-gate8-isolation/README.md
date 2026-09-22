# Native Babysitter gate-8 isolation evidence

This slice adds a Linux-only, capability-only execution primitive for the
immutable native Babysitter extension. It does not wire hosted dispatch, change
the generic executor refusal introduced by #549, publish a package, or enable a
deployment.

The enforced boundary is:

- load the base flow with extensions disabled and resolve extension artifacts
  without importing extension JavaScript;
- reverify the content-addressed artifact, lock metadata, manifest hash, exact
  immutable native source, runtime compatibility, and narrow permission profile;
- validate a symbol-branded verified dispatch and a closed normalized delivery
  descriptor before import;
- import and execute the matching handler only inside a bubblewrap namespace
  plus Node's permission model, with no network, writable filesystem, inherited
  environment, child process, workspace mount, MCP, helpers, harnesses, or base
  flow context; a generated facade mounts only `flow`, `github`,
  `getFlowDefinition`, and their six reviewed Surface runtime files;
- expose one `capabilities.cloud.babysitterTurn.queue({ delivery })` call and
  `done`, validate the exact request and `{ receiptId, status }` response in the
  parent, and pass the original non-serializable authority to the host adapter;
- fail closed on unknown frames, repeated/omitted calls, premature completion,
  timeouts, adapter rejection, incompatible bytes, and broader permissions.

Cloud PR #3942 remains responsible for persisted dispatch context, live PR and
label/head revalidation, authorized existing-session resolution, lineage-based
deduplication, and Relay native-turn delivery. The broader per-step permission
enforcement requested by #442 is not implemented here and remains a separate
gate. The committed extension declares SDK/Surface `^2.0.26`; current 2.0.25
correctly refuses it before import.

See `verification.txt` for the final local verification record.
