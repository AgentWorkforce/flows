# Proposal: a trusted credential channel for deterministic steps

- **Status:** proposal and offline fixture only. Nothing is implemented, published, re-pinned,
  released or activated. **Frozen together with Native's host revision.**
- **Wire feature:** `det_credentials`, listed in `hello.features`.
- **Scope split:**
  - This document is the **generic flows contract**: kernel, wire, spec and SDK.
  - Native (native-sandbox-env) owns the Cloud host: cloud `design/hosted-step-env-boundary` @
    `41cc8cb3` (rev 4; rev 3 `a903e8f8`; token gate first at `eb2f4786`).
  - §7 lists exactly what any host must do. Items marked **HOST GATE** are Native's to specify and
    evidence.
- **Revision 3 (final).** It folds in:
  - the lead's reviews (D1-D6; points (1)-(6); V1-V4; W1);
  - Native's host revisions 2-4.

  The lead's decisions:

  | Decision | |
  |---|---|
  | Per-step declarations | required |
  | Entitlement | by run **lineage**, never daemon-wide |
  | First writer, first attach or first dispatch | is **not** authentication |
  | `serve --step-env daemon` | **not accepted** (§10.1) |
  | Graph completeness | **mandatory** for binding (W1) |

  §13 maps each finding to its section and test.

> **E2B posture: unsafe per a reported historical probe, otherwise unknown (J1).** Native reports
> that its production probe on run `bace8ad1` (2026-10-10) recorded `user=user` with **passwordless
> sudo**. On that posture an agent could become root and read any process's memory, K included.
> This is a reported historical probe, **not** an independently verified statement about the
> current image. The memory-posture host gate (§4.3.2) fails closed on an **unsafe or unknown**
> posture, so it refuses binding unless a supported posture is established. This design authorizes
> **no** image, template, sudo, uid or sysctl change, and **no** new live probe.

## 1. Problem: #655 broke the boundary in both directions

flows#655 (`acb9c2ce`, merged `edc9f5b4`, released v2.0.46) sends the CLI's whole `process.env` as
the run's step env:
- `packages/sdk/src/journal-client.ts:135,144,154-161` sends it;
- `exec_det` applies it after clearing the daemon env (`kernel/relayflowd/src/exec_det.rs:77-80`).

Cloud's two envs differ on purpose (cloud `packages/core/src/bootstrap/lib/relayflow-v2-step-env.ts`):

| Env | Contents | Source |
|---|---|---|
| `daemonEnv` | delivered + base + repository | `:215-216` |
| `daemonEnv`, Babysitter only | `+ GH_TOKEN` from `RELAYFLOW_V2_DAEMON_GITHUB_TOKEN` | `:217-218` |
| `cliEnv` | `daemonEnv + AGENT_ENV_KEYS` (13 names, `:122-136`), `+ houseProxyCliPickup(...)` | `:219`, `:249` |
| `cliEnv` | `GH_TOKEN` deleted | `:223` |

- The Babysitter token is minted once, for the exact standalone Babysitter launch only
  (`packages/web/lib/workflows/launch-runner.ts:683-707`).
- The house-proxy pickup keys come from `packages/core/src/auth/proxy-token.ts:323-337`.
- The executor spawns relayflowd with `daemonEnv` (`relayflow-v2-executor.ts:840-848`, stdin
  `"ignore"` at `:846`). It spawns the CLI with `cliEnv` plus `PATH` (`:728-736`, `:976`, `:1019`).

**D1. Lost entitlement.** Babysitter `f.run` steps no longer see `GH_TOKEN`, and throw `GH_TOKEN
required`. The checks are at:
- `examples/babysitter/fix.ts:42`
- `merge.ts:18`
- `signals.ts:52,169,186,212`
- `github.ts:78`

**D2. Agent-key exposure.** Every det step, including ones that run repository code
(`workspace.ts:18`), now receives agent-only and house-proxy keys.

**Accuracy: exactly one credential, exactly one launch.**
- **Ordinary repository runs never carry env `GH_TOKEN`.**
  - `relayflow-v2-repository.ts:207-210` deletes `GH_TOKEN` and `GITHUB_TOKEN` from the repository
    env.
  - git and gh read the repository token from files (`GIT_ASKPASS`, `GH_CONFIG_DIR/hosts.yml`).
  - A repository-grant refresher renews those files atomically
    (`relayflow-v2-repository.ts:59-67,158-170`; `relayflow-v2-repository-token.ts:108-118`). It
    starts only when a grant exists (`relayflow-v2-executor.ts:675-678`).
  - Native's revision-2 F2 claimed otherwise; that claim was **incorrect**.
- **The only `GH_TOKEN`-in-step case is the daemon-only Babysitter token.** So the trusted channel
  carries **exactly one credential today**, for one launch type.
- **That token has no refresh and no file.** The Babysitter launch is required to have no
  repository grant (`launch-runner.ts:666-669`). Its lifecycle is distinct from the repository
  token files.

### 1.1 Current-behaviour reproduction (separate from the future contract)

Two tests pin today's defect. They are not ignored or skipped, and they pass on main. All values
are fake.

| Test | Shape | Shows |
|---|---|---|
| `kernel/relayflowd/tests/det_credentials_design/current_behaviour.rs` | daemon env holds the token; the client sends a `cliEnv`-shaped env | the det step lacks `GH_TOKEN` and has every agent key |
| `packages/sdk/tests/det-credentials-live.design.test.ts`, "current main" | **real SDK**, real kernel. The host pre-starts relayflowd with `daemonEnv` and runs `flows run --local-agent` with `cliEnv`. A fake `claude` (which takes the real adapter env path, not the wrapper allowlist) and an `f.run` step dump their env. | the det step loses `GH_TOKEN` and receives the agent keys; the actual agent step keeps its keys |

## 2. Threat model

**Trusted:**
- the host;
- the kernel;
- SDK code that runs **before** the authored module loads.

**Semi-trusted:** the authored body, which by Cloud's design holds the agent login
(`relayflow-v2-step-env.ts:31-37`).

**Untrusted:**
- agent and LLM steps;
- repository code;
- other runs;
- any process that can reach the socket: Cloud gives agents `RELAYFLOW_DATA_DIR`
  (`relayflow-v2-executor.ts:715-727`).

| # | Attack | Defence |
|---|---|---|
| T1 | An agent or LLM step reads a det credential. | Injected only into declaring `exec_det` children of the lineage. `credentials` is refused on llm/agent steps. Never in any CLI-held env. |
| T2 | Another run, agent-started or env-free, gets it. | Lineage from an authenticated root. Bound names are stripped from every base env. |
| T3 | Intruder-before-root: the public key, any spec. | The key is host-reserved, so it is refused without an authenticated journal session. The authority pin must match. |
| T4 | Intruder-first-worker or redelivery. | Root-lineage leases go only to the worker peer paired with the root's journal session. |
| T5 | Child spoofing: another session, a stale attempt, an unpaired peer, a wrong key. | Exact linkage (§4.3.3). |
| T6 | Restart or restore resurrects or widens a binding, or an old K is replayed. | Nothing is persisted. Each lifetime gets a new frame and a new K. A proof is bound to a single-use nonce. |
| T7 | Values, K or proofs leak to the journal, watch stream, logs or kernel persistence. | Values come via the frame only. K never crosses the socket. Nothing secret is `Serialize`. Output is redacted before append. |
| T8 | D2. | The host's tracked withhold set. A compliant SDK omits it from the wire. The kernel strips it authoritatively. |

**Not authentication**, stated plainly:
- knowing the admission key;
- writing it first;
- attaching first;
- receiving the first dispatch.

## 3. Answers to Native's questions

**(a) Capability or env?** Env, injected at spawn into declaring det steps of the authenticated
lineage. Values arrive once, in the host's stdin frame. K is a transient authentication capability:
it never crosses the socket and is never step env.

**(b) What the kernel verifies.**

| Check | Basis |
|---|---|
| Connections | challenge-response proofs (§4.3.2) |
| Root | authenticated journal session; reserved key; normalized authority digest equal to the pin (graph-complete, §4.3.1) |
| Lease | only the paired worker peer |
| Children | exact linkage (§4.3.3) |
| Restart | new frame and new K; lineage from the registry |

**(c) SDK and wire changes:** yes. See §5 and §6.

| Root authority row | Status |
|---|---|
| kind, flowPath, sourceSha256, Surface | pinned |
| **sources[] graph** | **pinned by exact set equality with the host's static resolver (mandatory; W1)** |
| extensions[] (name, digest, ref; in order) | pinned |
| localAgentStream (presence, derivation); derived root stream | pinned |
| inputPresent, canonical input | pinned |
| single-step structure (id, type, instruction, streams, recovery, max iterations, retries) | pinned |
| flowName, spec `name` | **display only**, excluded |

## 4. Design

### 4.1 Host binding at daemon start

```
relayflowd --data-dir D serve --det-frame-stdin
stdin, one JSON line, then EOF:
{"credentials": {"NAME": "value"},
 "capability": "<K: 32 random bytes, hex>",
 "pins": {"root_authority_sha256": "<§4.3.1>", "display_fields": ["/name", "/steps/0/instruction/flowName"],
          "root_admission_key": "<reserved kernel admission key>"},
 "withhold": ["NAME", ...]}
```

- Nothing secret is in argv (`/proc/<pid>/cmdline`) or env (`/proc/<pid>/environ`, which env-free
  runs inherit).
- The daemon reads one line, reads to EOF and closes stdin.
- **Fail closed, never fall back.** With `--det-frame-stdin`, the daemon refuses to start, naming
  the field and never a value, if any of these holds:
  - no frame arrives;
  - `capability` or `pins.root_authority_sha256` is missing;
  - a value is empty, shorter than 8 bytes, or contains NUL;
  - a name is protected: `PATH`, `HOME`, `FLOWS_INPUT`, `RELAYFLOW_MEMORY`, `LD_*`, `DYLD_*`;
  - a name is both bound and withheld.

  Without the flag, the daemon binds nothing, exactly as today.
- `exec_det` sets `stdin(Stdio::null())`. Today det children inherit the daemon's stdin
  (`exec_det.rs:91`).
- **Placement.** `kernel/relayflowd/src/det_credentials.rs` holds the binding in `ProtocolHub`.
  Neither it nor K is `Serialize`, and their `Debug` prints names only.

### 4.2 Per-step declaration (required)

```json
{"id": "checkout", "type": "deterministic", "command": "...", "credentials": ["GH_TOKEN"]}
```

- The field goes in `STEP_DETERMINISTIC_FIELDS` (`relayflowd-core/src/spec.rs:382`), omitted when
  empty, so existing spec hashes are unchanged.
- It is not an llm or agent field.
- An undeclared step never receives a bound name.

### 4.3 Root authority and authentication

#### 4.3.1 The pinned root authority (graph-complete)

**Kernel check (generic).** The kernel computes `root_authority_sha256` from a submitted root spec:
1. Parse with the kernel's own `RunSpec::parse`, re-serialize.
2. Replace every step `instruction` that parses as a JSON object with that object.
3. Remove each `display_fields` JSON pointer.
4. Hash with sha256 of the kernel canonical JSON (`relayflowd-core/src/memoization.rs:19-50`). Its
   byte parity with the SDK's `canonicalize` (`packages/sdk/src/canonical.ts:33`) is pinned by
   `tests/spec_parity.rs` and `spec-parity.test.ts`.

The digest must equal the pin. The kernel holds no SDK semantics beyond "an instruction may be
canonical JSON".

**What the digest therefore covers, for an authored root.** The SDK's root
(`authored-root.ts:85-119,478-488`) is one agent step whose instruction is `canonicalize(metadata)`,
so the digest pins every row in the §3 table.

**Graph completeness (mandatory, W1).** Checking supplied source records against a host manifest
proves each record but **not** that the graph is complete, because the SDK still chooses
membership. So the host never takes `sources[]` from the SDK:
- It runs the **proposed trusted static, non-executing graph resolver** (§6, P2) over its
  write-time source manifest (path → sha256), never files on disk.
- It builds the expected authority from the resolver's **exact reachable set**.
- Because the digest pins `sources[]` in order, binding requires **exact graph-set equality**.
- **Refused, no credentials:** an omitted non-root node, an extra manifest node that is
  unreachable, duplicate records, or any changed per-node (path, sha, Surface) tuple.
- **If the resolver reports unknown or unsupported resolution** (a dynamic import, an unresolved
  specifier), the host refuses to bind: no frame and no credentials.

**Declarative (YAML) roots.** `display_fields` is empty. The host pins the digest of the exact
compiled spec it holds (`submitted-flow.json`).

**The source pin.** The SDK also refuses to start the root if the loaded root source sha ≠
`FLOWS_ROOT_SOURCE_SHA256`, which the host passes in the CLI env (not secret). That is a fast
local check. The kernel's authority pin is the binding check.

#### 4.3.2 K: challenge-response protocol

- **Minting and transport (Q2; Native's answer, labels kept: P = code-cited, I = inferred).**
  - The host mints K with `randomBytes(32)` per daemon lifetime and puts it in the daemon frame.
  - It spawns the CLI with an extra stdio slot (`[…, …, …, "pipe"]`, fd 3;
    `FLOWS_CREDENTIAL_ROOT_PROOF_FD=3`), writes K, and closes its write end, so the reader reaches
    EOF.
- **Synchronous intake (required).** libuv does not close inherited non-stdio fds in children; it
  relies on CLOEXEC, and an inherited fd 3 has none (I). So the SDK MUST do all of the following
  **synchronously at process start, before loading any user module and before spawning anything**.
  Otherwise every grandchild inherits the pipe.
  - Read fd 3 to EOF and `close()` it.
  - Delete the env name.
  - Hold K only in a closure.
- **The authored child gets no K** (this supersedes the earlier "fresh pipe with K" text; C1,
  §4.3.6).
  - Under Bun, authored bodies run in a separate Node child: `authored-node-entry.ts`, spawned at
    `authored-node-runner.ts:87-90` with stdio `['pipe', 'inherit', 'inherit', 'pipe']`. This is P,
    verified on 2ee558ee, which equals current main.
  - The child receives only a narrow delegation secret D, inside its **existing** stdin request.
    That request is validated before any authored module loads (`authored-node-entry.ts:58-77`); it
    already carries a 64-hex `channelKey` the same way.
  - So K lives only in the CLI parent. Agents and det steps spawned later get no alias.
- **Descriptor controls.**
  - No agent or det descendant may hold an fd aliasing either K pipe (`pipe:[inode]`).
  - A surviving alias would read EOF, because the content is consumed and the writer is closed.
  - The SDK never dups or re-lists a K descriptor.
- **Spec controls (SDK fixture; the future test asserts the observable parts):**

  | Control | Status |
  |---|---|
  | (a) fd 3 is closed before any user import: the authored child and the agent hold no descriptor to K's source, and no env carries the fd name or K | asserted |
  | (b) no det or agent grandchild has an fd aliasing a K pipe | asserted |
  | (c) the authored child never receives K; it receives D only in its stdin request | unit spec for the runner, to be written with the implementation |
- **HOST GATE: memory posture (J1).** K lives in the CLI heap and D in the authored-child heap, so
  confidentiality against same-user agents depends on the process posture. **`ptrace_scope ≥ 1`
  alone is insufficient**, for two reasons (https://docs.kernel.org/admin-guide/LSM/Yama.html;
  `security/yama/yama_lsm.c:356-374`):
  - `CAP_SYS_PTRACE` bypasses scopes 1 and 2;
  - scope 1 honours `PR_SET_PTRACER` exceptions.

  The host must establish an explicit, **supported posture**, and otherwise **refuse binding**.
  Every condition must hold (aligned with Native @ `3d7f30b9`):
  - Yama scope ≥ 1;
  - **no `CAP_SYS_PTRACE`** for agent, det-step and authored processes (effective, permitted and
    bounding sets);
  - **no escalation path** (no sudo, setuid or capability gain) for those processes;
  - **no `PR_SET_PTRACER` exceptions** set by any process holding K;
  - **no namespace grant** that gives agents ptrace rights over CLI, authored-child or daemon pids.
  - **E2B:** the posture is unsafe per Native's reported historical probe (run `bace8ad1`,
    2026-10-10, passwordless sudo) and otherwise unknown, so the gate refuses. Not independently
    verified (see the summary note).

  An unknown posture is **not** safe by inference; the sandbox provider's posture is currently
  unknown. This revision authorizes no live probe or sysctl change; the posture is specified, not
  measured.
- **Nonce.** Every `hello` result carries `auth_nonce`: 32 random bytes, hex.
  - It is single-use and bound to that connection.
  - It is consumed by the first `auth.prove` attempt, success or failure.
  - It expires with the connection or after 60 s. A new `hello` replaces it.
- **Proof.** `auth.prove {purpose, mac}`, where
  `mac = hex(HMAC-SHA256(K, "relayflowd-auth-v1" ‖ 0x00 ‖ purpose ‖ 0x00 ‖ nonce))`.
  The daemon compares in constant time.

  | Purpose | Granted to | Response |
  |---|---|---|
  | `journal` | the SDK's journal connection | `{journal_session: J}`, where J is a daemon-minted random id. May `run.start`/`run.resume` the root and admit children. |
  | `worker-peer:<J>` | the worker peer paired with journal session J | `{paired: true}`. May hold root-lineage leases. |

  Both must prove **before** `worker.attach` and `run.start`/`run.resume`. An unauthenticated or
  unpaired `worker.attach` succeeds for ordinary work but never receives a root-lineage lease.
- **Replay refusal.** A MAC for a consumed, expired or other-connection nonce fails, and so does a
  MAC computed for another purpose or another J.
- **Failure codes.** These name the failure and never the material:

  | Code | Meaning |
  |---|---|
  | `auth_failed` | a bad, replayed or wrong-purpose proof |
  | `root_not_authenticated` | a root operation, or the reserved key, from a connection without a journal proof; or an authority mismatch |
  | `parent_not_held` | child linkage failed (§4.3.3) |
  | `credential_unavailable` | an unentitled declaration |
- **Scope and revocation (Q3, decided by the lead).**
  - K serves one root lineage in one daemon lifetime.
  - **Terminality.** The lineage is terminal when the root run **and every linked descendant** have
    a terminal journal fact: completed, failed or canceled. **Parking and waiting are not
    terminal.**
  - **What is revoked, at that event:**
    - K;
    - every authenticated session and paired peer;
    - every cached grant and every credential execution authority.

    None survives revocation: later proofs return `auth_failed`, and later spawns of a declaring
    step return `credential_unavailable`. A daemon exit also revokes everything.
  - **Ordering.**
    1. Every det step's output is redacted (§4.4) **before** its `step.completed` is appended.
    2. The terminal run fact is appended only after all descendant facts.
    3. Revocation takes effect atomically with appending the root lineage's terminal fact, under the
       run lock and **before** the completion response or watch frame is sent.

    So no completion frame or journal entry carries an unredacted value, and no grant is usable
    after the terminal event.
  - A Cloud resume is a new sandbox, so it mints a **new K**. An old or foreign K returns
    `auth_failed`. The restored registry carries lineage, never K.
- **Handling.** K, nonces and MACs are held in memory only. They are never echoed, debug-printed,
  journaled, put in watch or stream frames, checkpointed or registered.

#### 4.3.3 Lease binding and child linkage

- **Leases.** Root-lineage leases go only to the worker peer paired (`worker-peer:<J>`) with the
  root's journal session J. Losing that peer leaves the body undelivered: there is no redelivery to
  other workers, and the run visibly waits.
- **A child links to the lineage only if all of these hold:**
  - (i) it is started on journal session J;
  - (ii) `run.start.parent = {run_id, step_id, attempt, child_id}` names the root body step's
    **current** attempt, whose lease is held by the peer paired with J;
  - (iii) its admission key equals `authoredChildAdmissionKey(parent.run_id, child_id)`
    (`packages/sdk/src/authored-admission.ts:4-10`; published derivation).
- Linkage writes `parent_run_id` (`relayflowd-core/src/entry.rs:217`) at admission. It survives
  restart through the journal. Depth is ≤ 8.
- **Restore.** The registry row for the reserved key, plus journaled linkage, identify the lineage.
  `run.resume` needs a journal proof under the **new** K.

#### 4.3.5 Authenticated ownership of every lineage mutation (J2)

**Today's code.** `run.start` binds the caller's env in its admission callback, and does so even
when admission returns an **existing** run. `run.resume` replaces it. Both happen before
dispatch:
- `kernel/relayflowd/src/server.rs:185-189`: `hub.set_step_env(run_id, env.clone())` inside
  `watch(run_id, existing)`;
- `kernel/relayflowd/src/server.rs:303-305`: `run.resume` calls `hub.set_step_env`.

So an unauthenticated caller who resumes, or re-starts by key, a linked child could replace its
env, for example its `PATH`. That is a **design counterexample, not a demonstrated exploit**.

**Rule.** For any run in an entitled lineage (root or linked child), the following require the
connection to be the lineage's **authenticated owner**:
- `run.resume`;
- an idempotent `run.start` that resolves to an existing run;
- any `env` replacement.

The owner is a journal session proven under the daemon's **current** K for this lineage. The check
happens **before** any registry write, hub change (`set_step_env`, watch registration), env
replacement or dispatch. Refusals:

| Caller | Code |
|---|---|
| unauthenticated | `root_not_authenticated` |
| authenticated, but not this lineage's journal session | `lineage_not_owned` |

Neither changes the bound env.

**Restore authority.** It does **not** require an obsolete live lease. After a daemon restart or
Cloud restore, every pre-restart session and lease is gone. The owner is then whichever journal
session first proves under the **new** K. It may:
- resume the root and any child that the registry and journal link to the root (reserved root key
  plus journaled `parent_run_id`);
- start new children, once its paired peer holds the root body's current attempt (§4.3.3).

Linkage, not a live lease, is the authority for resuming already-linked runs.

**Controls** (`kernel/relayflowd/tests/det_credentials_design/ownership.rs`):

| Case | Expected |
|---|---|
| foreign-session resume | `lineage_not_owned` |
| unauthenticated child resume with `PATH` | `root_not_authenticated` |
| duplicate start (env overwrite) | refused |
| a later probe of the child's env | unchanged |
| a valid owner resume after archive restore under the new K | allowed |

#### 4.3.6 Authored-child session delegation (C1)

**The problem, verified on 2ee558ee (current main).**
- Under Bun the CLI creates journal J and the paired root peer P (`authored-root.ts:109-119`).
- It keeps P's root lease in the parent while running the body through `runAuthoredInNode`
  (`authored-root.ts:327-340`).
- The Node child opens a **new** `JournalClient` (`authored-node-entry.ts:78-79`).

Handing that child K would make J_child just another authenticated session, which §4.3.3 and
§4.3.5 refuse as `lineage_not_owned`.

**Adopted interface:** Native's, at cloud `design/hosted-step-env-boundary` @ `d88b166b` §3, with
one amendment (A1).

1. **Mint.** After spawning the child, the parent calls `session.delegate` on J with:
   - `root_run_id`, `step: "authored-root"`, `attempt_id: A`;
   - `delegate_pid: C`, `delegate_start_time: T` (from `/proc/C/stat`);
   - `ops: ["child.start", "child.resume", "child.read"]`.

   Under the root run lock, the daemon requires all of these:
   - J is authenticated with the current K;
   - J is paired with P;
   - P holds the live lease on exactly `(root, authored-root, A)`;
   - the root is non-terminal.

   It then records the delegation in memory only, with state `unbound`. There is one live
   delegation per (J, A); minting a new one revokes the old.
2. **Hand-off.** The parent puts D in the child's existing stdin request, before any authored
   module loads. D is never logged, journaled or echoed.
3. **Bind.** The child opens J_child, takes a `hello` nonce, and sends
   `auth.delegate {delegation_id, mac: HMAC-SHA256(D, nonce ‖ "authored-child")}`.
   - The daemon additionally requires `SO_PEERCRED` pid == C **and** `/proc/C/stat` start time ==
     T, so a copied D is useless in any other process.
   - D binds exactly one session. A second bind returns `delegation_used`.
   - Platforms without peer-pid credentials refuse delegation.
4. **Narrow operations.** J_child may:
   - `run.start` children keyed `authoredChildAdmissionKey(root, id)`, including det declarations;
   - `run.resume` linked runs;
   - read linked runs.

   It may **not**:
   - start or resume the root;
   - `worker.attach`, or take any lease;
   - delegate further;
   - replace the root's env;
   - touch unlinked runs.

   Every refusal (`lineage_not_owned`) happens before any registry, hub or env mutation.
5. **Liveness on every operation.** Atomically under the run lock, before any mutation, the daemon
   re-checks:
   - D is bound to this session;
   - J is connected;
   - P still leases the same A;
   - the root is non-terminal;
   - K is unchanged.

   Any failure returns `delegation_invalid` and revokes the delegation.
6. **Revocation triggers:**
   - P loses the lease (release, expiry or abandonment);
   - the attempt changes (a retry delegates afresh);
   - the root becomes terminal (§4.3.2);
   - J, P or the delegate disconnects;
   - the daemon restarts;
   - a Cloud resume mints a new K.
7. **Restore stays separate.** Under the new K the CLI re-establishes root ownership (§4.3.5),
   then mints a new delegation for its new child. Earlier children stay linked through the journal,
   and no delegation survives.

**Amendment A1 (generic side): D never crosses the socket.**
- **Problem.** Native's text has the daemon "return D to J alone" and also says D is "never put on
  the wire". The first contradicts the second, and it would put a secret in a protocol response,
  which §4.3.2 forbids for K-derived material.
- **Fix.** `session.delegate` returns only a non-secret `delegation_id`. Both the parent (holding
  K) and the daemon derive `D = HMAC-SHA256(K, "relayflowd-delegation-v1" ‖ 0x00 ‖
  delegation_id)`.
- **What is unchanged:** the child still receives only D (never K), in its stdin request, and still
  binds with `auth.delegate {delegation_id, mac}`. Security is unchanged otherwise, and no new
  secret crosses the socket.
- **For Native:** please adopt A1 in the host doc.

**Controls** (`kernel/relayflowd/tests/det_credentials_design/delegation.rs`, ignored; and the
SDK Bun-parent future test).

| Case | Expected |
|---|---|
| legitimate delegated child admits declaring det work | allowed |
| legitimate delegated child resumes its linked child | allowed |
| independently K-authenticated, undelegated session | refused |
| non-owner mint | refused |
| wrong parent, step or attempt | refused |
| wrong pid | bind refused |
| D replay on a second session | `delegation_used` |
| root resume, `worker.attach` or re-delegation from J_child | refused |
| a stale delegation after P loses the lease | `delegation_invalid`, and no registry admission |

The kernel test's "child" is a second connection of the test process, so pid binding uses that
process's own identity. The real Bun-parent/Node-child path is in
`packages/sdk/tests/det-credentials-live.design.test.ts`, "Bun parent, Node authored child". Like
the other SDK future test, it **cannot count as executing any guard today**: on main it stops at the
absent interface.

#### 4.3.4 What remains unauthenticated

- **Code inside the legitimate CLI after K intake.** The semi-trusted body can admit credentialed
  children, by design.
- **Same-uid ptrace or `/proc/<pid>/mem`.** Not blocked by Yama scope alone. Blocked only under
  the full supported posture of §4.3.2 (scope, no `CAP_SYS_PTRACE`, namespace, no ptracer
  exceptions) or uid separation. That posture is a host gate, not a guarantee.
- **Dynamic child step content.** Only the root authority is pinned.
- **Socket reachability** (L1).

### 4.4 Admission preflight and injection

**At `run.start`**, refuse with `credential_unavailable` if a det step declares N and any of these
holds:
- N is bound and the run is not linked;
- N is withheld;
- N is unbound and absent from the run env.

**At spawn:**
1. Base: the run's `step_env` (F1). A legacy client gets the daemon env.
2. Strip every bound and withheld name.
3. Add the declared bound values if the run is linked. Otherwise fail the step with `worker_error`,
   `failure_detail: "credential_unavailable: <NAME>"`.
4. Add `FLOWS_INPUT` and `RELAYFLOW_MEMORY`.

**Redaction.** Bound values become `[redacted:<NAME>]` in output tails, trajectory and failure
detail, before append.

### 4.5 Withheld names (D2)

- **Host computation.** HOST GATE (Native rev 3 §4).
  - Every agent or house write to the CLI env goes through one tracked writer that records each
    name it sets, **including same-name overwrites**. The withhold set is that record plus
    `HOUSE_PROXY_CREDENTIAL`, with today's floor list included.
  - Plain `keys(cli) − keys(daemon)` is insufficient because it misses overwrites.
  - **A collision with an ordinary repository or delivered name fails the launch.** Otherwise
    withholding would silently drop an ordinary value.
- **Delivery.** The withhold set goes in the frame. The daemon publishes `hello.det_withheld` as
  withheld ∪ bound names, names only.
- **A compliant SDK MUST omit them from `env` on both `run.start` and `run.resume`.** The kernel
  strips them authoritatively at every det spawn.
- **The wire claim, exactly:**
  - a compliant SDK puts no withheld or bound value on the wire (SDK fixture);
  - a nonconforming raw client **can** send its own values; the kernel strips or refuses them but
    **cannot erase incoming bytes**;
  - the kernel guarantees only what it sends back, logs, journals and persists (kernel fixture).

### 4.6 Lifetime and token expiry

- Bound values are static per daemon lifetime.
- **HOST GATE: token expiry** (V3; Native rev 4).
  - The repository-token mint returns a validated `expiresAt`. The Babysitter wrapper currently
    **drops** it.
  - The host must carry that trusted expiry metadata through, and check the actual remaining
    lifetime ≥ budget + margin **at sandbox acquisition and again at bootstrap**, refusing before
    spawn otherwise.
  - The 45-min budget (`packages/web/lib/flows/babysitter-standalone-contract.ts:54`) against an
    assumed 60-min lifetime is **not** sufficient evidence by itself.
- **Future, only if budgets grow:** keep stdin open for `{NAME: newValue}` update frames, which
  need an in-sandbox mint path that does not exist.
- **Dropped (Q1, confirmed by the lead):** the per-spawn file re-read and refresh path for the
  daemon-only token. No renewed file exists for it. **No refresh may be inferred from repository
  token files**, which belong to a different lifecycle (§1). Trusted provider expiry and actual
  remaining-lifetime gates stay (above).

## 5. Wire and kernel changes (additive, feature-gated)

| Surface | Change |
|---|---|
| `hello` | `det_credentials`, `auth_nonce`, `det_withheld` |
| `serve` | `--det-frame-stdin` + frame (§4.1); fail closed |
| new verb | `auth.prove {purpose, mac}` |
| new verbs (C1) | `session.delegate` → `{delegation_id}` (owner J only); `auth.delegate {delegation_id, mac}` (binds one authored-child session, `SO_PEERCRED` pid and start time) |
| spec | deterministic `credentials` |
| `run.start` | `parent {run_id, step_id, attempt, child_id}`; reserved key + authority pin |
| `run.resume`, idempotent `run.start`, `env` replacement | for any run of an entitled lineage (root **or** linked child), require the lineage's authenticated owner, checked before any mutation (§4.3.5); new code `lineage_not_owned` |
| dispatch | root-lineage leases only to the paired peer |
| errors | `auth_failed`, `root_not_authenticated`, `lineage_not_owned`, `parent_not_held`, `credential_unavailable`, `delegation_used`, `delegation_invalid` |
| journal | no new entry types or fields |

## 6. SDK and Surface changes

**Existing behaviour that changes:**
- `f.run(cmd, { credentials })`, failing closed without `det_credentials`. `f.agent` and `f.llm`
  take none.
- `stepEnv()` omits `hello.det_withheld` (required).
- K intake (§4.3.2). The journal connection proves `journal`, and every worker peer proves
  `worker-peer:<J>`, before attach, start or resume.
- Authored children send `parent` with the current attempt and the derived key, on the journal
  connection (paths: `authored-worker-step.ts`, `authored-helper-effect.ts`,
  `authored-plugin-effect.ts`, `authored-mcp.ts`, `authored-budget.ts`).
- The source pin check (§4.3.1).

**Proposed new published interfaces (they do not exist today):**

| # | Interface | Notes |
|---|---|---|
| P1 | `canonicalJsonSnapshot(value): JsonValue` | Exported. Exactly the semantics of today's **private** `jsonSnapshot` (`authored-root.ts:592-596`: a `JSON.stringify` → `JSON.parse` round trip, so `undefined` and functions drop and `toJSON` applies), throwing on a non-serializable value. Composed with the exported `canonicalize`, it is how host and SDK derive the input record identically. |
| P2 | `resolveAuthoredGraph(sources: {path → {sha256, bytes}}, rootPath, pinnedSurface: {packageName, version, installPath})` | Static and **non-executing** (spec below). Returns the exact ordered reachable `[{path, sourceSha256, surface}]` or `unsupported`. Never runs authored code. |
| P3 | `authoredRootAuthority({manifest, rootPath, input, admissionIdentity, extensions, localAgent})` → `{record, digest}` | The full normalized authority (§3 table) built from P1 and P2. CLI form: `flows root-authority <flow> --input <json> --admission-identity <id> --display-fields <ptrs>`, which prints the digest. |

**P2 resolver spec (Q4; Native's answer).**
- **Input (J3; host side at Native `3d7f30b9`).** The host keeps a **content-addressed, read-only
  byte store** (sha256 → bytes), written alongside the manifest at write time. That store is the
  resolver's input. Hashes alone cannot be parsed. The resolver receives trusted write-time source
  **bytes**, keyed by path, from the host's own write record: either the bytes the host wrote, or an
  index of them. Alternatively, the host performs an **immutable read**: it opens each file and
  verifies sha256 of exactly the bytes read against the manifest, **before** graph resolution.
  - Any byte/hash mismatch, missing file or extra unread input → `unsupported`.
  - The resolver never parses bytes it has not verified against the manifest, and never reads the
    working tree.
- **Pinned install.** Cloud installs exactly **one** Surface package per run, pinned by the authority
  (`packageName@version`, sha-verified). P: cloud `bootstrap-inner.mjs:3536-3538`
  (`assertRelayflowV2AuthoredSurfaceAuthority`, then `packageName + '@' + version`);
  `packages/core/src/workflow-launch/relayflow-v2-authored.ts:156`
  (`assertRelayflowV2SurfaceAuthority`).
- **Edges.**
  - The resolver parses each manifest module's **static** import and re-export specifiers. TS
    type-only imports are excluded from edges.
  - It resolves each relative specifier inside the manifest, and requires **every**
    `@relayflows/surface` specifier to resolve to the single pinned `installPath`.
  - Each module's `surface` record is that pinned tuple.
- **Refuse (`unsupported`, so no binding)** on any of:
  - (r1) a nested or alternate copy of the Surface package, e.g. in the bundle's own
    `node_modules`;
  - (r2) a dynamic `import()` or computed `require` of any module or of Surface;
  - (r3) a parse failure or unsupported syntax;
  - (r4) resolution outside the manifest or the pinned install.
- **Spec controls** (unit tests to be written with P2): one case per refusal r1-r4, plus a positive
  case showing that type-only imports add no edge. Graph-equality controls are in
  `root_auth::the_authority_pin_needs_the_exact_resolved_graph_*`.

**YAML is not a runtime exception.** It uses the same `JournalClient`, which sends `env` whenever
`step_env` is listed. The YAML root also sends the reserved admission key (`cli/run.ts:285-291`
sends none today).

**Version tuples.** "Legacy no-env" proves only that no env was sent, **not** foreign-run fencing.

| Tuple (artifact, SDK, daemon features, host) | Behaviour |
|---|---|
| YAML artifacts a32faa2d (run `167d7d34`) and 34e5f906 (run `bace8ad1`), plus the 2.0.43 pin; all pre-#655, `["reported_cost"]` only (Native-reported tuple data) | Steps inherit the daemon env, so **foreign runs inherit it too**. Safe only if no daemon secret is present. **HOST GATE (V2): pre-mint and pre-spawn refusal of any daemon secret for this tuple, including on retry and restore.** Not enforced today: served `launch-runner.ts:657-712` has no tuple exclusion. |
| 2.0.46, `reported_cost` + `step_env` (TS **and** YAML) | D1 and D2. Withdrawn by the host. |
| any tuple without `det_credentials` | A credentialed launch is refused (HOST GATE). |
| next (§4-§6), host with frame + K + tracker | This contract. |

## 7. What a host must do

1. Spawn with `--det-frame-stdin`, write the frame, and close stdin. Never put a daemon-only value
   in daemon env or argv. If the frame write or the start fails, fail terminally.
2. Give K only to the legitimate CLI, on fd 3. Pass the non-secret
   `RELAYFLOW_AUTHORED_ADMISSION_KEY` (derived from the state key; today a random UUID,
   `cli/direct-run.ts:84-85`) and `FLOWS_ROOT_SOURCE_SHA256`.
3. Compute the authority pin with P3, from the host's manifest and P2's exact graph. Refuse on
   `unsupported`.
4. Compute the withhold set with the tracked writer. Fail on a collision.
5. **HOST GATES** (Native rev 3-4), each go/no-go with evidence:

   | Gate | Requirement |
   |---|---|
   | capability gating (§6 tuples) | admit only tuples whose immutable authority-table row declares `det-credentials-v1`/`withhold-v1`; verify the manifest at bootstrap; **unknown, missing or failed detection refuses**; only an explicitly reviewed row may run legacy semantics, and never with a daemon secret |
   | V2 legacy pre-mint / pre-spawn | as above |
   | V3 token expiry | trusted `expiresAt` carried through; remaining lifetime checked at acquisition and at bootstrap |
   | registry restoration | the archive lists the whole state dir except cache dirs (`relayflow-v2-state-archive.ts:38-56`); the data dir is `stateDir/journal` (`relayflow-v2-executor.ts:627`), restored at `:575-622` |
   | exact root and source authority | §4.3.1 |
   | memory posture (J1) | Yama ≥ 1 **and** no `CAP_SYS_PTRACE` for agent, step and authored processes **and** no escalation path **and** no ptracer exceptions **and** no namespace grant; unknown → refuse. **E2B:** refused, because the posture is unsafe per Native's reported historical probe (run `bace8ad1`, 2026-10-10: passwordless sudo) or else unknown. Not independently verified; no image, template, sudo, uid or sysctl change and no live probe is authorized. |
   | V4 consumer epoch | the B consumer-epoch mapping is **proposed** work: today's helper derives only the existing House/project-default epochs. Exact old-consumer refusal needs a future causal spec. |

6. On a Cloud resume: restore the archive, mint a new K, re-supply the frame, and prove with the new
   K.

### 7.1 Which names go where

| Category | Cloud names | Path | Why |
|---|---|---|---|
| **Trusted channel** | `GH_TOKEN` ← `RELAYFLOW_V2_DAEMON_GITHUB_TOKEN`, the exact standalone Babysitter launch only | frame + declaration + lineage | the only daemon-only secret today |
| **Ordinary per-run env** (unchanged, no declaration) | base (`BASE_ENV_KEYS`); repository (`GH_CONFIG_DIR`, `GH_PROMPT_DISABLED`, `GIT_*`, `GITLAB_TOKEN`, `RELAYFLOW_V2_GITLAB_API_URL`, `RELAYFLOW_V2_REPOSITORY_DIR/JSON`, the grant `PATH`); delivered (`RELAY_SECRET_ENV_NAMES` and its entries) | `step_env` (F1) | equal in both envs. Binding would reserve them and break undeclared steps, with no confidentiality gain. |
| **Withheld** | tracked agent and house writes (`AGENT_ENV_KEYS`, the house pickup keys, `HOUSE_PROXY_CREDENTIAL`, the floor list) | frame `withhold` + SDK omission + kernel strip | agent-only |

**Worked example, Babysitter:**

```
relayflowd ... serve --det-frame-stdin
stdin: {"credentials": {"GH_TOKEN": "<minted>"}, "capability": "<K>",
        "pins": {"root_authority_sha256": "<P3 digest>", "display_fields": ["/name", "/steps/0/instruction/flowName"],
                 "root_admission_key": "authored-root:<sha256(state-derived identity)>"},
        "withhold": [<tracked writes>, "HOUSE_PROXY_CREDENTIAL"]}
CLI fd 3: K
```

**Repository-grant run:** no credentials, the withhold set only. git and gh keep their files.

**Owners:**

| Owner | Owns |
|---|---|
| flows kernel | frame, proofs, authority digest, leases, linkage, strip, redact |
| flows SDK | K intake, proofs, omission, P1-P3 |
| host (Native) | frame, K, manifest, tracker, gates, containment |
| flow author | declarations |

## 8. Limits (stated, not claimed)

- **L1. Same-uid socket reachability.**
  - **Mitigated:** reachability gives no credential authority.
  - **Not mitigated:** agents can read journals and run unentitled det steps with their own env.
  - Host mitigation: uid or mount separation.
- **L2. `/proc` exposure.**
  - **Mitigated:** values are not in the daemon's environ or cmdline, and K is in neither.
  - **Still exposed:** an entitled det step's environ while it runs, and daemon and CLI memory to
    same-uid ptrace unless the full §4.3.2 posture holds (scope ≥ 1 alone is not enough).
  - stdin delivery hardens the daemon's own exposure. It is **not a boundary for steps**.
- **L3. Transformed values** (base64, split, reversed) escape substring redaction.
- **L4. A semi-trusted body renaming values.** It can copy an agent value under an unwithheld
  name.
- **L5. An entitled step can write or exfiltrate its own credential.**
- **L6. "No files" means kernel and SDK persistence only.** It does not cover env dumps outside the
  data dir (the fixture writes some, deliberately), or anything an entitled step writes.
- **L7. A raw client's own outgoing bytes** (§4.5).
- **L10. E2B posture: unsafe per a reported historical probe, or unknown.** Native's run
  `bace8ad1` (2026-10-10) reported passwordless sudo, under which agents could escalate to root and
  read any memory. This is not independently verified for the current image. The J1 gate
  fails closed on that unsafe-or-unknown posture and refuses binding. This design closes nothing
  here, and authorizes no image, template, sudo, uid or sysctl change and no new live probe.
- **L9. The authored body shares a heap with K.** The semi-trusted authored body runs in the
  same process as the authored child's copy of K. The SDK keeps K in a closure, but that is **not
  a hard boundary**.
- **L8. The root authority is complete only together with P2.** Without the resolver's exact graph,
  a supplied `sources[]` proves records, not completeness, which is why P2 is mandatory and
  `unsupported` refuses.

## 9. Explicitly NOT done

- No credential in the CLI, agent or LLM env, or in dispatch.
- No CLI env stripping.
- No daemon-env merge.
- No runtime pin.
- No GitHub logic in the kernel.
- No implementation, publish, re-pin, release or activation.

## 10. Alternatives and interim options

1. **`serve --step-env daemon`** (flows `fix/hosted-step-env-policy` @ `93f0cda8`; cloud @
   `eb338424`). **Lead verdict: NOT ACCEPTED.**
   - The data-dir lock limits daemon processes, not protocol runs, so an env-free agent-started run
     still gets `daemonEnv`/`GH_TOKEN`.
   - A missing or failed help probe returns the unsafe old spawn.
   - There is no lineage or per-step entitlement.
2. **2.0.43 pin.** Forbidden, and foreign runs get the token (§6).
3. **Re-add `GH_TOKEN` to the CLI.** Rejected: agents get a write token.
4. **Daemon-env merge.** Forbidden.
5. **Daemon-scoped entitlement.** Rejected (T2).
6. **Key-only, first-writer, first-dispatch or supplied-graph-only root.** These are not
   authentication or completeness. Rejected.
7. **Value in input, or a token file.** Input is journaled, and the file is agent-readable.
   Rejected.
8. **Widen #596's fd channel for D2.** Withholding is recommended instead (Native). Kept as later
   hardening.
9. **Per-spawn file re-read.** Dropped (§4.6, Q1).
10. **K sent on the wire.** Rejected in favour of challenge-response.
11. **Gate-8 proxy.** The end state; this design is compatible with it.

## 11. Release and containment (D6; host-owned)

- **Never overwrite an existing immutable tuple.** The current 2.0.46 artifact has no policy or
  credential flag. Source patches fix neither admitted 2.0.46 tuples nor queued jobs. Ship a
  **matched new tuple**: package, runtime artifact whose manifest declares the capabilities, and a
  host change gated on it.
- **The served launch transport is CF-native, not SQS.** Verified in cloud `origin/main`
  `7bda9a145`:
  - **Transport.** `infra/workflow-launch-cf-queue.ts:11-27` says it is "the only durable launch
    transport", with "no SQS fallback". The run route refuses new launches when the flag is off,
    and the stuck-run reaper also produces into this queue.
  - **Thin consumer.** The queue handler is `packages/web/lib/workflows/launch-queue-consumer.ts`
    (`infra/workflow-launch-cf-queue.ts:76-95`). It carries no launcher deps and forwards each
    message over the `CLOUD_WEB` service binding to `/cloud/api/v1/internal/workflow-launch/step`
    (`launch-queue-consumer.ts:25,111-120`).
  - **Shared parsers.** That route (`packages/web/app/api/v1/internal/workflow-launch/step/route.ts:8-12,90-93`)
    calls the shared `processWorkflowLaunchQueueRecord` (launch-worker), or
    `processWorkflowLaunchDlqRecord` for `disposition: "dlq"`. The consumer-epoch check lives there
    (`launch-worker.ts:619-623`, `relayflow_v2_consumer_epoch_mismatch`).
  - **Terminalization and quarantine.**
    - The DLQ consumer acks only after cloud-web commits the terminal job and run
      (`launch-queue-consumer.ts:147-160`).
    - Exhausted DLQ deliveries go to a durable terminalization queue
      (`infra/workflow-launch-cf-queue.ts:42-58`).
    - Undecodable records are retained, never acked (`launch-queue-consumer.ts:129-145`), and go to
      a 14-day quarantine (`infra/workflow-launch-cf-queue.ts:61-75`).
- **Fences on that path**, each against an explicit withdrawn-authority list:

  | Fence | Where | Rule |
  |---|---|---|
  | producer | run route (new admission and resume) | refuses |
  | internal launch step | `processWorkflowLaunchQueueRecord`, at the epoch check, reached via the thin consumer for every primary delivery, retry and reaper re-enqueue | refuses; this is the single shared consumer gate |
  | DLQ / terminalization | `processWorkflowLaunchDlqRecord` | terminalizes only; **never launches** a withdrawn tuple; idempotent by job and run |
  | quarantine redrive | operator redrive passes through the same internal step | the same fence applies |
  | launch runner | before **every** sandbox-acquisition branch: warm-pool borrow, resume of a provisioning sandbox, label adoption | refuses |
  | bootstrap | inside the sandbox | manifest and tuple check before spawn |
- **Rolling order (J5; aligned with Native `3d7f30b9`).**
  1. Make all three consumers B-aware: the CF consumer Worker, the cloud-web launch-step handlers,
     and the reaper Lambda.
  2. Bootstrap verification ships with them.
  3. A **producer HOLD** stays in place until all three are B-aware. The producer and pin change
     ship last.
- **Schema and epoch.** B persists a **new `schemaVersion` and a B consumer epoch** (proposed).
  Today's authority parser already requires an exact match on both, `root.schemaVersion ===
  expectedSchemaVersion` and `root.consumerEpoch === expectedEpoch` (P:
  `packages/core/src/workflow-launch/relayflow-v2-authority.ts:205-222`). So an old consumer's
  parser refuses a B envelope, and an old reaper's recomputation cannot make it acceptable. Later
  tuple gates still apply.
- **HOST GATE: reaper relabel (W2; Native @ `44add524`).**
  - **Confirmed:** the reaper recomputes the epoch with its own code when it re-enqueues
    (`packages/core/src/sync/stuck-run-reaper-core.ts:1246-1255`).
  - With B's new `schemaVersion` and epoch, an old parser refuses the envelope (above). Beyond
    that, whether an old consumer would execute a relabelled B job is **conditional**. It depends
    on whether that consumer's persisted schema and authority parsing accept the B envelope, and
    then on the later tuple gates. **It is not proven merely because extra fields are tolerated.**
  - Mitigation (Native): rolling order; drain before rollback; an optional transitional
    `relayflow_version` fence. No kernel change is needed.
- **Rollback** keeps the withdrawn-authority list. It never automatically re-admits 2.0.46.
  Re-enabling 2.0.46 needs its own explicit lead risk decision.

## 12. Resolved questions

- **Q1 (lead):** the file re-read is dropped; the expiry gates are kept (§4.6).
- **J1-J5:** the memory posture (E2B refused: unsafe per a reported historical probe, or unknown), ownership of every lineage mutation,
  the resolver byte store, the pipe-evidence limit, and CF-only containment with schema/epoch and
  producer HOLD. Aligned with Native `3d7f30b9`.
- **C1:** the authored-child delegation is adopted from Native (`d88b166b`), with amendment A1
  (§4.3.6). It supersedes the "fresh pipe with K" text.
- **Q2 (Native):** the fd-3 transport, synchronous intake, the authored child's hand-off (now D,
  not K), and the
  memory-posture host gate (§4.3.2, corrected by J1: Yama scope alone is insufficient). L9 is
  stated.
- **Q3 (lead):** revocation at terminal lineage completion, including descendants, failure and
  cancellation; parking is not terminal; with the stated ordering (§4.3.2).
- **Q4 (Native):** the static resolver against the single pinned Surface install, with refusals
  r1-r4 (§6 P2).

The lead's freeze acceptance of `5eb22527` and Native's `44add524` is pending.

## 13. Review-finding map

| Finding | Where | Fixture |
|---|---|---|
| D1 authority | §4.3 | `root_auth::*`, `entitlement::authored_child_*` |
| D2 wire | §4.5, §8 L7 | SDK `det-credentials.design.test.ts`; `leaks::*` |
| D3 Native's policy; fail-closed gating | §10.1, §7 item 5 | `root_auth::a_daemon_without_a_complete_frame_*` |
| D4 categories; tracked withhold | §7.1, §4.5 | `leaks::det_steps_never_receive_*` |
| D5 evidence | §1.1, §14 | `current_behaviour`; SDK live tests; `lifecycle::*` |
| D6 containment (incl. W2 reaper relabel) | §11 | host specs |
| (1) separate pins; per-connection authentication | §4.3.1, §4.3.2 | `root_auth`, `k_handling` |
| (2) K protocol | §4.3.2 | `k_handling::*`; SDK live K-descriptor asserts |
| (3) YAML not exempt; tuples | §6 | spec |
| (4) overwrites; SDK application | §4.5 | SDK wire test |
| (5) fences; rollback | §11 | host specs |
| (6) repository vs daemon-only | §1 | — |
| V1 full authority; exact child lease; P1 | §3, §4.3.1, §4.3.3, §6 | `root_auth::the_authority_pin_*`, `entitlement::authored_child_*` |
| V2-V4 | §6, §7 HOST GATES | host specs |
| Q2-Q4, CF containment | §4.3.2, §6 P2, §11 | SDK live K asserts; P2 and runner unit specs (future) |
| J1-J4 | §4.3.2, §4.3.4, §4.3.5, §6 P2, §14 | `ownership::*`; evidence limit stated |
| C1 authored-child delegation | §4.3.6 | `delegation::*`; SDK Bun-parent future test |
| W1 graph completeness | §4.3.1, §3, §8 L8 | `root_auth::the_authority_pin_needs_the_exact_resolved_graph_*` |

## 14. Fixture and evidence

**What the failures mean.** The future-contract tests all fail on main because **the interface is
absent**. Each one hits one of:
- `unknown field "credentials"` when parsing the pinned root;
- `unexpected argument '--det-frame-stdin'`;
- `hello` without `det_credentials`;
- the missing `flows root-authority`;
- today's SDK sending all of `process.env`.

They are **not** separate security regressions. Main's actual defects are what §1.1 reproduces.

**Kernel** (`kernel/relayflowd/tests/det_credentials_design.rs` plus
`det_credentials_design/{harness,contract,current_behaviour,delegation,entitlement,ownership,root_auth,k_handling,lifecycle,leaks}.rs`):
- 1 current-behaviour test, not ignored.
- 20 future tests, `#[ignore = "... det_credentials interface absent"]`.

**Evidence limit (J4).** The future SDK live test hands K to the CLI through an **unlinked,
seekable file** opened on fd 3, not a pipe. It therefore **cannot** prove real pipe-inode aliasing,
EOF-after-writer-close, or inheritance semantics. Its descriptor asserts are path checks against
that file. Once the interface exists, the gate requires:
- a **real pipe-backed** causal fixture: the host writes K and closes the writer, and the test
  checks `pipe:[inode]` aliases in every descendant;
- the **fresh authored-child pipe** checks.

The current forced failures remain interface-absence failures.

**SDK** (`packages/sdk/tests/`):
- `det-credentials.design.test.ts`: real `JournalClient` wire, every fake agent key and a bound
  name.
- `det-credentials-live.design.test.ts`: current main (not skipped) and the future contract,
  including the K descriptor and env checks.
- The future tests are skipped unless `FLOWS_DESIGN_FIXTURES=1`.

**After implementation**, a green run is not sufficient. **Each security guard needs its own causal
mutation**, captured per AGENTS.md: revert the guard, capture the failure, restore it, capture the
pass.

## Source receipt

No running system was touched.

- **flows** `origin/main` `2ee558eeeefb99fd37428667746814ca3ab3f486`:
  - #655 `edc9f5b43c7a6854c9bb38bac0121ae0860a50f1` / `acb9c2ce4236d25387c30099da406933eca6f200`;
  - #596 `5b9cb46920ff41978bc8f8dd696dea4c1e631731`.
- **cloud** `origin/main` `7bda9a145a3f32540bad0c04501311292f20ad50`:
  - `packages/core/src/bootstrap/lib/{relayflow-v2-step-env,relayflow-v2-executor,relayflow-v2-repository,relayflow-v2-repository-token,relayflow-v2-state-archive}.ts`
  - `packages/core/src/auth/proxy-token.ts`
  - `packages/web/lib/workflows/launch-runner.ts`
  - `packages/web/lib/flows/babysitter-standalone-contract.ts`
- **Native** (interface reference, not reviewed):
  - flows `fix/hosted-step-env-policy` @ `93f0cda855376538b3667befa20115f05cd16c20`;
  - cloud `design/hosted-step-env-boundary` @ `eb338424`, `900df5ae`, `eb2f4786`,
    `a903e8f83e7340ed678c52860420f8ec106384ea`, `41cc8cb3`, `44add524`, `e4cd859e`, `24c37812`, `3d7f30b9`, `d88b166b` (C1 delegation source).
