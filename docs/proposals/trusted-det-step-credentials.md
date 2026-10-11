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

- **Minting and SDK intake.** The host mints K (`randomBytes(32)`) per daemon lifetime and gives it
  to the daemon in the frame, and to the legitimate CLI on an **inherited pipe, fd 3**
  (`FLOWS_CREDENTIAL_ROOT_PROOF_FD=3`). Before loading any authored module or spawning any child,
  the SDK:
  - reads fd 3 to EOF and `close()`s it;
  - deletes the env name;
  - keeps K in memory only.
- **Descriptor controls.** Node opens fds close-on-exec unless listed in `stdio`, and the SDK never
  lists or dups K's descriptor.
  - No descriptor in any agent or det child may alias the pipe (`pipe:[inode]`).
  - A surviving alias reads EOF, because the content is consumed and the host closed the writer.
  - The fixture asserts that the agent has no fd to K's source and that no child env carries K or
    the fd name.
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
- **Scope and revocation.**
  - K serves one root lineage in one daemon lifetime.
  - It is revoked, along with every proof-derived trust, when the root lineage completes or is
    canceled, or when the daemon exits.
  - A Cloud resume is a new sandbox and a new daemon, so it mints a **new K**. Old or foreign K
    produces `auth_failed`.
  - The restored registry carries lineage, never K.
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

#### 4.3.4 What remains unauthenticated

- **Code inside the legitimate CLI after K intake.** The semi-trusted body can admit credentialed
  children, by design.
- **Same-uid ptrace or `/proc/<pid>/mem`.** Blocked only under Yama `ptrace_scope ≥ 1` or uid
  separation. That is a host assumption.
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
- **Dropped:** per-spawn file re-read (revision 2). No renewed plain file exists for the
  daemon-only token, and the repository grant does not use this channel. This reverses the lead's
  earlier "keep" (Q1).

## 5. Wire and kernel changes (additive, feature-gated)

| Surface | Change |
|---|---|
| `hello` | `det_credentials`, `auth_nonce`, `det_withheld` |
| `serve` | `--det-frame-stdin` + frame (§4.1); fail closed |
| new verb | `auth.prove {purpose, mac}` |
| spec | deterministic `credentials` |
| `run.start` | `parent {run_id, step_id, attempt, child_id}`; reserved key + authority pin |
| `run.resume` | of the root, requires a journal proof |
| dispatch | root-lineage leases only to the paired peer |
| errors | `auth_failed`, `root_not_authenticated`, `parent_not_held`, `credential_unavailable` |
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
| P2 | `resolveAuthoredGraph(manifest: {path → sha256}, rootPath, surfaceResolver)` | Static and **non-executing**. Returns the exact ordered reachable `[{path, sourceSha256, surface}]`, or `unsupported` (dynamic import, unresolved specifier). Never runs authored code. |
| P3 | `authoredRootAuthority({manifest, rootPath, input, admissionIdentity, extensions, localAgent})` → `{record, digest}` | The full normalized authority (§3 table) built from P1 and P2. CLI form: `flows root-authority <flow> --input <json> --admission-identity <id> --display-fields <ptrs>`, which prints the digest. |

**YAML is not a runtime exception.** It uses the same `JournalClient`, which sends `env` whenever
`step_env` is listed. The YAML root also sends the reserved admission key (`cli/run.ts:285-291`
sends none today).

**Version tuples.** "Legacy no-env" proves only that no env was sent, **not** foreign-run fencing.

| Tuple (artifact, SDK, daemon features, host) | Behaviour |
|---|---|
| a32faa2d / 2.0.43, `["reported_cost"]` | Steps inherit the daemon env, so **foreign runs inherit it too**. Safe only if no daemon secret is present. **HOST GATE (V2): pre-mint and pre-spawn refusal of any daemon secret for this tuple, including on retry and restore.** Not enforced today: served `launch-runner.ts:657-712` has no tuple exclusion. |
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
    same-uid ptrace without Yama.
  - stdin delivery hardens the daemon's own exposure. It is **not a boundary for steps**.
- **L3. Transformed values** (base64, split, reversed) escape substring redaction.
- **L4. A semi-trusted body renaming values.** It can copy an agent value under an unwithheld
  name.
- **L5. An entitled step can write or exfiltrate its own credential.**
- **L6. "No files" means kernel and SDK persistence only.** It does not cover env dumps outside the
  data dir (the fixture writes some, deliberately), or anything an entitled step writes.
- **L7. A raw client's own outgoing bytes** (§4.5).
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

## 11. Release and containment (D6; host-owned, Native rev 3 §7)

- **Never overwrite an existing immutable tuple.** The current 2.0.46 artifact has no policy or
  credential flag. Source patches fix neither admitted 2.0.46 tuples nor queued jobs. Ship a
  **matched new tuple**: package, runtime artifact whose manifest declares the capabilities, and a
  host change gated on it.
- **Rolling order:**
  1. consumers first, with bootstrap verification;
  2. producer last.
- **Fences**, each against an explicit withdrawn-authority list:

  | Fence | Rule |
  |---|---|
  | producer (run route) | refuses new admissions and resumes |
  | queue consumer | refuses at the epoch check; covers retries and reaper re-enqueues |
  | launch runner | refuses before **every** sandbox-acquisition branch: warm-pool borrow, resume of a provisioning sandbox, label adoption |
  | bootstrap | manifest and tuple check before spawn |

  Old-consumer refusal via a new consumer epoch is **proposed** (V4).
- **HOST GATE: reaper relabel (W2; Native @ `44add524`).**
  - **Hazard.** The stuck-run reaper recomputes the consumer epoch with its own code when it
    re-enqueues (cloud `packages/core/src/sync/stuck-run-reaper-core.ts:1246-1255`,
    `consumerEpoch: relayflowV2LaunchConsumerEpoch(authority)`). An **old** reaper could relabel a
    B job and let an old consumer execute it.
  - **Mitigation (Native):**
    - rolling order (reapers ship with consumers);
    - drain before rollback;
    - an optional transitional `relayflow_version` fence.
  - No kernel change is needed.
- **Rollback** keeps the withdrawn-authority list. It never automatically re-admits 2.0.46.
  Re-enabling 2.0.46 needs its own explicit lead risk decision.

## 12. Open questions

- **Q1 (lead).** Confirm dropping the per-spawn file re-read (§4.6).
- **Q2 (Native).** The fd-3 pipe semantics and the Yama assumption. The transport is specified,
  **not** approved.
- **Q3 (lead).** Revoke K at root completion (as specified), or at daemon exit only?
- **Q4 (Native).** P2's surface resolution: how does the resolver map a node to its Surface tuple
  without executing it?

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
`det_credentials_design/{harness,contract,current_behaviour,entitlement,root_auth,k_handling,lifecycle,leaks}.rs`):
- 1 current-behaviour test, not ignored.
- 17 future tests, `#[ignore = "... det_credentials interface absent"]`.

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
    `a903e8f83e7340ed678c52860420f8ec106384ea`, `41cc8cb3`, `44add524`.
