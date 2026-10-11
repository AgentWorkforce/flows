# Proposal: a trusted credential channel for deterministic steps

- **Status:** proposal only. Nothing here is implemented, published or activated.
- **Wire feature:** `det_credentials` in `hello.features`, gated the same way as `step_env`.
- **Regression fixture:** `kernel/relayflowd/tests/det_credentials_design.rs` (with
  `det_credentials_design/harness.rs`). It is `#[ignore]`d with the reason, and it fails on current
  main (see the PR or branch notes).
- **Scope split:** this document defines the **generic flows contract**: kernel, wire, spec and
  SDK. "Native" (native-sandbox-env) owns the Cloud host integration and admission containment.
  §7 lists exactly what a host must do. Questions for Native are in §11, and this document does not
  decide them.
- **Based on:** flows `origin/main` @ `2ee558ee`, cloud `origin/main` @ `7bda9a145`. The receipt is
  at the end.
- **Direction:** 1 (a narrow, trusted channel), chosen by the lead (codex-cloud-b6eefa).

## 1. Problem: #655 broke the boundary in both directions

flows#655 (`acb9c2ce`, merged `edc9f5b4`, released in v2.0.46) fixed F1. Before it, a shared daemon
spawned every run's `f.run` steps in the env of whichever CLI started it. Now:

- `packages/sdk/src/journal-client.ts:135,144,154-161`. `stepEnv()` sends **all of the CLI's
  `process.env`** on `run.start` and `run.resume` when the daemon lists `step_env`.
- `kernel/relayflowd/src/server.rs:172` advertises `step_env`. Lines `:188` and `:304` bind the env
  to the run id.
- `kernel/relayflowd/src/engine/drive.rs:166-175` and `kernel/relayflowd/src/exec_det.rs:77-80`:
  `process.env_clear(); process.envs(env.vars());`

So the deterministic step's env is now exactly the CLI's env. In Cloud, the CLI's env and the daemon's
env differ on purpose (`cloud packages/core/src/bootstrap/lib/relayflow-v2-step-env.ts`):

- `:215-216`: `daemonEnv = { ...delivered, ...base, ...repository }`. These are delivered secrets
  (workspace vars and `envSecrets`), base system vars, and the repository grant's git/gh vars.
- `:217-218`: `daemonEnv.GH_TOKEN = RELAYFLOW_V2_DAEMON_GITHUB_TOKEN`, which is minted by
  `cloud packages/web/lib/workflows/launch-runner.ts:684-707` "only in relayflowd's environment".
- `:219`: `cliEnv = { ...daemonEnv, ...pick(bootstrapEnv, AGENT_ENV_KEYS) }`. `AGENT_ENV_KEYS`
  (`:122-136`) is:
  - `CLAUDE_CODE_OAUTH_TOKEN`
  - `CLAUDE_CONFIG_DIR`
  - `CODEX_HOME`
  - `ANTHROPIC_API_KEY`
  - `ANTHROPIC_BASE_URL`
  - `OPENAI_API_KEY`
  - `OPENAI_BASE_URL`
  - `OPENAI_API_BASE`
  - `OPENROUTER_API_KEY`
  - `GOOGLE_API_KEY`
  - `GOOGLE_API_BASE`
  - `RELAY_BASE_URL`
  - `RELAY_AGENT_TOKEN`
- `:249`: a house-proxy run adds `houseProxyCliPickup(credential).env` to `cliEnv`. This is
  `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`XAI_API_KEY`… plus base URLs
  (`packages/core/src/auth/proxy-token.ts:323-337`).
- `:223`: `delete cliEnv.GH_TOKEN`. The comment says the `f.agent` child "must never inherit that
  write-capable token".
- `relayflow-v2-executor.ts:728-736` builds `childEnv = { ...cliEnv, PATH: … }`. Lines `:976` and
  `:1019` spawn the flows CLI with it. Lines `:840-846` spawn `relayflowd` with `daemonEnv`. The
  comment at `:863` ("it drops the GH_TOKEN `f.run` inherits from the daemon env") describes the
  pre-#655 behaviour.

On a runtime ≥ 2.0.46 under Cloud, this gives two defects:

- **D1. Lost entitlement.** Det steps no longer get `GH_TOKEN`. Every Babysitter GitHub `f.run`
  throws `GH_TOKEN required` or sends an empty bearer. The call sites are:
  - `examples/babysitter/fix.ts:42`
  - `merge.ts:18`
  - `signals.ts:52,169,186,212`
  - `github.ts:78`
  - the bundled `artifacts/babysitter-fixer.flow.ts:164,316,605,672`
- **D2. Agent-key exposure.** Det steps now **receive** the agent-only keys above. Det steps run
  arbitrary repository code (`npm ci` install scripts, test suites:
  `examples/babysitter/workspace.ts:18`). Before #655 they got only `daemonEnv`, which has none of
  these keys.

flows already has a generic agent-only channel that would keep these keys out of `process.env`:
`FLOWS_LOCAL_AGENT_ENV_FD` (`packages/sdk/src/local-agent-environment.ts:3-16`, #596, runtime
capability `local-agent-env-fd-v1`). It accepts only four names (`ANTHROPIC_API_KEY`,
`ANTHROPIC_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`). Cloud does not use it:
`git grep FLOWS_LOCAL_AGENT_ENV_FD` on cloud `origin/main` finds nothing.

The repository-grant path is not affected. `relayflow-v2-repository.ts:210` deletes `GH_TOKEN`, and
git and gh read the token from files under `GH_CONFIG_DIR`, which is in both envs.

The underlying gap: flows has **no contract** by which a trusted host says either of these:

- "this run's deterministic steps are entitled to credential X";
- "deterministic steps must never see name Y".

The old daemon-env inheritance supplied both by accident. F1 removed it on purpose.

## 2. Threat model

**Trusted:**
- The host that spawns `relayflowd` (Cloud bootstrap, or a developer's shell).
- The kernel and its memory.

**Semi-trusted:**
- The authored flow body, which runs in the CLI process. It composes det steps and holds the agent
  login by Cloud's design (`relayflow-v2-step-env.ts:31-37`).

**Untrusted:**
- Agent and LLM steps, including the `f.agent` CLI child.
- Repository code run by det steps.
- Other runs on the same daemon.
- Any process that only reaches the socket. Cloud gives the agent `RELAYFLOW_DATA_DIR` and
  `RELAYFLOW_RUN_ID` (`relayflow-v2-executor.ts:715-727`), so **socket reachability must confer no
  credential authority.**

| # | Attack | Defence (section) |
|---|---|---|
| T1 | An agent or LLM step, or the `f.agent` child, reads a det credential. | It is injected only into `exec_det` children (§4.4). The spec refuses `credentials` on llm/agent steps (§4.2). The value never enters the CLI env. |
| T2 | Another run on the daemon, including one an agent starts over the socket, gets it. | Entitlement is server-derived from lineage (§4.3). Nothing in `run.start` grants it. |
| T3 | Spoofed scope: forged `credentials`/`root` params, a forged `parent`, a bound name in `run.start.env`/`run.resume.env`, or step input. | `deny_unknown_fields`. `parent` is checked against the requesting connection's live lease. Bound names are stripped from caller env. Input is never read. |
| T4 | Restart or resume widens or resurrects a binding. | No value is persisted. Each start takes its binding only from the host. Lineage comes from value-free journal and registry facts. |
| T5 | A value leaks to the journal, wire, logs, checkpoints or files. | Values are resolved by name from the daemon's own spawn env, which the host already holds. No value crosses the socket. The binding is not `Serialize`. Step output is redacted before append. `Debug` redacts. |
| T6 | F1 regresses (cross-run env). | No env merge. Base env stays exactly the run's `step_env`. |
| **T7** | **A det step receives agent-only keys (D2).** | **Host-declared withheld names are stripped from every det step env, by the kernel, at spawn (§4.5). A caller cannot re-add them.** |

## 3. Answers to Native's questions

**(a) How a step gets a credential: a capability or env?**
- It gets **env**. At spawn, the kernel copies a value into the entitled det step's process env
  under the declared name. The value is one the host already put, **by name**, in the daemon's own
  spawn env. Cloud already holds it there (`relayflow-v2-step-env.ts:215-218`; spawn at
  `relayflow-v2-executor.ts:840-848`).
- The host passes **names only**, as argv. No value crosses the socket or the wire.
- The kernel binds the name to one exact root run and its lease-verified children, and narrows it
  per step by declaration.
- Per-step host-minted capabilities are impractical for the host: run ids are minted by the daemon
  at `run.start`, and children use authored admission keys. So the per-run authority is
  **daemon-derived** (§4.3), and the host only declares names and a root key.
- **The alternative, a per-step opaque capability redeemed against a service, is rejected for
  now.** It needs a redeem endpoint, which is the gate-8 credential proxy. GitHub tooling
  (`git` extraheader, `gh`, `curl`) and the Babysitter code read env.
- The name-and-declaration shape is forward-compatible with a proxy later.

**(b) What the kernel verifies.**
- **Run binding.** The root is the run whose registry admission key equals the host's
  `--det-credential-root`. A child is entitled only if it was admitted with a `parent` whose
  `(run_id, step_id, attempt)` lease is held **by the very connection sending `run.start`**.
- **Agent-origin `run.start`.** The kernel cannot see "agent origin". It sees authority, and an
  agent on the socket has none:
  - Reusing the root admission key yields the existing root, or a spec-hash refusal. It never
    creates a new entitled run.
  - Without the root body's lease it cannot parent a child (`parent_not_held`).
  - Its det steps that declare a bound name are refused (`credential_unavailable`).
  - Undeclared steps have bound names stripped.
- **Restart.** The binding is re-declared by the host at each start, with the same argv and spawn
  env. Cloud restarts with the same spawn env, so the binding is restart-stable. Lineage is recomputed from durable, value-free facts. A daemon started
  without the binding makes declared steps fail closed.
- The stolen-lease limit is in §8 (L3).

**(c) Does it need SDK and wire changes?** Yes, both are additive and feature-gated (§5, §6).
- **Wire:**
  - `serve` flags (names only);
  - the spec field `credentials`;
  - `run.start.parent`;
  - two error codes;
  - `det_credentials` in `hello.features`.
- **SDK:**
  - the `f.run` `credentials` option;
  - child admission on the lease-holding connection with `parent`;
  - an admission key on the YAML root;
  - a feature check.

## 4. Design

### 4.1 Host binding at daemon start

```
relayflowd --data-dir D serve \
  [--det-credential NAME]...  [--det-credential-root ADMISSION_KEY] \
  [--det-withhold NAME]...
```

- **Names, root and withheld names are in argv.** They are not secret, and they are auditable.
- **Bound values are resolved by name from the daemon's own spawn env**, once, at startup. They are
  copied into the in-memory binding. Values never cross the socket and are never written to the
  data dir.
- **Startup is fail-closed.** The daemon exits non-zero before binding the socket, with messages
  that name keys only, if any of these hold:
  - an invalid name (`^[A-Z_][A-Z0-9_]*$`);
  - a kernel-owned or loader name (`FLOWS_INPUT`, `RELAYFLOW_MEMORY`, `PATH`, `LD_*`, `DYLD_*`);
  - a name that is both bound and withheld;
  - a bound name that is absent from the daemon's env;
  - a value that is empty, shorter than 8 bytes (redaction must be unambiguous), or contains NUL;
  - `--det-credential-root` without bound names, or bound names without a root.
- Because the value stays in the daemon's own env, a step that inherits the daemon env must not
  get it. The legacy pre-`step_env` client path is covered by §4.4 step 2, which strips bound names
  from **any** base env. Closing the daemon's `/proc/<pid>/environ` would need a stdin delivery
  form instead (N8).
- `exec_det` sets `stdin(Stdio::null())`. Today a det child inherits the daemon's stdin, because
  `exec_det.rs:91` pipes only stdout and stderr. This is hygiene, and it costs nothing.
- **No flags means today's behaviour, unchanged.**
- **Placement.** New module `kernel/relayflowd/src/det_credentials.rs` holds
  `DetCredentials { bound: BTreeMap<name, value>, root: String, withheld: BTreeSet<name> }`. It is
  held in `ProtocolHub`, is not `Serialize`, and its `Debug` prints names only. There is no
  provider logic: it handles opaque named strings.

### 4.2 Per-step declaration

```json
{"id": "checkout", "type": "deterministic", "command": "…", "credentials": ["GH_TOKEN"]}
```

- The field is added to `STEP_DETERMINISTIC_FIELDS` (`relayflowd-core/src/spec.rs:382`) and to
  `StepKind::Deterministic`, with `skip_serializing_if = "Vec::is_empty"`. Existing specs keep their
  bytes and hash.
- Values are sorted, unique, and use the §4.1 grammar. The journal carries names only.
- It is **not** added to the llm or agent field sets. There it stays an `unknown field` refusal,
  which is today's behaviour (T1).
- Declaration only narrows. An undeclared name is never injected.

### 4.3 Entitlement: exact, server-owned authority

A run R is entitled if and only if one of these holds:

- **(a)** The registry's `run_admissions` row (`relayflowd-journal/src/registry.rs:133`) for R has
  `admission_key == root`.
- **(b)** `run.spawned.parent_run_id` names an entitled run. The field already exists at
  `relayflowd-core/src/entry.rs:217` and is always `None` today. Depth is bounded to 8.

`parent_run_id` is written only when `run.start` carries
`"parent": {"run_id", "step_id", "attempt"}` **and** the sending connection holds that live lease.
`ProtocolHub` tracks assignments per connection. Otherwise the daemon refuses with
`parent_not_held`.

The check runs **before** the admission row is written, so a refused key stays unused.

A journaled lease id is readable, so it is not a capability. Connection identity is server-owned.
An admission retry that hits an existing child returns it unchanged.

Never consulted:
- `admission_key` as a grant (it only identifies);
- `run.start.env` or `run.resume.env`;
- step input;
- spec metadata;
- extra fields.

### 4.4 Admission preflight and injection

**At `run.start`** (covenant 2), for each det step and declared name N:

- If N is bound and R is not entitled, refuse with `credential_unavailable` (the message names the
  step and N).
- If N is withheld, refuse with `credential_unavailable`.
- If N is unbound and absent from the run's source env (`step_env`, or the daemon env for a
  pre-`step_env` client), refuse with `credential_unavailable`. On a host with no binding, a
  developer's exported `GH_TOKEN` satisfies the declaration, as F1 already provides.

**At spawn**, the env is built as follows:

1. **Base:** the run's `step_env` (F1, unchanged). A legacy client with no env gets the daemon env.
2. **Strip every bound name and every withheld name** from the base.
3. For each declared name, decide whether the step may spawn. This is re-checked at spawn, because a
   restart can drop the binding or change the resuming client's env.
   - If the name is bound and R is entitled, add the bound value.
   - If the name is unbound, it must still be present in the base after step 2.
   - Otherwise, do not spawn. Fail the step with `completionReason: worker_error` and
     `failure_detail: "credential_unavailable: <NAME>"`. No new journal vocabulary is needed.
4. Add `FLOWS_INPUT` and `RELAYFLOW_MEMORY`, as today.

**Redaction before append.** Each bound value is replaced by `[redacted:<NAME>]` in:
- `stdout_tail` and `stderr_tail`;
- `trajectory_tail`;
- `failure_detail`.

This happens before the journal write, so the value never reaches the journal, watch stream, wire,
`run.get` or `journal.read`. It is a byte-substring replace of values the daemon holds. It cannot
catch transformed values (base64), which is limit L4.

### 4.5 Withheld names (D2)

`--det-withhold NAME` is the generic form of "deterministic steps must never see Y".

- It is a **kernel-side** strip at spawn (§4.4 step 2). A caller cannot undo it: a withheld name in
  `run.start.env` or `run.resume.env` is dropped, and declaring it is refused.
- It changes **only `exec_det`**. Agent and LLM workers run in the CLI with their own env
  (`packages/sdk/src/cli/direct-run.ts:48,90,97`, `local-agent-environment.ts`). The kernel never
  hands them an env, so agent steps still get their keys.
- The strip is **by name**. If a host declares every agent-only name, no agent-only value reaches
  the det step, unless the semi-trusted body deliberately copies a value under another name (L5).
- **Delivered and repository secrets are unaffected.** The host simply does not withhold them.
  Examples: `RELAY_SECRET_ENV_NAMES` entries, `GH_CONFIG_DIR`, `GIT_*`.
- **Optional, defence in depth (open question N4).** The daemon would list withheld names in
  `hello` (`det_withheld`), and `stepEnv()` would omit them. Agent values would then not even cross
  the socket in `run.start.env`. The kernel strip stays authoritative.

### 4.6 Lifetime

- The binding lives exactly as long as the daemon process. On restart, the host re-declares it with
  the same argv and spawn env.
- Entitlement is per run and recomputed from the registry and journal.
- `run.completed` does not touch the binding.
- Mid-run value rotation is not in v1 (N3).

## 5. Wire and kernel changes (additive, feature-gated)

| Surface | Change | Compatibility |
|---|---|---|
| `hello.features` | adds `det_credentials` (whenever implemented, bound or not) | old clients ignore it |
| `relayflowd serve` | `--det-credential`, `--det-credential-root`, `--det-withhold` (names only; values from the daemon's own env) | no flags: unchanged; an old daemon rejects the flags, so the host fails closed |
| spec | deterministic `credentials: [NAME]` | an old kernel refuses the unknown field (fail closed) |
| `run.start` | optional `parent: {run_id, step_id, attempt}` | an old kernel refuses it (`server/wire.rs:43` `deny_unknown_fields`) |
| errors | `credential_unavailable`, `parent_not_held` | new codes only |
| `exec_det` | §4.4 env assembly, `Stdio::null()` stdin, redaction | inert when nothing is bound or withheld |
| journal | **no new entry types or fields** | `parent_run_id` exists; specs carry names only |

Kernel purity holds. Entitlement is a pure function of four inputs:
- the registry row;
- the `run.spawned` facts;
- the hub's in-memory lease table;
- the static binding.

There is no provider, tenant or product logic. The estimate is about 300 lines across
`det_credentials.rs`, `exec_det.rs`, the `server.rs` admission path and `spec.rs`.

## 6. SDK and Surface changes

- **`f.run(command, { credentials?: readonly string[] })`** compiles to step `credentials`. If the
  daemon lacks `det_credentials`, it throws before `run.start`.
- **`f.agent` and `f.llm` get no `credentials` option**, in types or in the compiler.
- **Authored children are admitted on the lease-holding connection with `parent`.** Today the root
  body's lease is on `peer` (`authored-root.ts:109-117`), but children start on `journal`. The
  paths to change are `authored-worker-step.ts:159-161,364-371`, `authored-helper-effect.ts:43-51`,
  `authored-plugin-effect.ts:35`, `authored-mcp.ts:58,139` and `authored-budget.ts:112,137`.
- **The YAML root sends an admission key.** `cli/run.ts:285-291` sends none today. It derives one
  from `RELAYFLOW_AUTHORED_ADMISSION_KEY`, as `cli/direct-run.ts:84-85` does.
- `stepEnv()` is unchanged. N4 would add the optional `det_withheld` omission.
- **Docs:**
  - `docs/SURFACE.md` (`f.run` credentials; update "f.run on the local daemon");
  - `kernel/DAEMON-LIFECYCLE.md` §3 (host binding and withheld names);
  - `packages/schema` (step field).

## 7. What a host must do (the published interface Native's integration calls)

This is the interface only. Cloud implementation choices belong to Native.

1. **Spawn** `relayflowd … serve` with:
   - `--det-credential NAME` for each credential its det steps are entitled to;
   - `--det-credential-root <kernel admission key of the root run>`;
   - `--det-withhold NAME` for every agent-only name present in the CLI's env.
2. **Put each bound name's value in the daemon's spawn env**, under that exact name. Cloud already
   does this for `GH_TOKEN` (`relayflow-v2-step-env.ts:217-218`). **Bind only daemon-only
   secrets.** A name already in both envs, such as `GH_CONFIG_DIR`, `GIT_*`,
   `RELAYFLOW_V2_REPOSITORY_*` or delivered secrets, must not be bound: binding a name reserves it,
   so every step that does not declare it would lose it.
3. **Make the root admission key known to the CLI** without a secret. The CLI derives
   `authored-root:` + sha256 of `RELAYFLOW_AUTHORED_ADMISSION_KEY` (`authored-root.ts:106,584-586`),
   so the host sets that identity in the CLI env and passes the derived key to the daemon. It is not
   a secret: knowing it grants nothing (§3b).
4. **Keep the credential out of the CLI's env**, as today (`relayflow-v2-step-env.ts:223`). The
   kernel never forwards a bound value to anything except an entitled, declaring det step.
5. **Withhold, don't strip.** The CLI env keeps its agent keys for agents. The host only lists them
   with `--det-withhold`. Delivered and repository secrets are not withheld.
6. **Verify the feature** before relying on it. The pinned runtime's `relayflowd` `hello` must list
   `det_credentials`. Otherwise refuse the launch rather than degrade.
7. **On resume**, re-spawn with the same argv and spawn env, and restore the registry with the
   journal (N2).
8. **Flow authors** (Babysitter) declare `credentials: ['GH_TOKEN']` on exactly the GitHub-calling
   `f.run` steps. They do not declare it on `workspace.ts:18`, which runs repository code. This
   changes the pinned source sha, which is a release step on the Cloud side.

**Owner map.**

| Role | Owner |
|---|---|
| Kernel channel: hold, entitle, inject, withhold, redact | flows kernel (`det_credentials.rs`, `exec_det.rs`) |
| Wire, spec and SDK contract; published docs | flows (`DAEMON-LIFECYCLE.md` §3, `SURFACE.md`, `packages/schema`) |
| Which names to bind or withhold, root identity, minting, delivery, admission containment | host (Native) |
| Which steps need which names | flow author (Babysitter example and its pinned artifact) |

## 8. Explicit limits: what this design does NOT close

- **L1. A same-uid `f.agent` can reach the daemon socket.** The design makes the socket confer no
  credential authority (§3b), but the agent can still:
  - read journals;
  - start unentitled runs that get the run's non-withheld env.

  Mitigation (host, out of kernel scope): run agents under a separate uid, or in a mount namespace
  without the socket path, and do not export `RELAYFLOW_DATA_DIR` to agents. A future kernel option
  is `SO_PEERCRED` uid allowlisting. Not proposed now.
- **L2. `/proc/<pid>/environ`.** Two exposures remain:
  - an entitled det step's `environ`, while it runs;
  - the daemon's own `environ`, because the host puts the bound value in the daemon's spawn env, as
    Cloud already does today.

  Both are readable by same-uid processes. Mitigation (host): `hidepid=2` on `/proc`, or uid
  separation. Out of kernel scope. A stdin delivery form (N8) would remove the daemon's exposure
  but not the step's.
- **L3. Stolen root lease.** A same-uid agent can kill its parent CLI. If it then attaches as a
  worker on the root stream, it can receive the redelivered root body dispatch and so hold a lease
  that may `parent` credentialed children.

  Proposed kernel mitigation, for the lead to decide (N5): while a binding is active, only the
  **first** dispatch of the root body within a daemon lifetime may parent credentialed children. A
  redelivery requires a host restart (Cloud resume) to re-arm. Full closure needs L1's uid
  separation.
- **L4. Transformed values.** Redaction is substring-exact. An entitled step that base64-encodes
  its token, as the Babysitter does for an extraheader, and prints it is not redacted. Author
  responsibility.
- **L5. Withholding is by name.** A body that copies an agent value under a new name defeats it. The
  body is semi-trusted, and holds the keys by Cloud's design.
- **L6. An entitled step can exfiltrate what it is given.** Per-step declaration limits which steps
  are entitled.

## 9. Explicitly NOT done

- No credential is put back into the CLI, `f.agent`, `f.llm` or worker envs. Dispatch frames carry
  no credential.
- No CLI env stripping, no daemon-env merge into step env, and no `--inherit-env` passthrough.
- No credential value in the wire protocol, journal, registry, checkpoints, logs or files.
- No GitHub, provider, tenant or minting logic in the kernel.
- No mid-run rotation and no gate-8 proxy.
- No change to F1 for names that are neither bound nor withheld, and no change to the
  repository-grant path.
- No implementation, publish, release or activation in this change.

## 10. Alternatives and interim options

1. **Pin the runtime to 2.0.43** (Cloud carries it as the "unsuffixed production" Surface,
   `relayflow-v2-surface-authority.generated.ts:21`).
   - It restores D1 and D2 only by restoring the pre-F1 behaviour.
   - It forks Cloud from all later fixes, and it is a runtime pin, which the lead forbids.
   - It is rejected.
2. **Re-add `GH_TOKEN` to the CLI env.** The body and the `f.agent` children run in the CLI's
   process tree, so the agent gets a write-capable token. That reverses
   `relayflow-v2-step-env.ts:219-223`. Rejected.
3. **Merge the daemon env into step env.** It re-opens F1 and gives the credential to every run on
   the daemon, including agent-started ones, with no step granularity. It is forbidden. Rejected.
4. **`--inherit-env NAME` from the daemon env.** It has the same cross-run leak, and the value stays
   in the daemon's `environ`. Rejected.
5. **Daemon-scoped binding** ("every run on this daemon"). It is safe only by the one-daemon-per-run
   convention, and an agent can start its own run (L1). Rejected.
6. **Capability nonce in the CLI env.** The CLI env is the agent's env. Rejected.
7. **Value in input or `FLOWS_INPUT`.** Input is journaled. Rejected.
8. **Token file (`GH_CONFIG_DIR`-style) for this case.** The file is on disk in the agent's
   sandbox. Rejected.
9. **Strip the agent keys from the CLI env**, or move them all to `FLOWS_LOCAL_AGENT_ENV_FD`.
   Stripping is forbidden, and agents need the keys. Moving them to the existing fd channel is the
   cleaner D2 fix in principle, because the keys never enter `process.env` and so never enter
   `step_env`. But the channel's four-name allowlist does not cover Cloud's 13 names plus the house
   pickup. Widening the allowlist is an SDK interface question for Native (N6). `--det-withhold` is
   the kernel-side guarantee either way.
10. **Gate-8 credential proxy now.** It is the end state, but much larger. This design is
    forward-compatible with it.
11. **Interim: Native's `RELAYFLOWD_STEP_ENV=daemon` host policy** (unpushed). Under this policy:
    - `hello` omits `step_env`;
    - `run.start` or `run.resume` carrying `env` is refused with `step_env_disabled`;
    - det steps spawn with the daemon's own env.

    Per the lead's framing, inheriting a **host-sanitized, one-run** daemon env differs from
    blanket-merging arbitrary daemon secrets. Here it is analysed criterion by criterion. The
    acceptability call is the lead's (N7).

    | Criterion | Policy | Channel (this proposal) |
    |---|---|---|
    | **Entitled allowlist** | No per-step allowlist. Every det step of every run on that daemon gets the whole sanitized `daemonEnv`, including `GH_TOKEN`. That includes the repository-code validation step (`workspace.ts:18`). The host's sanitization (`relayflow-v2-step-env.ts:215-218`) is the allowlist, at daemon granularity. | Name allowlist (`--det-credential`) times per-step declaration times run lineage. |
    | **Trusted host binding** | Yes. The policy is set by the host at spawn, and callers cannot change it. | Yes. Argv at spawn. |
    | **F1 default preserved** | Yes when unset. When set, F1 is off for that whole daemon. That is acceptable only under one-run-per-daemon. | F1 stays on everywhere. Only bound and withheld names are touched. |
    | **`run.start` and `run.resume` both fenced** | Yes. Both refuse `env` (`step_env_disabled`). A legacy client with no env falls back to the daemon env, which is the intended policy. | There is no fence on `env`. Instead, bound and withheld names are stripped from any `env`, and nothing else is needed. |
    | **D2 (agent keys)** | Closed by construction. `daemonEnv` has no agent keys. | Closed by `--det-withhold`. That is fragile: the host must enumerate 13 or more names plus the house pickup (N6). |
    | **Agent-started run (L1)** | **Open.** A run an agent starts over the socket gets `GH_TOKEN` in its det steps, and can print it into a journal the agent can read. This matches 2.0.43 exposure. | Closed. The run is not entitled: declaring steps are refused, and undeclared steps have the name stripped. |
    | **Restart and resume** | Stable. Cloud restarts with the same spawn env, so the behaviour is the same. Nothing is persisted. | Stable. Same argv and env. Lineage is recomputed from the registry and journal (N2). |
    | **Same-uid `/proc` (L2)** | Value in the daemon's and every det step's `environ`. | Value in the daemon's `environ` (as today) and only in entitled steps' `environ`. |
    | **Kernel and SDK change size** | Small (one host policy). Tested 348/348 by Native. | Kernel, wire and SDK (§5, §6). |

    **Layering.** They compose: the channel works under either step-env base. Under the policy, the
    base is the daemon env, and the channel still strips bound names unless the step declares them
    and is entitled. That narrows `GH_TOKEN` to declared steps and closes the L1 row. So the policy
    can ship first as an interim, and the channel can be added on top later. Alternatively, the
    channel with F1 on plus `--det-withhold` can replace the policy outright. The trade is D2
    robustness (the policy's sanitized base) against keeping F1 on (the channel's base). This
    proposal does not choose. The fixture tests the channel with F1 on, since that is the generic
    multi-run case.

## 11. Open questions

**For the lead**

- **N1. Per-step declaration versus all det steps of an entitled run.** The proposal requires
  declaration, for least privilege. That forces a Babysitter change and a re-pin.
- **N5. L3 mitigation.** Should the kernel accept only the first root body dispatch per daemon
  lifetime as a credential parent?
- **N7. Interim.** Is `RELAYFLOWD_STEP_ENV=daemon` acceptable, as a stopgap or as the permanent
  base under the channel (§10.11)?
- **N11. Lineage versus daemon-scoped entitlement.** Native observes that the natural hosted binding
  is "runs owned by this daemon". That is simpler: no `parent` and no SDK child-admission change.
  But it leaves the L1 row open, because an agent-started run on the daemon is "owned by this
  daemon". The proposal and fixture require lineage. If the lead accepts daemon scope, the
  fixture's cross-run case must be relaxed by the lead, not by the implementer.

**For Native (host interface)**

- **N2. Root identity on resume.** Entitlement (a) needs `relayflowd.sqlite3`'s `run_admissions`.
  Is the registry restored with the journal on Cloud resume? If not, which of these: add a
  `--det-credential-root-run <run_id>` form (the host knows `engineRunId`), or journal the
  admission key in `run.spawned` (a journal field change)?
- **N3. Token lifetime.** GitHub installation tokens last 1 hour. Is a Babysitter attempt bounded
  below that? If not, a host-only rotation channel (a control fd, never the socket) is needed.
- **N4. Wire omission of withheld names.** Should `hello` list `det_withheld` so that `stepEnv()`
  omits those values from `run.start.env`? Or is the kernel strip enough?
- **N6. D2 primary fix.** Widen `FLOWS_LOCAL_AGENT_ENV_FD`'s allowlist (or make it host-declared) so
  that agent keys never enter `process.env`? Or rely on `--det-withhold` only?
- **N8. Value delivery.** The proposal uses argv names with values resolved from the daemon's own
  spawn env (Native's preference: no values on any wire, restart-stable). An optional stdin form
  would also remove the value from the daemon's `/proc/<pid>/environ` (L2). Is it wanted?
- **N12. Root selector.** Should the root be an explicit admission key (proposed), or "the first run
  admitted on this data dir", which is daemon-minted with no host key? The latter breaks if anything
  touches the daemon before the CLI's root. The executor's human-answer and subscription steps
  (`relayflow-v2-executor.ts:893-905`) talk to the daemon first, so an explicit key looks
  necessary. Native to confirm.
- **N9. Bound name in caller env.** The proposal strips it everywhere on that daemon. Should the
  host instead want `run.start` refused when `env` carries a bound name?
- **N10. Root spec pin.** Should the host also pin the root's spec or source hash, to close an
  admission-key race before the real root starts?

## 12. Fixture map (`kernel/relayflowd/tests/det_credentials_design.rs`)

| Requirement | Test |
|---|---|
| Det step of an owned run receives the declared credential by name; an undeclared step does not | `owned_root_det_step_receives_declared_credential_by_name` |
| Det steps get no agent-only key, checked by name and by value bytes in a full `env` dump. Delivered and repository vars are kept. The agent step is still dispatched and completed. | `det_steps_never_receive_agent_only_keys_while_agent_steps_are_served` |
| Cross-run: another admission key, no key, an impostor env value, and a legacy no-env client all get nothing | `another_run_on_the_same_daemon_does_not_receive_it` |
| Spoofed scope: extra `run.start` fields, `credentials` on agent/llm steps, withheld or unbound names, an impostor `GH_TOKEN` on the root | `spoofed_scope_cannot_widen_access` |
| Authored child is entitled only via the root body's lease-holding connection; an intruder and a stale attempt are refused; lineage is journaled | `authored_child_inherits_only_through_the_root_body_lease_holder` |
| SIGKILL mid-run, restart with the same binding, resume with an impostor env: same binding, not more | `restart_and_resume_keep_exactly_the_same_binding` |
| Restart without the binding fails closed (`credential_unavailable: GH_TOKEN`) | `restart_without_the_binding_fails_closed` |
| No value in captured wire bytes, daemon stdout/stderr, or any data-dir file; output redacted | `no_token_value_reaches_journal_wire_logs_or_checkpoints` |
| F1 per-run isolation holds with a binding active | `f1_per_run_env_isolation_still_holds_with_a_binding` |

## Source receipt

All analysis is against these exact revisions. No running system was touched.

- flows `origin/main` = `2ee558eeeefb99fd37428667746814ca3ab3f486`. #655 =
  `edc9f5b43c7a6854c9bb38bac0121ae0860a50f1` (merge), `acb9c2ce4236d25387c30099da406933eca6f200`
  (change). #596 = `5b9cb46920ff41978bc8f8dd696dea4c1e631731`. Files:
  - `kernel/relayflowd/src/{exec_det.rs,server.rs,step_env.rs,engine/drive.rs,worker.rs,server/session.rs,server/wire.rs}`
  - `kernel/relayflowd-core/src/{spec.rs,entry.rs}`
  - `kernel/relayflowd-journal/src/registry.rs`
  - `packages/sdk/src/{journal-client.ts,local-agent-environment.ts,authored-root.ts,authored-admission.ts,authored-worker-step.ts,cli/direct-run.ts,cli/run.ts}`
  - `examples/babysitter/{fix.ts,merge.ts,github.ts,signals.ts,workspace.ts,fixer.ts}`
- cloud `origin/main` = `7bda9a145a3f32540bad0c04501311292f20ad50`. Files:
  - `packages/core/src/bootstrap/lib/{relayflow-v2-step-env.ts,relayflow-v2-executor.ts,relayflow-v2-repository.ts}`
  - `packages/core/src/auth/proxy-token.ts:323-337`
  - `packages/core/src/bootstrap/templates/bootstrap-inner.mjs:3380-3394`
  - `packages/web/lib/workflows/launch-runner.ts:684-707`
  - `packages/core/src/workflow-launch/relayflow-v2-surface-authority.generated.ts`
