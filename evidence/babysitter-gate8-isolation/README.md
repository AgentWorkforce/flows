# Native Babysitter gate-8 isolation evidence

This slice adds a Linux-only, capability-only execution primitive for the
immutable native Babysitter extension. It does not wire hosted dispatch, change
the generic executor refusal introduced by #549, publish a package, or enable a
deployment.

The enforced boundary is:

- require the exact reviewed Software Factory base source hash without
  importing tenant base code, and resolve the complete
  installation as one opaque generation without importing extension
  JavaScript; cross-project and same-path cross-redeploy pairing refuse, and
  every dispatch rechecks the current declarations plus complete project
  source; base stdout, globals, process termination, relative/package imports,
  and an earlier module cache cannot forge the parent-pinned identity; source
  directory entries are streamed beneath a shared entry bound; `flows.json`
  and `flows.lock.json` plus source files use nonblocking no-follow descriptors
  and explicitly bounded reads before contents are buffered or parsed;
- reverify every content-addressed artifact, lock metadata, manifest hash,
  base/runtime compatibility, and route uniqueness using bounded descriptor
  reads that enforce the fetched plugin's 500-file, 256-KB-per-file, and 2-MB
  total limits before allocation, then require the exact
  immutable native ref/digest/manifest and narrow permission profile; copy the
  selected bytes into a private snapshot, recompute its digest, and mount only
  that snapshot so later store replacement cannot change executed code;
- clone the delivery descriptor into behavior-free, frozen JSON with captured
  parent intrinsics before validation or serialization, rejecting proxies,
  accessors, inherited `toJSON`, symbol keys, cycles, holes, and extra fields;
  enforce depth, node-count, and encoded-byte limits incrementally while
  traversing (including repeatedly shared subtrees), count string escaping
  without materializing an unbounded encoded copy, and validate exact keys
  without ambient array methods; then validate that snapshot against the
  symbol-branded verified dispatch before import;
- import and execute the matching handler only inside a bubblewrap namespace
  plus Node's permission model, with no network, writable filesystem, inherited
  environment, child process, workspace mount, MCP, helpers, harnesses, or base
  flow context; a generated facade mounts only `flow`, `github`,
  `getFlowDefinition`, and private copies of six SHA-256-pinned Surface runtime
  files, followed by one final runtime-generation check before launch; an
  inherited hard limits of 16 GiB address space and 3 GiB data/anonymous
  memory cover heap, Buffer/native memory, mappings, and descendants in
  addition to the 64 MiB V8 old-space setting; the wider address-space ceiling
  admits Node's virtual V8/Wasm reservations while the tighter data limit
  refuses two hostile 2 GiB Buffers;
- expose one `capabilities.cloud.babysitterTurn.queue({ delivery })` call and
  `done`, validate the exact request and `{ receiptId, status }` response in the
  parent, and pass the original non-serializable authority to the host adapter;
- treat descriptor 3 as hostile transport: clone and validate every frame and
  both boundary payloads with captured parent intrinsics, so direct writes can
  consume only the same exact one-shot delivery capability already granted and
  cannot claim premature success;
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
