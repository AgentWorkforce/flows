# Wire contract: trusted deterministic-step credentials

- **Status:** a contract for implementation. Frozen once flows and Cloud both acknowledge it.
- **Derived from:**
  - the frozen design, flows `0b1c11fb` (`docs/proposals/trusted-det-step-credentials.md`, cited
    as **G§**);
  - Cloud `1ecace51` (`docs/design/hosted-step-env-boundary.md`, cited as **H§**).
- **Labels:**
  - Every name the frozen pair leaves open is marked **PROPOSED**.
  - Native's tightenings are marked **PROPOSED (Native)**.
  - Items that wait on the pending design delta (a) are marked **PENDING (a)**.
- **Encodings:**
  - All JSON is UTF-8, one object per line, terminated by `\n`.
  - All hex is lowercase.
  - `‖` means byte concatenation, and `0x00` is a single zero byte.
- **Not covered here:** behaviour and threat model, which are in G§2–§8.

## 0. Reconciliation of the root pins (R1, PROPOSED; needs flows and Native ack)

The two frozen documents describe the frame's `pins` differently:
- **G§4.1 / §4.3.1** pins a single digest (`root_authority_sha256`) plus `display_fields` and the
  reserved `root_admission_key`. The kernel compares it against the normalized submitted root
  spec.
- **H§2.2** lists the trusted *inputs* to that predicate: manifest, `flowPath`, Surface,
  extensions, input, local agent, admission identity and spec structure.

**Contract.**
- The host feeds those H§2.2 inputs to the pinned SDK's `root-authority` (§5.3), which runs the
  static resolver and returns the digest. The frame carries the **digest** (§1).
- The kernel never parses TypeScript and never sees the raw inputs.
- This keeps the kernel generic (G§4.3.1) while every H§2.2 input still determines the pin.

## 1. Daemon start: `relayflowd serve --det-frame-stdin`

### 1.1 argv

```
relayflowd --data-dir <dir> serve --det-frame-stdin --det-ack-fd <n>
```

- **`--det-frame-stdin`** (G§4.1; H§2.2). Absent means the daemon reads no frame and makes no
  binding: today's behaviour. Present means exactly one frame is required, otherwise the daemon
  refuses to start (§1.4).
- **`--det-ack-fd <n>`** (**PROPOSED (Native)**; tightens G§4.1 and H§6). An inherited writable
  descriptor, `n ≥ 3`, on which the daemon writes exactly one ack or refusal line (§1.3), then
  closes it.
  - It is required whenever `--det-frame-stdin` is present.
  - The socket is never used for the ack.
- No credential name, value, K or pin ever appears in argv (G§4.1).

### 1.2 Frame (stdin; one line, then EOF)

**Size.** The maximum is **65 536 bytes** including the trailing `\n` (**PROPOSED (Native)**). A
larger frame is refused with `frame_too_large`. After the line, the daemon reads stdin to EOF;
any non-whitespace byte after the line is refused with `frame_trailing_data`.

```json
{
  "version": 1,
  "credentials": { "GH_TOKEN": "<string>" },
  "capability": "<64 hex: K, 32 bytes>",
  "pins": {
    "root_authority_sha256": "<64 hex>",
    "display_fields": ["/name", "/steps/0/instruction/flowName"],
    "root_admission_key": "authored-root:<64 hex>"
  },
  "withhold": ["ANTHROPIC_API_KEY", "HOUSE_PROXY_CREDENTIAL"],
  "posture": {
    "schema": "relayflow-host-posture-v1",
    "yamaPtraceScope": 1,
    "cliNoNewPrivs": true,
    "daemonNoNewPrivs": true,
    "sudoEscalation": "absent",
    "sharedUserNamespace": false,
    "observedAt": "<RFC 3339 timestamp>"
  }
}
```

| Field | Rule | Source |
|---|---|---|
| `version` | integer, must be `1` | **PROPOSED** |
| `credentials` | object; keys match `^[A-Z_][A-Z0-9_]*$`; values are strings of 8 to 32 768 bytes with no NUL. Today exactly one key, `GH_TOKEN` (exact standalone Babysitter launch only). | G§4.1, G§7.1; H§2.2 |
| `capability` | exactly 64 hex characters (K = 32 random bytes) | G§4.1, §4.3.2; H§2.2 |
| `pins.root_authority_sha256` | 64 hex; the digest from §5.3 | G§4.3.1; reconciled in §0 |
| `pins.display_fields` | array of JSON pointers, excluded from the digest; may be empty (YAML roots) | G§4.3.1 |
| `pins.root_admission_key` | the reserved kernel admission key: `authored-root:` + sha256 hex of the admission identity (`authored-root.ts:584-586`) | G§4.3.2 |
| `withhold` | array of names (same grammar as `credentials` keys); host-tracked agent and house writes plus `HOUSE_PROXY_CREDENTIAL` | G§4.5; H§4 |
| `posture` | host attestation of G§4.3.2 J1, shape **PROPOSED (Native)**. Refused (`posture_unsupported`, field = the offending key) if: `schema` ≠ `relayflow-host-posture-v1`; any value is `null` or `"unknown"`; `yamaPtraceScope < 1`; `cliNoNewPrivs` or `daemonNoNewPrivs` is not `true`; `sudoEscalation` ≠ `"absent"`; or `sharedUserNamespace` ≠ `false`. `sudoEscalation` may be `"absent"` only under NoNewPrivs 1. Today's image reports `"present"` (Native's reported historical probe), so binding is refused. The daemon also checks its own local readings (§1.5) and **refuses on any disagreement** with the attestation. | **PROPOSED (Native)**; G§4.3.2 J1 |

**Protected names.** Neither `credentials` nor `withhold` may contain `PATH`, `HOME`,
`FLOWS_INPUT`, `RELAYFLOW_MEMORY`, `LD_*` or `DYLD_*` (G§4.1). A name may not be both bound and
withheld.

**Not in the frame.** The raw H§2.2 inputs. They feed §5.3 on the host (§0). The **PENDING (a)**
`imports` closure is part of that §5.3 input record, not a frame field.

### 1.3 Ack and refusal (on `--det-ack-fd`; **PROPOSED (Native)**)

After the frame validates, the posture checks pass, the binding is installed and the socket is
bound, the daemon writes one line and closes the fd:

```json
{"det_frame":"accepted","version":1,"credentials":["GH_TOKEN"],"withhold_count":7,"root_admission_key":"authored-root:<64 hex>"}
```

On any refusal it writes one line, closes the fd, and exits with status **78** (`EX_CONFIG`):

```json
{"det_frame":"refused","code":"<code>","field":"<field or name, never a value>"}
```

**Refusal codes:**

| Code | Field names |
|---|---|
| `frame_missing` | the frame |
| `frame_malformed` | the frame |
| `frame_too_large` | the frame |
| `frame_trailing_data` | the frame |
| `version_unsupported` | `version` |
| `capability_invalid` | `capability` |
| `pin_missing`, `pin_invalid` | a `pins.*` field |
| `credential_invalid` | the credential name |
| `name_protected` | the name |
| `name_conflict` | the name (both bound and withheld) |
| `posture_unsupported` | the failing `posture.*` field, or `local:<check>` (§1.5) |
| `ack_fd_invalid` | the ack fd |

The same line also goes to stderr, without values.

**Timeout (host side).**
- No ack line within **15 s** of closing stdin, EOF on the ack fd without a complete line, or a
  `refused` line are all **terminal** for the launch (H§6 "no silent fallback").
- The host never retries by placing the token anywhere else.

### 1.4 Startup refusal precedence

The daemon applies these checks in order:
1. argv (`--det-ack-fd` missing or invalid);
2. frame read (missing, too large, trailing data);
3. JSON and schema;
4. names;
5. posture (attested, then local);
6. socket bind.

It reports the **first** failing check.

### 1.5 Local posture checks (daemon and CLI; **PROPOSED**; G§4.3.2 J1)

These run **on Linux only**. Any other platform refuses with `posture_unsupported`, field
`local:platform`.

| Check | Refuse if |
|---|---|
| `/proc/sys/kernel/yama/ptrace_scope` | missing or `< 1` (`local:yama`) |
| `/proc/self/status` `CapEff`/`CapPrm`/`CapAmb`/`CapBnd` | bit 19 (`CAP_SYS_PTRACE`) is set in any of them (`local:cap_sys_ptrace`) |
| `/proc/self/status` `NoNewPrivs` | not `1` (`local:no_new_privs`) |

The CLI performs the same three local checks before it reads `--host-capability-fd`, and refuses
with `host_posture_unsupported`. Each local reading must agree with the matching attestation field:
Yama ↔ `yamaPtraceScope`, and own `NoNewPrivs` ↔ `cliNoNewPrivs` or `daemonNoNewPrivs`.

### 1.6 NoNewPrivs: options, no decision (neither is granted)

**Default:** refuse binding on today's posture.

**(A) Host runs the CLI and daemon under `no_new_privs`** (`setpriv --no-new-privs` or a prctl
helper).
- **Coverage:** the whole tree, including every `f.run` step.
- **Breaks:** steps that use sudo, such as `sudo apt-get install`.
- **Status:** a product decision for the lead. Not the default.

**(B) Flows sets `no_new_privs` only on the agent processes it spawns.**
- **How flows spawns agents (verified on `2ee558ee`).** The SDK spawns agent CLIs **directly**,
  not through the broker:
  - `child_process.spawn` at `packages/sdk/src/worker-cli.ts:436` (adapter CLIs);
  - `packages/sdk/src/wrapper-session.ts:137` (wrapper CLIs).
- **Feasibility.** Node has no prctl API, so (B) needs one of:
  - prefixing the spawn with `setpriv --no-new-privs --` (util-linux; present on this dev host at
    `/usr/bin/setpriv`; presence in the sandbox image is **unknown**);
  - a minimal static helper that calls `prctl(PR_SET_NO_NEW_PRIVS, 1)` and then `execve`.

  Either way it must fail closed if the helper is missing.
- **Gap (B) leaves.** Det steps are spawned by the daemon, not the SDK, and run untrusted repository
  code with the run's uid.
  - Under (B) they keep sudo, so repository code can still escalate and read K or D from the CLI or
    authored-child memory.
  - So (B) **alone does not satisfy J1**. It needs either (A) for det steps too, or a uid split
    between K-holding processes and steps. That is a decision for the lead.

`PR_SET_PTRACER` is never called by relayflowd or the SDK. That is enforced by a source test, not
probed. Namespace grants are host-attested only.

## 2. `hello` result additions (G§5; H§3)

```json
{"protocol":0,"server":"relayflowd","features":["reported_cost","step_env","det_credentials"],
 "auth_nonce":"<64 hex>","det_withheld":["ANTHROPIC_API_KEY","GH_TOKEN"]}
```

| Field | Rule |
|---|---|
| `features` | contains `det_credentials` whenever the daemon implements it, bound or not |
| `auth_nonce` | 32 random bytes as hex, fresh per `hello`, bound to that connection. Consumed by the first `auth.prove` or `auth.delegate`, success or failure. Expires after **60 s** or on disconnect. A new `hello` replaces it. (G§4.3.2) |
| `det_withheld` | present only when bound. Sorted names = `withhold` ∪ `credentials` keys. Names only, advisory. (G§4.5) |

## 3. Verbs

### 3.1 `auth.prove` (G§4.3.2; H§3)

```
params: {"purpose": "journal" | "worker-peer:<journal_session>", "mac": "<64 hex>"}
mac    = HMAC-SHA256(K, "relayflowd-auth-v1" ‖ 0x00 ‖ purpose ‖ 0x00 ‖ nonce_hex_ascii)
result (journal):     {"journal_session": "<32 hex>"}
result (worker-peer): {"paired": true}
errors: auth_failed            (bad, replayed or expired nonce; wrong purpose; wrong K; unknown J)
        auth_unbound           (PROPOSED: daemon has no binding)
```

### 3.2 `session.delegate` (G§4.3.6 with A1; H§3 C1 step 1)

Called on the owner's journal session J.

```
params: {"root_run_id": "<run id>", "step": "authored-root", "attempt_id": <u32>,
         "delegate_pid": <u32>, "delegate_start_time": <u64 /proc/<pid>/stat field 22>,
         "ops": ["child.start", "child.resume", "child.read"]}
result: {"delegation_id": "<32 hex>"}
errors: root_not_authenticated (caller has no journal proof)
        lineage_not_owned      (not the owner J, or called from a delegated session)
        parent_not_held        (J's paired peer does not hold the live lease on exactly
                                (root_run_id, step, attempt_id))
        lineage_terminal       (PROPOSED: the root is terminal)
        delegation_unsupported (PROPOSED: no peer-pid credentials on this platform)
```

- Only ops from that set are accepted. One live delegation per (J, attempt); a new mint revokes the
  old one.
- No secret appears in the result (A1).

### 3.3 `auth.delegate` (G§4.3.6; H§3 C1 step 3)

```
D      = HMAC-SHA256(K, "relayflowd-delegation-v1" ‖ 0x00 ‖ delegation_id_hex_ascii)   (32 bytes)
params: {"delegation_id": "<32 hex>", "mac": "<64 hex>"}
mac    = HMAC-SHA256(D, nonce_hex_ascii ‖ "authored-child")
result: {"delegated": true}
errors: auth_failed            (bad mac, nonce, or unknown id)
        delegation_used        (already bound to a session)
        delegation_invalid     (revoked, or liveness failed)
        delegation_unsupported (the peer pid or start time cannot be read)
        delegation_peer_mismatch (PROPOSED: SO_PEERCRED pid ≠ delegate_pid, or start time ≠ delegate_start_time)
```

### 3.4 Changes to existing verbs (G§5)

**Step spec.** Deterministic steps gain `"credentials": ["NAME", ...]`: sorted, unique, the same
name grammar. Llm and agent steps refuse it as an unknown field.

**`run.start`** gains `"parent": {"run_id", "step_id", "attempt", "child_id"}` for authored
children (G§4.3.3). The admission key must equal `"authored-child:" + sha256_hex(parent.run_id ‖
0x00 ‖ child_id)` (`authored-admission.ts:4-10`).

**Errors and ownership.**
- **Ownership:** for runs of an entitled lineage, `run.resume`, a `run.start` that resolves to an
  existing run, and any `env` replacement require the lineage owner, or a delegated session
  within its ops. This is checked before any mutation (G§4.3.5).
- **New error codes:**
  - `credential_unavailable`: a declaration the run is not entitled to;
  - `root_not_authenticated`: a root operation, or the reserved key, from an unauthenticated
    connection, or an authority mismatch;
  - `lineage_not_owned`: an authenticated session that is not the owner, or a delegate acting
    outside its ops;
  - `parent_not_held`: the `parent` lease is not held by the requester's paired peer.
- **Spawn-time failure:** a step that cannot receive a declared credential fails with
  `completionReason: "worker_error"` and `failure_detail: "credential_unavailable: <NAME>"`
  (G§4.4).

## 4. SDK and CLI transport

### 4.1 Host capability descriptor (**PROPOSED (Native)**; tightens G§4.3.2 "fd 3")

```
flows run ... --host-capability-fd <n>
```

| Case | Behaviour |
|---|---|
| Flag absent | The SDK never reads any extra descriptor. Local runs are unchanged. |
| Flag present | Before importing any user module or spawning anything, synchronously: read fd `n` to EOF; require **exactly 64 hex characters**, optionally followed by one `\n`, and nothing else (read cap 65 bytes; more is a refusal); then `close(n)`. K lives only in a closure in the CLI parent. |
| Unreadable, empty, malformed or oversized | The CLI exits non-zero before any run starts, with a typed diagnostic `host_capability_invalid` that names the fd, never the content. |

- The host writes K and closes its write end, so the reader reaches EOF (H§3). Cloud supplies an
  extra pipe slot in `runCapturedRelayflowV2Process`, cloud `relayflow-v2-executor.ts:1014-1025` (cloud main `7bda9a145`).
- Non-secret companion env, set by the host in the CLI env:
  - `RELAYFLOW_AUTHORED_ADMISSION_KEY`: the admission identity, from which the SDK derives the
    reserved key;
  - `FLOWS_ROOT_SOURCE_SHA256`: the SDK's local source-pin check (G§4.3.1). PROPOSED name.

### 4.2 Authored-child hand-off (G§4.3.6 step 2; H§3 C1 step 2)

The existing stdin request line to `authored-node-entry` gains one field, validated before any
authored module loads, alongside `channelKey` (`authored-node-entry.ts:68-69`):

```json
"delegation": {"delegation_id": "<32 hex>", "secret": "<64 hex: D>"}
```

- It is **absent** when no binding is active.
- When present, both fields are exact hex of the stated lengths, otherwise the child exits before
  importing user code.
- The child never receives K. `secret` is held in a closure, never logged or echoed. The child
  sends `auth.delegate` before any other verb on its journal connection.

## 5. Host-callable exports (G§6 P1–P3; H§3 J3/Q4)

Each export is published from the **pinned SDK** package. The CLI command is the host's primary
interface, so the host never links a mismatched SDK library (**PROPOSED**).

### 5.1 `canonicalJsonSnapshot` (P1). Library import.

```ts
export function canonicalJsonSnapshot(value: unknown): JsonValue
```

- Exactly the semantics of the private `jsonSnapshot` at `authored-root.ts:592-596`: a
  `JSON.stringify` → `JSON.parse` round trip.
- It throws `TypeError` when the value is not JSON-serializable.
- It is used together with the existing exported `canonicalize` (`canonical.ts:33`).

### 5.2 `resolveAuthoredGraph` (P2). Library import.

```ts
export interface VerifiedSourceStore { read(sha256: string): Uint8Array }  // sha-verified, read-only (H§3 J3)
export function resolveAuthoredGraph(input: {
  manifest: Readonly<Record<string, string>>;       // absolute path -> sha256 hex (write-time)
  store: VerifiedSourceStore;
  rootPath: string;
  pinnedSurface: { packageName: string; version: string; installPath: string };
}): { ok: true; graph: { path: string; sourceSha256: string;
                         surface: { packageName: string; version: string } }[];
      imports: { path: string; sourceSha256: string }[] }   // PENDING (a)
 | { ok: false; reason: 'nested_surface' | 'dynamic_import' | 'parse_failure'
                        | 'outside_manifest' | 'store_mismatch' };
```

- **Static and non-executing.** It follows static import and re-export specifiers. Type-only
  imports are not edges.
- Every `@relayflows/surface` specifier must resolve to `installPath`.
- The refusal reasons map r1–r4 from G§6 P2, plus J3's `store_mismatch`.
- `graph` is the ordered `use` graph that becomes `metadata.sources`. `imports` is the full
  static import closure: **PENDING (a)**.

### 5.3 `authoredRootAuthority` (P3). Library import and CLI command.

```ts
export function authoredRootAuthority(input: {
  manifest; store; rootPath; pinnedSurface;           // as 5.2
  extensions: { name: string; digest: string; ref: string }[];
  input?: unknown;                                    // absent => inputPresent false
  admissionIdentity: string;
  localAgent: boolean;
  displayFields: string[];
}): { ok: true; record: unknown; digest: string; rootAdmissionKey: string }
  | { ok: false; reason: string };
```

```
flows root-authority --manifest <file.json> --store <dir> --root <path> \
  --surface <packageName@version> --surface-install <dir> --extensions <file.json> \
  [--input <json>] --admission-identity <id> [--local-agent] \
  --display-fields /name,/steps/0/instruction/flowName
stdout (one line): {"root_authority_sha256":"<64 hex>","display_fields":[...],"root_admission_key":"authored-root:<64 hex>"}
exit 0 on success; exit 2 with {"refused":"<reason>"} on any resolver or record refusal
```

- `record` is the normalized authority of G§3/§4.3.1 (V1 fields; `imports` **PENDING (a)**).
- The digest is computed with the kernel's normalization (G§4.3.1).
- The stdout fields map one to one onto the frame's `pins`.

## 6. Open items for freeze

- **R1** (§0): the pins are carried as a digest computed from the H§2.2 inputs. Needs flows and
  Native ack.
- **(a)** The `imports` closure (path → sha256) in the root authority (§5.2, §5.3).
  - Native accepts it: the host pins the closure the resolver computes over its write-time
    manifest and byte store, and refuses anything outside the manifest.
  - Still **PROPOSED**, pending the lead.
- **NoNewPrivs** (§1.6): option (A) or (B), neither granted.
- The **PROPOSED** names in this document.
