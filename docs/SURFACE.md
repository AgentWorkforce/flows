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
2. **Gates are postfix on the step they guard.** Never a separate machinery
   block. A named data gate lowers to the guarded step's existing kernel
   `verification`; an author callback remains TypeScript runtime code. The
   distinction is explicit in the gate contract below.
3. **Helpers, not primitives.** Authors never see mount paths, tokens, or protocol frames. Named helpers wrap every substrate:
   - `f.slack` / `f.github` / `f.linear` / … — **generated from the relayfile adapters** (50 providers → 50 namespaces for free), each verb compiling to a mount write. The receipt a helper returns *is* the journaled effect record (RFC Appendix A), so exactly-once dedup rides along invisibly.
   - `f.memory` — relayhistory: `f.memory.recall(query)`, `f.memory.why(task)`, `f.memory.learn(finding)`.
   - auth — relayauth: never called directly; `workspace:` / `tools:` declarations compile to path-scoped tokens ("the filesystem paths *are* the permissions").
   - `f.mcp` — one line to declare (`tools: { mcp: [stripe] }`), one call to use (`f.mcp.stripe.create_invoice({...})`). Preflight connects to every declared server before the run starts.
   The first shipping slice supports stdio subprocess servers and http
   endpoints, discovered via a `mcp` map in `flows.json`. Tool inventory is
   captured at preflight and cached for the run; a call to an unknown tool
   name at runtime is `mcp_unknown_tool`. See flows#302.
   Helpers retain the closed kernel vocabulary: the SDK lowers each call to
   an agent effect step. Its completed output is an MCP receipt containing
   `type: "mcp"`, server, tool, input, output, and the argument-derived
   idempotency key. The effect protocol uses the kernel-issued attempt key;
   failed calls retain their MCP diagnostic in `trajectory_tail` and complete
   with `worker_error`.

   The first typed codegen slice covers Slack's four existing dispatcher methods.
   `Ctx` composes the generated helper namespace map; argument shapes come from
   the pinned relayfile ergonomic client and results retain journal-backed `Step`
   semantics. Run `npm run gen --prefix packages/surface` to regenerate; the
   regression typecheck checks byte-for-byte drift. Mapping/discovery generation
   and the other provider namespaces remain follow-up work; see
   [the generator notes](../packages/surface/src/helpers/README.md).

4. **`{{prev}}` / return-value chaining.** Output flows downward implicitly; naming steps is for reaching back, not bookkeeping.
5. **Headers are optional escalation.** identity, memory, budget, tools appear only when used. The empty header is the common case. [Budget headers and spend](BUDGET.md) specifies parsing, prices, journal attribution, and admission limits.
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
   case-sensitive `models` allowlist. When that file exists, `flows check`
   first refuses a declared model absent from that list as `model_unknown`,
   without starting the CLI. When no `flows.json` exists anywhere in the flow
   file's ancestry, inline named-agent declarations (`agents: { drafter:
   { cli, model } }`) proceed to the real CLI/model probe without a registry.
   A model declared directly on a step still requires the project allowlist.
   An existing config with no `models` field or an empty list remains an
   explicit policy and refuses unlisted models, including named agents.
   One pure first pass collects every model rejected by that policy and every
   unresolved step CLI
   before any CLI, command, executor, or daemon probe, independent of step
   order. This includes every named declaration, even when unused or shadowed
   by a step override. When a registry exists, only an allowlisted value
   reaches the live model-scoped probe above. The
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

   **Project-config discovery:** starting in the flow file's directory, `flows check` walks parent directories through the filesystem root and selects the first readable `flows.json`. That nearest file is the whole project config; it is not merged with outer files. Its schema is `{ "cli"?: <non-empty string>, "executors"?: <non-empty string>[], "models"?: <trimmed model string>[], "mcp"?: <server map> }`; unknown keys, malformed model entries, and duplicates fail closed as `config_invalid`. A nearer config therefore defines a self-contained nested project boundary and prevents accidental inheritance of outer credentials, executors, or model approvals. The selected path is printed with project-level resolutions and named in refusals; if it declares no `cli` or models, outer configs remain shadowed. At gate 1, a trigger executor is considered registered only when its name is present in this author-written `executors` array; `flows check` does not yet contact a registry, broker, or RelayCron, and absence is `no_executor`.

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

The declaration does not add a kernel primitive. Arbitrary JSON Schema does
not infer a TypeScript result type: the imperative structured `f.llm` overload
returns `unknown`, which author code narrows after runtime verification.

The authoring surface deliberately narrows `steps: []`: `flows check` refuses
it as `invalid_spec`, while the kernel accepts it. This is a chosen
authoring-time narrowing, not a kernel guarantee.

### Supported TypeScript LLM calls

The local authored executor supports these signatures:

```ts
f.llm(prompt: string, options: {
  output: Record<string, unknown>; // JSON Schema
  cli?: string;
  model?: string;
}): Step<unknown>;
f.llm(strings: TemplateStringsArray, ...values: unknown[]): Step<string>;
```

Run with `flows run chain.flow.ts --input '{}' --local-agent`. This attaches
both an agent worker and a workspace-free LLM worker for the authored body.
The LLM step remains `type: llm` in the journal. It uses the same CLI resolution,
authentication probes, and exact `flows.json` model allow-list as agent steps;
a declared `model` must be in that project's `models` array. A template call
such as ``await f.llm`Summarize ${text}` `` returns text. The structured overload
parses JSON and checks `output` before submitting a successful completion;
the kernel independently checks the schema before accepting the output.
Invalid JSON or a schema mismatch completes with `verification_failed` and
prevents downstream work. Retry and lease handling use the existing kernel
policies; this overload introduces no separate retry contract.

```ts
import { flow } from '@relayflows/surface';

function shellWord(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export default flow('message-chain', async f => {
  const value = await f.llm('Return a greeting as JSON.', {
    output: {
      type: 'object', required: ['message'],
      properties: { message: { type: 'string' } },
    },
  });
  if (typeof value !== 'object' || value === null
      || !('message' in value) || typeof value.message !== 'string') {
    throw new Error('Expected a message');
  }
  const draft = await f.agent('draft', { task: `Polish this greeting: ${value.message}` });
  await f.run(`printf '%s' ${shellWord(draft.summary)} > message.txt`);
  f.done('success');
});
```

CLI adapters execute headlessly: Claude disables tools and session persistence;
Codex uses its ephemeral, read-only invocation. Custom wrappers use the existing
identified session protocol. No workspace or agent recovery pins are assigned
to LLM steps. The local LLM registration is currently for authored TypeScript;
YAML LLM worker registration remains separate work. Postfix `.gate(callback)`
and resumable authored root orchestration remain unsupported; each authored
step has its own journaled run, as with the existing `f.run` / `f.agent` executor.

### Declarative output binding

A step's `input` map selects values from earlier steps' declared outputs:

```yaml
- id: draft
  type: agent
  instruction: Polish the greeting supplied in input.message. Return JSON.
  input:
    message: { step: extract, path: [message] }
    original: { step: extract }  # whole verified output
  output:
    type: object
    required: [message]
    properties:
      message: { type: string }
- id: write
  type: deterministic
  input:
    message: { step: draft, path: [message] }
  command: >-
    node -e 'require("node:fs").writeFileSync("message.txt",
    JSON.parse(process.env.FLOWS_INPUT).message)'
```

`path` is an array of literal object keys or non-negative integer array indices,
for example `[items, 0, title]`. Omit it (or use `[]`) for the whole output.
Selectors add dependency edges automatically; `dependsOn` can still add ordering
constraints. The compiler deduplicates overlapping edges and refuses cycles.
Source steps must precede their consumers in the step list: forward and self
references are refused at preflight. Unknown step IDs, undeclared paths, and
sources without an output schema are also refused before any run is submitted.
A source schema may use `output` or explicit `verification: { type: json_schema,
schema: ... }`. Selected paths must appear explicitly through `properties`,
`items`, or `prefixItems`; path inference through `$ref` or schema combinators is
not supported. An optional property that is absent from the actual verified
output fails the consuming attempt with `worker_error` before its command or
worker executes.

The kernel resolves selectors from successful `step.completed` journal entries.
The declarative flow remains one durable run: after interruption, resume reads
the original source output and does not execute a completed source again.
JSON values retain their types, including arrays, numbers, booleans, and null.
Agent/LLM workers append the resolved map after the prompt and any memory pack:

```text
input:
{"message":"hello","original":{"message":"hello"}}
```

Deterministic commands receive the entire map as JSON in `FLOWS_INPUT`. The
executor never interpolates upstream values into shell source. Quotes, newlines,
`$()`, and backticks stay data. Parse the environment value in the command, or
use `printf '%s' "$FLOWS_INPUT"` to write the whole map. Ambient `FLOWS_INPUT` is
removed when a deterministic step has no binding. `${{ ... }}`, `{{prev}}`, and
`{{steps...}}` are not supported substitutions in the canonical dialect.

This complete provider-free example runs with `flows run binding.yaml`:

```yaml
version: '0.1.0'
steps:
  - id: extract
    type: deterministic
    command: printf hello
    verification:
      type: json_schema
      schema:
        type: object
        properties:
          stdout_tail: { type: string }
  - id: write
    type: deterministic
    input:
      message: { step: extract, path: [stdout_tail] }
    command: printf '%s' "$FLOWS_INPUT" > message.json
```

Deterministic outputs retain their existing process-result shape, so this
example selects `stdout_tail`. JSON-emitting agent/LLM outputs use their declared
value shape directly. Use matching SDK and kernel builds for input bindings;
older kernels refuse the new field.

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

**Disclosure: this package replaces `Promise.all` while a flow is open.** The
lifecycle installs its own `Promise.all` on the global `Promise` for the
duration of any authored flow execution, and restores the original when the last
concurrent flow closes.

- *Why:* a combinator's aggregate has no runtime edge back to its non-final
  members, so `await Promise.all([a, b])` cannot otherwise be proven to have
  consumed `a`. The alternatives all infer group membership from the callbacks
  the combinator passes each element, which is exactly the callback-identity
  inference this contract exists to refuse.
- *Scope:* process-wide, for the lifetime of an authored flow execution. Any code
  in the process — including yours and your dependencies' — sees the replacement
  during that window.
- *Behaviour:* the replacement delegates to the intrinsic and is specified to
  behave identically. A non-iterable argument is handed straight through, so
  `Promise.all(5)` and `Promise.all(null)` return the same rejected promises the
  intrinsic returns; `name` and `length` match. If `Promise.all` has already been
  replaced by something else, the flow refuses to start rather than fighting over
  the intrinsic.

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

The local build and verification commands are available now:

```text
flows build [--out <dir>] <flow.yaml|flow.ts>
flows build --verify <bundle-dir>
```

Output defaults to `dist/flows/<name>@sha256:<digest>/`. The canonical manifest
hashes the payload files; `manifest.json` and `identity.json` are excluded from
its entries to avoid circular hashing. A stable signing seed gives identical
identity bytes across builds. Ephemeral keys preserve the payload digest but
produce different identity signatures. An existing valid bundle is reused.
Verification refuses changed, missing, unlisted, or symlinked files with exit 2.

TypeScript builds require Bun on PATH and an installed npm workspace matching
its `package-lock.json`. The full lockfile is retained in this first slice.
A TS module can default-export a declarative spec, or default-export `flow()`
with an additional exported `spec` declaration for build-time checks. The
authored body is retained in the executable and is not run during build;
nonempty authored headers are currently refused. Module initialization must
be deterministic. `preflight.json` preserves the preflight report, including
uncollected environment facts; `metadata.json` separately records the platform,
compiler, executable asset paths, and checks deferred until deployment.

Signing uses `FLOWS_BUILD_KEY` or the repository's `.flows/build.key`, each a
base64 32-byte Ed25519 seed. Without either, stderr reports
`identity_ephemeral: bundle can be verified but not attributed`.
Deployment, remote upload, and execution by digest remain future slices.

## 5. Invocation: the gate-1 CLI

Gate 1 ships three CLI verbs over the journal protocol, plus one out-of-band
verb (`observer`) that mints an observer link without contacting the daemon:

```text
flows check [--watch] [--json] <flow.yaml|spec.json>
flows run [--json] [--no-spawn] [--data-dir <dir>] <flow.yaml|spec.json>
flows run [--json] [--no-spawn] [--data-dir <dir>] <flow.ts> --input <inline-json-or-file>
flows resume [--json] [--no-spawn] [--data-dir <dir>] <run-id>
flows observer [--data-dir <dir>]
```

`flows observer` prints a single `https://agentrelay.com/observer?key=<ot_live_...>`
URL to stdout using the same mint used by `flows run`. It is daemon-free: no
socket is opened, no `relayflowd` binary is invoked, the data dir is not
touched. Refusals (`no workspace key configured`, mint failure) print
`REFUSED [observer_link_unavailable] <reason>` on stderr and exit 2.

`check` compiles and preflights without starting a run. `run` performs that
same preflight before contacting `relayflowd`, then submits the compiled spec
to `<data-dir>/relayflowd.sock`; `resume` asks that daemon to continue an
existing run from its journal. The data directory defaults to `.relayflowd`.
`--json` writes one report-shaped object to stdout while diagnostics remain on
stderr.

`flows check --watch` checks once, then watches the target, its reachable
relative `use:` imports, and the nearest `flows.json` walking up from the
flow directory. Saves are debounced for 150 ms; a change during a check
schedules another check after it completes. Each re-check clears the screen
and prints the ordinary report. With `--json`, the screen is never cleared
and stdout streams one report object per line. Ctrl-C closes the watchers
and exits with the last check’s status (0 for a pass, 2 for a refusal).

`run` and `resume` attach to the daemon serving `<data-dir>` or start one
(kernel/DAEMON-LIFECYCLE.md). The attach is decided by the socket, not by a
file: `<data-dir>/connection.json` is read and validated, but nothing is
attached to until a `hello` is answered on the socket path recomputed from
`--data-dir`. When nothing answers, the CLI spawns `relayflowd serve
--data-dir <dir>` detached — in its own session, with stdio never inheriting
the CLI's and its stderr appended to `<data-dir>/relayflowd.log` — and polls
for it, bounded. Concurrent invocations are safe: the daemon holds an
exclusive lock on the data dir, so a redundant one exits without touching
anything and its CLI attaches to the winner.

`relayflowd serve` remains fully supported and unchanged for an operator who
starts it by hand; `run` and `resume` attach to it and never signal, restart,
or terminate a daemon. `--no-spawn` (or `FLOWS_NO_SPAWN=1`) refuses instead of
starting one — the lever for CI that means to assert a daemon is already
present. `check` never opens a socket and needs no daemon, no data directory,
and no `relayflowd` binary at all.

A `run` or `resume` that cannot get a daemon is refused before any journal
write (exit 2) and names which step failed: `daemon_unreachable` under
`--no-spawn`, `relayflowd_not_found` when no binary could be located,
`daemon_start_failed` when the spawned daemon exited during startup,
`daemon_start_timeout` when it never began serving, and
`daemon_protocol_mismatch` against a live daemon speaking another protocol
version — which refuses rather than starting a second daemon over it.

A direct `.flow.ts` run requires `--input`. When its argument names an existing
regular file, the CLI parses that file as JSON; otherwise it parses the argument
itself as inline JSON. Direct input is limited to 1,048,576 UTF-8 bytes; file
size is checked before the file is read. Missing, invalid, or oversized input is
refused before the CLI contacts `relayflowd`. After the journal connection is
established, the authored body receives the parsed value as its second argument.
Each awaited `f.run` executes through the journal-backed authored runtime, and
JavaScript control flow observes the output read from `step.completed`.
Unsupported headers, verbs, gates, and completion reasons fail closed rather
than running through a second speculative compiler.

The exit codes are part of the surface contract:

| Exit | Outcome |
|---:|---|
| `0` | The run completed with `completionReason: success`. |
| `1` | The run failed with a declared `completionReason`, or a transport, runtime, or daemon protocol error left the outcome unknown. |
| `2` | The command was refused before a journal write: invalid input, failed preflight, unreachable daemon, or a `run_not_found` resume target. |
| `3` | The run parked. `PARKED [run_parked]` names the step and its `llm` or `agent` type, and distinguishes an unavailable worker from a `needs_human` recovery wait. |

Without an attached worker, reaching an `llm` or `agent` step returns a durable
parked outcome. For authored TypeScript, `--local-agent` attaches both local
workers as described above. Event, schedule, deployed-digest, HTTP, SDK-call, and
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

## 6. The gate contract, and remaining open surface questions

The data/code split is settled: Relayflows does not have a serializable
expression language. YAML keeps the existing `verification:` spelling and may
name only checks that lower to the closed kernel fields available today:
`exit_code`, `output_contains`, and `json_schema`. `flows check` validates that
data—including compiling JSON Schema declarations with the kernel's supported
drafts—and prints the exact kernel checks for each step. "Preflightable" means
the declaration and its parameters are inspectable before execution; it does
not mean preflight can predict an output that does not exist yet.

`exit_code` applies only to deterministic steps; placing it on an `llm` or
`agent` step is invalid rather than an empty verification. JSON Schema
declarations accept both object and boolean schemas, matching the kernel. The
compiler snapshots and freezes authoring data before validation so accessors,
callbacks, proxies, `toJSON`, and other runtime behavior cannot change what the
journal serializes. Explicitly `undefined` object optionals are omitted, as in
JSON serialization and the v1 compiler; unsafe array values remain invalid.
The public preflight boundary performs that same compilation first and refuses
invalid raw input before running probes.
Exported unknown-input helpers follow the same rule: `validateSpec` reports a
failed validation without executing proxy traps or throwing,
`kernelToAuthoring` rejects non-inert kernel values before inspecting them, and
`canonicalize`/`specHash` snapshot before serializing — an identity computed
from a value that could change between two reads is not an identity.

A declaration is legal only if compiling it succeeds **and** validating with it
is guaranteed to terminate. A schema whose `$ref` graph cycles through only
in-place applicators (`$ref`, `allOf`, `anyOf`, `oneOf`, `not`, `if`/`then`/
`else`, `dependentSchemas`) re-applies to the same instance forever; it
compiles cleanly and then recurses without bound at verification time, which in
Rust aborts the process rather than raising anything catchable. Both sides
therefore refuse such a declaration up front with a named `unbounded $ref
cycle` error — before a journal exists and before the step's command runs.
Cycles that pass through a child applicator (`properties`, `items`,
`prefixItems`, ...) consume one level of the instance per step, so ordinary
recursive schemas stay legal. `kernel/relayflowd-core/src/schema.rs` and
`packages/sdk/src/json-schema-bound.ts` implement the same rule and are pinned to the
shared corpus in `testdata/json-schema-bound-cases.json`, so the kernel and the
SDK agree on which schemas are legal by construction. `verify` compiles through
the same gate, so a journal written before the bound existed fails its gate with
a verdict instead of taking the daemon down on every resume.

`schema: {}` and `schema: true` remain legal and remain accepted — but they
accept every possible output, so `flows check` marks the gate line
`[json_schema accepts any output]` and preflight emits a `vacuous_gate`
warning. A gate that judges nothing must not read like one that judges
something.

The kernel evaluates those checks. `run.spawned` carries the compiled
verification data and `step.completed.verification` carries its verdict, so
resume and time travel replay the journaled result rather than re-running an
author predicate. The v1 `verification:` shape remains supported and compiles
to the same kernel fields; no kernel verb or verification field is added by
this decision.

TypeScript may additionally accept a callback such as
`.gate(value => value.length < 200, "keep the summary short")`. That callback
is author code: `flows check` cannot prove it, YAML cannot serialize it, and
the journal cannot replay the closure. A TypeScript runtime must execute it as
runtime control flow and journal the resulting step outcome before dependents
continue. It must never stringify the function into a spec or silently label
it preflightable. Authors who need portable, inspectable gates use a named data
check; plugins may contribute named checks only by compiling them to existing
kernel primitives.

- Are YAML helper verbs (`slack:`, `mcp:`) core spec vocabulary or compile-time expansion into `run`/effect steps? Leaning: expansion — the kernel spec stays seven words; helpers stay a surface concern.
- Helper generation cadence: generated from relayfile adapter manifests at build time vs published per-adapter packages. Leaning: generated, with hand-tuned verb names for the top providers.
