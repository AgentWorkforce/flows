# Native Babysitter gate-8 isolation evidence

This slice adds a Linux-only, capability-only execution primitive for the
immutable native Babysitter extension. It does not wire hosted dispatch, change
the generic executor refusal introduced by #549, publish a package, or enable a
deployment.

The enforced boundary is:

- load and retain the actual base flow with extensions disabled and resolve an
  opaque complete installation for the same canonical flow path without
  importing extension JavaScript; cross-project authority pairing refuses;
- reverify every content-addressed artifact, lock metadata, manifest hash,
  base/runtime compatibility, and route uniqueness, then require the exact
  immutable native ref/digest/manifest and narrow permission profile;
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
- treat descriptor 3 as hostile transport: validate every frame and both
  boundary payloads, so direct writes can consume only the same exact one-shot
  delivery capability already granted and cannot claim premature success;
- fail closed on unknown frames, repeated/omitted calls, premature completion,
  timeouts, adapter rejection, incompatible bytes, route ambiguity, forged
  loader results, an unverified/composed base, and broader permissions.

The parent validations are the security boundary. Child-side handler routing,
the context proxy, its once-only counter, and `done('success')` are correctness
checks only: hostile code may bypass all of them by writing descriptor 3. The
parent therefore enforces the exact delivery, one-call limit, terminal ordering,
and authoritative adapter outcome independently, including when a child emits
an error immediately after its request or hangs after a typed adapter rejection.

Cloud PR #3942 remains responsible for persisted dispatch context, live PR and
label/head revalidation, authorized existing-session resolution, lineage-based
deduplication, and Relay native-turn delivery. The broader per-step permission
enforcement requested by #442 is not implemented here and remains a separate
gate. The committed extension declares SDK/Surface `^2.0.26`; an injected
2.0.25 runtime is refused before import, while the exact published 2.0.26 bytes
are exercised inside the sandbox.

See `verification.txt` for the final local verification record.
