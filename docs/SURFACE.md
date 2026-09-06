# The Relayflow surface

*Companion to RFC-0001. Governs the authoring experience; bound by the two covenants. Destined for `flows/docs/SURFACE.md`.*

**What is a relayflow?** A powerful abstraction for writing agentic pipelines: a deterministic script over agentic primitives, written so easily that the abstraction disappears. The kernel exposes a small closed vocabulary; helpers make our primitives effortless; plugins let the community extend the surface without ever touching the kernel.

## 1. The two poles

Design law: the surface must serve both poles with the same language. A simple flow becomes a harness by accretion — more verbs, never a rewrite.

### The super simple relayflow

```yaml
name: release-note
steps:
  - run: git diff main
  - llm: One-line release note for the diff above.
    gate: length < 200
  - slack: "#releases → {{prev}}"
```

```ts
export default flow("release-note", async (f) => {
  const diff = await f.run("git diff main");
  const note = await f.llm`One-line release note for: ${diff}`.gate(s => s.length < 200);
  await f.slack.post("#releases", note);     // returns a typed receipt
});
```

### The harness (chief-shaped)

```ts
export default flow("chief", {
  identity: "chief",                          // gate 8 — a principal
  memory: { script: true, agent: true },      // gate 5 — relayhistory-backed
  budget: "$20/day",
})
.on(slack.mention("#exec"), async (f, event) => {          // gate 2 — trigger = entry condition
  const intent = await f.llm`Extract the work request, if any: ${event.text}`
    .gate(isActionable);
  if (!intent) return f.done("success"); // no work is an outcome; execution succeeded

  const plan = await f.agent("planner", {
    task: `Research and plan: ${intent}`,
    workspace: "acme/api: readonly",          // compiles to relayauth path scopes
  });

  const ok = await f.human(`Ship this?\n${plan.summary}`, { to: "khaliq" });
  if (!ok) return f.done("canceled");

  const pr = await f.dispatch("garden/implement", plan);   // gate 3 — child flow
  await f.slack.reply(event, `Shipped: ${pr.url}`);
});
```

No process runs between events: the handler wakes, executes to its next await, parks. That is gate 4's system-of-ephemeral-agents, and the author never meets a lease, journal, or offset.

## 2. The semantic laws

1. **Three step verbs** — `run` / `llm` / `agent` — one per rung of the ladder. Four resident verbs — `on` / `human` / `dispatch` / `done`. The kernel vocabulary stops there.
2. **Gates are postfix on the step they guard.** Never a separate machinery block.
3. **Helpers, not primitives.** Authors never see mount paths, tokens, or protocol frames. Named helpers wrap every substrate:
   - `f.slack` / `f.github` / `f.linear` / … — **generated from the relayfile adapters** (50 providers → 50 namespaces for free), each verb compiling to a mount write. The receipt a helper returns *is* the journaled effect record (RFC Appendix A), so exactly-once dedup rides along invisibly.
   - `f.memory` — relayhistory: `f.memory.recall(query)`, `f.memory.why(task)`, `f.memory.learn(finding)`.
   - auth — relayauth: never called directly; `workspace:` / `tools:` declarations compile to path-scoped tokens ("the filesystem paths *are* the permissions").
   - `f.mcp` — one line to declare (`tools: { mcp: [stripe] }`), one call to use (`f.mcp.stripe.create_invoice({...})`). Preflight connects to every declared server before the run starts.
4. **`{{prev}}` / return-value chaining.** Output flows downward implicitly; naming steps is for reaching back, not bookkeeping.
5. **Headers are optional escalation.** identity, memory, budget, tools appear only when used. The empty header is the common case.
6. **Agent definitions escalate by composition** — and a reusable agent *is* a flow:
   ```yaml
   - agent: Review this diff for security issues.        # 1. anonymous
   agents:
     reviewer: { cli: claude, model: claude-sonnet-4-6 } # 2. named — explicit and reusable
   ```
   The declarative named-agent schema in this slice is exactly `{ cli, model }`;
   unknown fields fail closed. Defining a richer team reviewer means writing
   `reviewer.flow.ts` (identity + memory + body); other flows compose it with
   `use:` / `f.agent(reviewer, task)`. Persona import is flow composition, not
   a special mechanism.

   In the canonical declarative YAML/JSON dialect, `agents:` is a top-level
   map and an agent step selects one with `agent: reviewer`. Each named
   declaration requires both `cli` and `model`. Compilation lowers them into
   the existing per-step `cli` and `model` fields. The validated selector and
   map remain authoring metadata through `flows check`, so unused and
   step-shadowed declarations are linted too; both are removed at the kernel
   boundary. Explicit step values win independently:
   step `cli`/`model` → named declaration → the existing flow/project CLI
   default. Model has no flow/project default. An inline step that selects no
   named declaration keeps the existing optional-model behavior. The worker
   explicitly removes ambient `RELAYFLOW_MODEL`; raw provider adapters use a
   model flag, while at worker execution a custom wrapper receives the model
   only inside its identified same-process session when the step declares one.

   **Anonymous resolution law:** `f.agent\`task\`` with no name is the *default agent*, resolved (never guessed) in order: step options → flow header → project config (`flows.json`) → platform default. *The platform-default rung is declared but not yet implemented: no platform default is provisioned as of gate 1, so a flow that reaches this rung refuses with `cli_unresolved` rather than guessing. `flows check` never invents an implicit default.* `flows check` prints each resolved step CLI and its declaration source, validates it before submission, and refuses a missing or unauthenticated resolution before the checked flow is submitted, never at minute 27. Gate 1 does not make this guarantee for callers that bypass `flows check`: the journal client's direct `run.start` path does not invoke surface preflight.

   **Typed CLI-adapter contract:** `flows check` and `AgentWorker` share one
   closed adapter table. A resolved executable whose basename is `claude` uses
   `claude auth status`, probes the exact model with a real noninteractive
   `claude -p --model <model>` round trip, and executes with that same model
   flag. A basename of `codex` uses `codex login status`, probes with
   `codex exec --skip-git-repo-check --model <model>` in an ephemeral read-only
   session, and executes noninteractively with the same Git/cwd flag. A Git
   checkout is not a Relayflow execution prerequisite, so readiness and worker
   execution both support non-Git working directories. Model-scoped probes may
   contact the provider and have a 60-second timeout; this cost is the
   honest price of proving current credential/model access rather than
   accepting an unrelated auth command as model proof.

   Every other executable is a custom Relayflows wrapper and must first answer
   `<cli> --relayflows-adapter-v1` with exactly
   `relayflows-agent-cli-v1`. Only an identified wrapper uses the established
   `<cli> auth status` plus an exact-model scoped readiness probe. A missing or
   wrong identification is `cli_unsupported`, never
   mislabeled as `cli_unauthenticated`. If a model-scoped probe fails, the
   adapter's real unscoped authentication command distinguishes
   `model_unavailable` from `cli_unauthenticated`. At execution the worker
   starts one wrapper process with only `--relayflows-adapter-v1` and a scrubbed
   environment, waits for the exact identity token, then sends one JSON line
   containing instruction plus any declared model/wake context over that
   child's stdin. The same child must acknowledge with
   `relayflows-agent-cli-v1-execute` before its remaining stdout is treated as
   agent output. There is no second pathname resolution: replacing or
   retargeting the declared executable after identification cannot receive the
   private request. A direct journal submission, nonconforming wrapper, or
   process that exits after identifying completes `worker_error`.

   **Declared wrapper bounds.** A wrapper author writes against four bounds,
   all enforced by the reader so that no wrapper can defeat one by withholding
   an event. Each is a refusal with `exit_code: null` and a diagnostic naming
   the bound it exceeded, which the worker completes as `worker_error`.

   | Bound | Default | Applies to | On exceeding |
   |---|---|---|---|
   | Handshake deadline | 10 s | From spawn until the wrapper has emitted both `relayflows-agent-cli-v1` and `relayflows-agent-cli-v1-execute` | Session refused: "did not identify as `relayflows-agent-cli-v1` within *N*ms" |
   | Handshake byte limit | 8192 bytes | Only the **un-terminated** residue of the handshake buffer — bytes not yet ended by a newline while the handshake is still open. Complete lines are drained first, so the execute token always ends the handshake before this is measured, and a result payload behind it is execution output governed by `maxOutputBytes`, not by this bound | Session refused: "exceeded the wrapper handshake limit of 8192 bytes before completing the `relayflows-agent-cli-v1` handshake" |
   | Execution deadline | 300 s | From the execute token until the wrapper's output is complete | `SIGTERM`, then `SIGKILL` 1 s later; the reader settles on its own deadline whether or not the process closes its pipes. Refused: "execution timed out after *N*ms" |
   | `maxOutputBytes` | 1 MiB | Total captured stdout **plus** stderr after the execute token. Inclusive: exactly at the limit is accepted, one byte over is refused. Enforced on arrival, so an unbounded or newline-free flood is cut off by the reader rather than buffered | Session refused: "exceeded the captured output limit of *N* bytes" |

   Because the deadlines are reader-owned, a wrapper that exits while leaving a
   descendant holding an inherited stdio pipe — which withholds Node's `'close'`
   event forever — is still bounded and still journals a `completionReason`. It
   is bounded at the *execution deadline* rather than at the wrapper's own exit,
   so a wrapper that leaks a pipe pays the full 300 s. Wrappers should not leave
   descendants holding stdout or stderr.

   `flows check` resolves the binary (a path is relative to the declaring flow
   or project config; a bare name resolves via `PATH`) and caches each resolved
   `(cli, source, model)` probe. A missing executable is `cli_missing`. A probe
   that succeeds for a relative path binds its canonical absolute executable
   into the checked step before journal submission, so a worker running from a
   different directory identifies and executes the same binary. A probe
   that cannot start, is signaled, or exceeds its adapter timeout is
   `probe_failed`, with a classified diagnostic rather than a raw process
   error. Every subprocess starts with ambient `RELAYFLOW_MODEL` removed.
   Provider adapters pass only the declared flag; wrapper readiness receives
   only an allowlisted declared model, while worker instruction/model/wake
   values travel only in the post-identification session request. Preflight
   never invokes an undeclared model or guesses from host state.

   **Deterministic model registry:** model existence is not inferred from a
   regex or provider prefix. The nearest `flows.json` owns an exact,
   case-sensitive `models` allowlist. `flows check` first refuses a declared
   model absent from that list as `model_unknown`, without starting the CLI.
   One pure first pass collects every unknown named/inline model and every
   unresolved step CLI
   before any CLI, command, executor, or daemon probe, independent of step
   order. This includes every named declaration, even when unused or shadowed
   by a step override;
   only an allowlisted value reaches the live model-scoped probe above. The
   registry is author-owned project configuration, reviewed and versioned with
   the project. Updating it is an explicit file change made only after the
   project verifies access to the added model. No remote catalog is fetched,
   so a checkout plus its nearest config reproduces typo decisions offline.
   Runtime access remains a live fact and is re-probed on every check call.

   **Accepted deterministic-command limitation (Codex P1):** `flows check`
   warns with `command_unresolved`, rather than refusing, when a deterministic
   command's first word cannot be resolved. A bare word is not provably absent
   under `/bin/sh -c` because it may be a shell builtin, function, or
   assignment. The narrower path-like missing-command refusal is also not yet
   implemented; it is tracked in `ops/BACKLOG.md` under “Close the
   deterministic-command preflight gap.” Consequently, `cli_missing` applies
   to declared `llm` and `agent` CLIs, not deterministic command words.

   **Project-config discovery:** starting in the flow file's directory, `flows check` walks parent directories through the filesystem root and selects the first readable `flows.json`. That nearest file is the whole project config; it is not merged with outer files. Its schema is `{ "cli"?: <non-empty string>, "executors"?: <non-empty string>[], "models"?: <trimmed model string>[] }`; unknown keys, malformed model entries, and duplicates fail closed as `config_invalid`. A nearer config therefore defines a self-contained nested project boundary and prevents accidental inheritance of outer credentials, executors, or model approvals. The selected path is printed with project-level resolutions and named in refusals; if it declares no `cli` or models, outer configs remain shadowed. At gate 1, a trigger executor is considered registered only when its name is present in this author-written `executors` array; `flows check` does not yet contact a registry, broker, or RelayCron, and absence is `no_executor`.

   Implementation status for issue #132: this named-agent contract currently
   ships in the canonical declarative YAML/JSON compiler. Matching
   `FlowHeader.agents` TypeScript types depend on the separately reviewed,
   unmerged `@relayflows/surface` package in PR #134 and are a follow-on after
   that package lands; this compiler slice does not duplicate that package.
7. **Two dialects, one journal.** Declarative YAML — data, fully preflightable, sage's compile target, gate 9's self-authoring output. Imperative TS — journal-memoized function, maximum ergonomics. YAML is canonical; TS is the power tool. TS preflights its declared surface (agents, helpers, tools, identity), not arbitrary control flow — declared honestly per covenant 2.

### Structured output declarations

Declarative `llm` and `agent` steps may declare an `output` JSON Schema. This
is authoring sugar for the existing kernel `json_schema` verification gate; the
compiler removes `output` before the journal boundary and emits the schema as
`verification.json_schema`. Authors must choose either `output` or an explicit
`verification` block. Declaring both is ambiguous and fails closed.

```yaml
- id: extract
  type: llm
  prompt: Return the actionable request as JSON.
  output:
    type: object
    required: [actionable, request]
    properties:
      actionable: { type: boolean }
      request: { type: string }
```

The declaration does not add a kernel primitive and does not yet infer a
TypeScript result type from arbitrary JSON Schema. Typed parsed values belong
to the imperative `f.llm` / `f.agent` surface once that surface has a real
consumer; the spec SDK does not publish an unchecked phantom type in advance.

The authoring surface deliberately narrows `steps: []`: `flows check` refuses
it as `invalid_spec`, while the kernel accepts it. This is a chosen
authoring-time narrowing, not a kernel guarantee.

### The authored operation lifecycle

An authored TypeScript body reaches `done()` only if every step it created was
actually consumed on the continuation that got there, and nothing derived from a
step was still running or had failed unobserved. Three rules, in the author's
vocabulary:

1. **Await every step.** Creating `f.run(...)` and never awaiting it is
   `unawaited_step`. Constructing steps and awaiting them later is fine —
   `const steps = [f.run(a), f.run(b)]; for (const s of steps) await s;` is
   ordinary, supported authoring, and so is `Promise.resolve`, `Promise.all`,
   `Promise.allSettled`, `Promise.any` and `Promise.race` over authored steps.
   A manual `.then(...)` callback is not an await and is refused; callback
   source text is never treated as proof of anything.
2. **A step's failure is yours whether or not you catch it.** A root failure is
   recorded before author code can reach the operation, so a `catch` cannot hide
   it. At this gate the executor only lowers `done("success")`, so there is no
   expressible recovery from a failed step yet.
3. **Finish your derived work before `done()`.** If a handler chained onto a step
   is still in flight when the body returns, the run is refused with
   `unsettled_derived_work` rather than recorded as a success nobody can prove.
   Awaited derived work is always settled by then; only fire-and-forget work is
   caught by this. If you start something after a step, await it before `done()`.

**Documented limit.** Work that does not yet *exist* when the body returns
cannot be seen. `setTimeout(() => { p.then(handler).catch(ignore); })` schedules
a derived chain to begin after completion, and the gate will not observe it.
This is the boundary of the contract, not an oversight: the flow has already
finished when that promise is created. Do not use a timer to smuggle
post-completion work into a run.

**Disclosure: this package replaces `Promise.all`, `Promise.allSettled`,
`Promise.any` and `Promise.race` while a flow is open.** The lifecycle installs
its own versions on the global `Promise` for the duration of any authored flow
execution, and restores the originals when the last concurrent flow closes.

- *Why:* a combinator's aggregate has no runtime edge back to its members, so
  `await Promise.all([a, b])` cannot otherwise be proven to have consumed `a`.
  The alternatives all infer group membership from the callbacks the combinator
  passes each element, which is exactly the callback-identity inference this
  contract exists to refuse.
- *Why all four:* an earlier revision intercepted only `Promise.all` and covered
  the rest by inheriting attribution from whichever context resolved the
  aggregate. That inheritance fires only when the RESOLVING context is itself
  attributed, so an aggregate resolved by an ordinary promise inherits nothing —
  and for `any` and `race` the resolver is by definition whichever member settles
  first, which an ordinary member wins. Measured: multi-member `Promise.any` and
  `Promise.race` carried a thrown derived failure through to
  `completionReason: "success"`. Attribution must not depend on WHICH member
  resolves the aggregate, and the member edge is what makes it independent.
- *Scope:* process-wide, for the lifetime of an authored flow execution. Any code
  in the process — including yours and your dependencies' — sees the replacement
  during that window.
- *Behaviour:* the replacement delegates to the intrinsic and is specified to
  behave identically. A non-iterable argument is handed straight through, so
  `Promise.all(5)` and `Promise.all(null)` return the same rejected promises the
  intrinsic returns; `name` and `length` match, for each of the four. If any of
  them has already been replaced by something else, the flow refuses to start
  rather than fighting over the intrinsic.

If a process-wide intrinsic replacement is unacceptable in your deployment, do
not run authored TypeScript bodies in that process; the declarative YAML path
does not install it.

## 3. Plugins: the kernel is closed, the surface is open

The herdr model: first-party helpers are just plugins that ship in the box; the community brings the rest.

- A plugin contributes **helper namespaces** (verbs), **trigger sources** (`on(x.y(...))`), and **gate predicates**. Install: `flows add helper-datadog` (registry + npm `@flows/helper-*`).
- **The plugin contract:** every plugin verb must compile to kernel primitives (a `run`, an `llm`, an `agent`, an effect write, a wait). Plugins extend the *surface*, never the kernel — the seven-word kernel vocabulary is closed, which is what keeps specs portable, journals replayable, and gate 9's self-authoring safe.
- **Preflight is part of the contract:** a plugin declares what must be provable before a run using it starts (credentials present, server reachable, scope grantable). A plugin that can't state its preflight doesn't load. Covenant 2 extends to the ecosystem by construction.
- Receipts, budget attribution, and identity scoping apply to plugin verbs exactly as to first-party ones — they come from the compile target, so a plugin can't opt out.

## 4. Build: the immutable bundle

`flows build` seals a flow into a content-addressed, immutable bundle: canonical spec JSON, compiled TS with pinned deps, helper/plugin lockfile, assets, preflight declaration, identity signature — `flow@sha256:…`, pushed to a bucket/registry. `flows deploy` points a trigger at a digest; `flows run flow@sha256:…` executes from the bucket on any cell, no checkout. Preflight runs at build time for everything build-provable and again at deploy time for environment facts (credentials, workers, MCP servers). The working tree is for authoring; **production only ever runs digests.**

## 5. Invocation: the gate-1 CLI

Gate 1 ships three CLI verbs over the journal protocol:

```text
flows check [--json] <flow.yaml|spec.json>
flows run [--json] [--data-dir <dir>] <flow.yaml|spec.json>
flows resume [--json] [--data-dir <dir>] <run-id>
```

`check` compiles and preflights without starting a run. `run` performs that
same preflight before contacting `relayflowd`, then submits the compiled spec
to `<data-dir>/relayflowd.sock`; `resume` asks that daemon to continue an
existing run from its journal. The data directory defaults to `.relayflowd`.
Neither verb starts the daemon implicitly. `--json` writes one report-shaped
object to stdout while diagnostics remain on stderr.

The exit codes are part of the surface contract:

| Exit | Outcome |
|---:|---|
| `0` | The run completed with `completionReason: success`. |
| `1` | The run failed with a declared `completionReason`, or a transport, runtime, or daemon protocol error left the outcome unknown. |
| `2` | The command was refused before a journal write: invalid input, failed preflight, unreachable daemon, or a `run_not_found` resume target. |
| `3` | The run parked. `PARKED [run_parked]` names the step and its `llm` or `agent` type, and distinguishes an unavailable worker from a `needs_human` recovery wait. |

At gate 1 no `llm` or `agent` worker is attached by the CLI. Reaching either
step therefore returns the durable parked outcome instead of hanging or
reporting success. Event, schedule, deployed-digest, HTTP, SDK-call, and
flow-to-flow invocation remain later-gate surface work; they are not shipped
by this CLI.

When a worker is attached, the CLI follows the typed snapshot while its lease
is live and prints `WAITING [worker_lease]` with the step and lease deadline.
If the lease expires without a completion, the command fails closed instead of
polling forever. A manual-recovery agent whose worker dies parks in
`needs_human`; the same exit-3 report says it is waiting for human recovery.

`flows resume` reports `run_unavailable` only when relayflowd returns the
typed `run_not_found` refusal. A dropped connection, request failure, or
`journal_write_failed` response exits 1 as `protocol_error`, because the
journal may already have changed and the CLI cannot honestly claim the resume
was refused before a write.

## 6. Open surface questions (for gate-1 SDK work)

- `gate:` in YAML: tiny expression language (`length < 200`) vs named checks only. Leaning: a deliberately small expression grammar + named checks for everything else.
- Are YAML helper verbs (`slack:`, `mcp:`) core spec vocabulary or compile-time expansion into `run`/effect steps? Leaning: expansion — the kernel spec stays seven words; helpers stay a surface concern.
- Helper generation cadence: generated from relayfile adapter manifests at build time vs published per-adapter packages. Leaning: generated, with hand-tuned verb names for the top providers.
