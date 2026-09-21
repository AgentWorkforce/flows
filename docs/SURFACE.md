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
  if (!intent) return f.done("declined"); // nothing actionable to act on; the run still succeeds

  const plan = await f.agent("planner", {
    task: `Research and plan: ${intent}`,
    workspace: "acme/api",
    permissions: { accessPreset: "readonly" }, // validated declaration; currently unenforced
  });

  const ok = await f.human(`Ship this?\n${plan.summary}`, { to: "khaliq" });
  if (!ok) return f.done("declined"); // choose not to proceed after a negative answer

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

   **Agent channels (contract; initial post proof).** The target authoring API is
   `const channel = f.channel('review-panel')`, followed by
   `await channel.post('security-lens', 'this looks off at line 42')` or
   `await channel.recv('maintainability-lens', { timeout: '30s' })`.
   Each send and receive is one journaled effect boundary. Helpers lower to
   the existing agent effect record/confirm path, never a new `StepKind`.
   The message ID is the transport idempotency key; the kernel still uses its
   issued attempt key to authorize the effect claim. The broker transports
   messages; the journal records their truth and ordering.

   The initial internal SDK proof (`effect-channel.ts`) implements one post
   per declared agent step through Agent Relay's `messages.dm` interface,
   with the logical channel in message metadata. It validates recipients
   against a supplied participant inventory before producing the spec, and
   again before transport. Credentials stay in the supplied broker client;
   the completed output contains only the message envelope. A confirmed
   post can complete after interruption without fetching or resending it.
   An unconfirmed retry reuses the same broker idempotency key.

   This proof does **not** expose `Ctx.channel` yet. Public authored lowering,
   `flows check` participant discovery, receive/acknowledgement, concurrent
   per-channel ordering and a real broker SIGKILL/resume test remain follow-up.
   Automatic workspaces also remain follow-up: provision on first use with a
   run-ID-derived identity, inject credentials during step setup, retain on
   park until resume or lease expiry, clean up at terminal completion, and
   reconstruct broker state from journal after broker loss. The proof accepts
   an already provisioned run-scoped client and makes no workspace API changes.

   The first typed codegen slice covers Slack's four existing dispatcher methods.
   `Ctx` composes the generated helper namespace map; argument shapes come from
   the pinned relayfile ergonomic client and results retain journal-backed `Step`
   semantics. Run `npm run gen --prefix packages/surface` to regenerate; the
   regression typecheck checks byte-for-byte drift. Mapping/discovery generation
   and the other provider namespaces remain follow-up work; see
   [the generator notes](../packages/surface/src/helpers/README.md).

   The initial local memory slice supports `recall` and `why` in authored flows,
   with no journal step for either read. Script scope is stable across runs of
   the same flow file and name; reads cannot widen it to another flow. The
   existing `memory: { script: true }` header enables an eager reachability
   check; direct `.memory` use also triggers it. Aliased access is checked at
   call time. The local Node SDK and an existing readable SQLite DB are required
   (`AI_HIST_DB` overrides `defaultDbPath()`); JSONL fallback is disabled.
   `learn` and `memory: { agent: true }` refuse pending the journal-backed write
   and identity-scoped agent follow-ups. CLI-only operation is also deferred.

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
   boundary. CLI and model resolve independently. CLI priority is step → named
   declaration → flow → project config. Model priority is step → named
   declaration → registered adapter default. Claude's adapter default is
   `claude-opus-5`; Codex and custom wrappers have no default. Under a frozen
   dollar budget, a step whose model has no frozen price (or no model, as with
   Codex choosing its own) warns `budget_unmetered` and runs; it journals its
   tokens with `dollars_unmetered: true`, cannot cross the dollar limit, and
   still counts toward token limits. Pricing never refuses (see `BUDGET.md`).
   The worker explicitly removes ambient `RELAYFLOW_MODEL`; raw provider
   adapters use a model flag, while a custom wrapper receives an explicitly
   declared model only inside its identified same-process session.

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
   an event. Exceeding an armed bound is a refusal with `exit_code: null` and a
   diagnostic naming the bound, which the worker completes as `worker_error`.
   Three are always armed; the execution deadline is off unless a caller sets a
   positive one.

   | Bound | Default | Applies to | On exceeding |
   |---|---|---|---|
   | Handshake deadline | 10 s | From spawn until the wrapper has emitted both `relayflows-agent-cli-v1` and `relayflows-agent-cli-v1-execute` | Session refused: "did not identify as `relayflows-agent-cli-v1` within *N*ms" |
   | Handshake byte limit | 8192 bytes | Only the **un-terminated** residue of the handshake buffer — bytes not yet ended by a newline while the handshake is still open. Complete lines are drained first, so the execute token always ends the handshake before this is measured, and a result payload behind it is execution output governed by `maxOutputBytes`, not by this bound | Session refused: "exceeded the wrapper handshake limit of 8192 bytes before completing the `relayflows-agent-cli-v1` handshake" |
   | Execution deadline | **none** | From the execute token until the wrapper's output is complete. Off by default, so a wrapper-backed step gets the same duration a native `claude` or `codex` step gets, which is no constant of its own. A positive programmatic `executionTimeoutMs` arms it; `0` means no deadline and is not coerced back to a default | `SIGTERM`, then `SIGKILL` 1 s later; the reader settles on its own deadline whether or not the process closes its pipes. Refused: "execution timed out after *N*ms" |
   | `maxOutputBytes` | 1 MiB | Total captured stdout **plus** stderr after the execute token. Inclusive: exactly at the limit is accepted, one byte over is refused. Enforced on arrival, so an unbounded or newline-free flood is cut off by the reader rather than buffered | Session refused: "exceeded the captured output limit of *N* bytes" |

   Because the bounds are reader-owned, a wrapper that exits while leaving a
   descendant holding an inherited stdio pipe — which withholds Node's `'close'`
   event forever — is still bounded and still journals a `completionReason`.
   With no execution deadline the bound is the wrapper's **own exit**, not a
   constant: once the direct child has exited *and* the execute token has been
   consumed, the reader drains for 250 ms, finalizes the output it has, stops
   the wrapper's process group (`SIGTERM`, `SIGKILL` 1 s later) and settles on
   its own deadline whether or not `'close'` ever arrives. That settlement is a
   real result — the wrapper's own exit code and output, including a `null` code
   for a signalled death — not a refusal, because the wrapper did finish. Bytes
   arriving after settlement are discarded, and a protocol violation, an
   exceeded output limit, or an aborted lease during that window still outranks
   a successful exit. A descendant that had already detached into its own
   process group is reparented when the wrapper dies and is out of reach: the
   session is still bounded, but that process is not signalled and is not
   reaped. Wrappers should not leave descendants holding stdout or stderr.

   A positive programmatic `executionTimeoutMs` is unchanged by any of this: the
   session is bounded at that deadline and refuses, and the post-exit drain does
   not apply. The same session backs both `agent` and `llm` wrapper steps, so
   neither carries a wrapper-specific duration cap.

   What does bound a wrapper's duration is the same thing that bounds a native
   `claude` or `codex` step. The step's worker lease is *renewable ownership*,
   not a duration budget: a live worker keeps renewing it and never ages out of
   one, while a worker that dies stops renewing and the lease expires. The run's
   wallclock budget is separate and stops *new* work, draining whatever is
   already running rather than cancelling a step mid-flight. A wrapper step and
   a native step therefore get the same duration.

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
   values travel only in the post-identification session request. The model in
   that probe is the *effective* one: the step's, else the selected named
   agent's, else the adapter's own default. A default is probed because it is
   what would run; preflight still never guesses a model from host state, and a
   wrapper adapter has no default, so a wrapper step with no declared model is
   probed without one. Each resolution reports the CLI's source and the model's
   own source separately — `RESOLVED step "s" cli "claude" from step model
   "claude-opus-5" from adapter default` — so a defaulted model is never
   presented as one the step declared.

   **Deterministic model registry:** model existence is not inferred from a
   regex or provider prefix. The nearest `flows.json` owns an exact,
   case-sensitive `models` allowlist. When that file declares `models`,
   `flows check` first refuses an effective model absent from that list as
   `model_unknown`, without starting the CLI. The check governs the model that
   would execute, so an adapter default is checked exactly like a declared one;
   its refusal says the step declared no model and names the default, because
   the author wrote no `model:` to correct. When no `flows.json` exists anywhere
   in the flow file's ancestry, inline named-agent declarations (`agents: {
   drafter: { cli, model } }`) proceed to the real CLI/model probe without a
   registry. A config with no `models` field declares no model policy and
   enforces none — the same state as no config at all, so a flow that declares
   no model needs no edit to that tracked file to run. `models: []` is a
   different thing: an explicit empty allowlist, which refuses every model,
   including named agents.
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
   under `/bin/sh -c` because it may be a shell function. The probe looks past
   blank lines, `#` comments, `NAME=value` assignments and redirections to the
   first real command word; a POSIX special builtin or reserved word there
   (`set`, `export`, `cd`, `if`, `for`, `{`, `!`, …) is the shell's own and
   warns `unprovable_effects` instead, never `command_unresolved`. The narrower path-like missing-command refusal is also not yet
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

### Per-agent permissions in TypeScript

Supported `f.agent` calls accept an optional `permissions` declaration:

```ts
const draft = await f.agent("writer", {
  task: "Write drafts/post.md.",
  permissions: { fileGlobs: ["drafts/**"], accessPreset: "readwrite" },
});
const review = await f.agent("reviewer", {
  task: "Review drafts/post.md and flag issues; do not edit it.",
  permissions: { fileGlobs: ["drafts/**"], accessPreset: "readonly" },
});
```

The exported `PermissionsSpec` has three optional camelCase fields:
`fileGlobs?: string[]`, `networkAllowlist?: string[]`, and
`accessPreset?: "readonly" | "readwrite"`. Array elements must be nonempty
strings. Empty or partial declarations are accepted without inferred defaults;
no workspace is required. Workspace names must not carry permission suffixes.

These per-step permissions are validated and recorded in the compiled step spec
but are **not currently enforced** (gate 8 / #442). They are separate from
flow-wide `FlowHeader.workspace` / `tools.fs` scopes. The chief harness above
remains an aspirational example; this option does not make that entire harness
executable today.

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

### Command timeouts

`f.run(command, { timeout?: string | number })` gives each command its own
lease. The default is **30 seconds**. Use `await f.run(command, { timeout: '5m' })`
or `{ timeout: 300000 }` for longer work. Strings accept `ms`, `s`, and `m`;
the resolved value must be a positive whole number of milliseconds.

The hard ceiling is **15 minutes** (900000 ms), inclusive. A larger timeout
is refused during step compilation, before dispatch, with `lease_exceeded`;
malformed durations are refused with `timeout_invalid`. On reaching its timeout,
the kernel kills the command's process group and journals `completionReason: timeout`;
`f.run` refuses with code `lease_exceeded`. The override applies only to that
invocation; calls without options retain the default.

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
   it. `done("step_failed")` does not change that: it declares a verdict about
   checks the body ran and read for itself, and is not a way to continue past a
   step that failed.
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

### Initial plugin manifest and runtime

`flows add helper-datadog` installs `@flows/helper-datadog` in the nearest
`flows.json` project. See `testdata/plugins/helper-datadog/flows-plugin.json`
for the manifest and `packages/sdk/src/plugin-manifest.ts` for validation.
Successful installation records the package in `flows.json.plugins`; optional
`flows-plugin.d.ts` augments `@relayflows/surface`'s `Ctx` and is added to the
project's `tsconfig.json` include list (currently plain JSON configs).

This first slice supports `lowersTo: "effect"`. A plugin supplies an ESM
`src/index.js` exporting `execute(namespace, method, input, { idempotencyKey })`.
The SDK snapshots arguments, validates their JSON Schema, and executes the
provider through the existing journal-backed agent effect protocol. Providers
must honor the supplied kernel effect key. Credentials and HTTP(S) HEAD probes
run before authored flow bodies, including `flows check`.

Follow-ups: other primitive targets, trigger/gate dispatch (currently refused
with `plugin_unsupported`), manifest-driven type generation, JSONC tsconfigs,
plugin code bundling/pinning, declarative-flow plugin preflight, and restart
recovery of an interrupted plugin effect. Plugin effects currently inherit the
internal authored executor's child-run lifecycle, not a resumable authored root.

### Flow extensions: schema 2, `kind: "flow-extension"`

The same `flows-plugin.json` file carries a second kind. A **helper** plugin
(`kind` absent) extends `Ctx` with verbs and installs from npm as above. A
**flow extension** (`"schema": 2, "kind": "flow-extension"`) is a directory in
a public GitHub repository whose `entry` default-exports `flow()` and declares
what it will contribute to a base flow — `extends.handlers` (its `.on()`
pairs), `extends.hooks` (named points the base calls), `triggers` (validated
against the surface event registry, refused with `plugin_event_unroutable`
otherwise), `permissions` (integrations, harnesses, mcp, declared-but-unenforced
`writes`, a budget ceiling), `compat` (semver ranges for surface and sdk, and
the base flows it extends), and the same mandatory `preflight`. Validation is
`packages/sdk/src/flow-extension-manifest.ts`; the worked Babysitter manifest is
`testdata/plugins/extension-babysitter/flows-plugin.json`.

```text
flows add github:<owner>/<repo>@<ref>#<path>      # or https://github.com/<owner>/<repo>/tree/<ref>/<path>
flows plugin list [--json]
flows plugin verify [--json] [--offline]
flows plugin remove [--json] <name>
flows plugin update [--json] [--yes] [--to <ref>] [<name>]
```

`flows add` resolves the branch, tag, or commit to a 40-hex sha through
unauthenticated public GitHub reads (a private repository answers 404 and is
reported as `plugin_source_unresolved`), enumerates the tree at that commit —
refusing symlinks, submodules, traversal, a truncated listing, files over
256 KB, or plugins over 2 MB — downloads each blob pinned to the sha, checks
byte counts, and computes the content digest as the sha256 of the same
canonical `[{bytes,path,sha256}]` manifest a sealed bundle uses. The bytes are
materialized under `.flows/plugins/<name>@sha256:<digest>/`; `flows.json.plugins`
gains the canonical `github:<owner>/<repo>@<sha>#<path>` (a branch or tag is
never persisted); and `flows.lock.json` (version 2) records name, version,
source, digest, manifest hash, and the declaration order that will be the
composition order. `flows plugin verify` re-hashes the store against the lock
and, unless `--offline`, re-fetches the pinned commit; any difference is
`plugin_source_drift`, exit 2.

**Composition.** `loadAuthoredFlow` (the path under `flows check`, `flows run`,
and the authored root) composes the project's extensions onto the base flow
(`packages/sdk/src/flow-extension-loader.ts`), in this fixed order: the
declaration and the lockfile must agree; the store is re-hashed against the
lock's digest and the manifest bytes against its manifest hash — nothing under
`.flows/plugins` is read as code before that passes; the manifest is validated
and its `compat` checked against the runtime and the base flow (`FlowHeader.version`
is matched when present; without it only `*` is satisfiable; a budget ceiling
above the base is `plugin_incompatible`); only then is the entry imported, its
handlers checked against the manifest's declared triggers (an entry cannot
subscribe to more than it declared), and appended **after** the base's own
handlers in lockfile order. Named `hooks` exports are matched to
`extends.hooks` and to the base header's `hooks` list; `f.hook` AND-composes
them in lock order. Nothing replaces, reorders, or widens a base handler, and
the base's definition object is untouched. `flows check` prints one `EXTENSION`
line per composed extension. Not composed by this release, and refused with
`plugin_unsupported` rather than ignored: an entry `use:` header, schedule
triggers, and gates; a generic `webhook(...)` handler is refused as
undeclared. Cloud deploy and hosted runs send composed extensions in the request body
(`extensions[]`, 2 MB cap, `--plugin` is send-only). Handler bodies still
execute nowhere (#301); what composition changes today is the declared
trigger set that `flows check`, requirements, and future dispatch read.

GitHub `pull_request.ready_for_review`, `pull_request.labeled`, and
`pull_request.unlabeled` are **not** in the surface registry. The registry is
generated from the pinned relayfile adapter mappings (`scripts/generate-triggers.mjs`);
this repo cannot add those actions without an adapter-package change. A
Babysitter manifest that declares them is refused `plugin_event_unroutable`
until that upstream catalog grows.

## 4. Build: the immutable bundle

`flows build` seals a flow into a content-addressed, immutable bundle: canonical spec JSON, compiled TS with pinned deps, helper/plugin lockfile, assets, preflight declaration, identity signature — `flow@sha256:…`, pushed to a bucket/registry. `flows deploy` points a trigger at a digest; `flows run flow@sha256:…` executes from the bucket on any cell, no checkout. Preflight runs at build time for everything build-provable and again at deploy time for environment facts (credentials, workers, MCP servers). The working tree is for authoring; **production only ever runs digests.**

The first deployment slice supports `file://` buckets and self-contained
**declarative deterministic** bundles:

```text
flows deploy <name>@sha256:<64-hex-digest> --to file:///absolute/bucket
flows run <name>@sha256:<64-hex-digest> --bucket file:///absolute/bucket
```

Deploy reads `dist/flows/<name>@sha256:<digest>/` and publishes the complete
verified bundle at `<bucket>/<name>/sha256/<digest>/`. Re-deploy prints
`deploy_noop`; a partial copy is never published at the final path.
Run resolves `--bucket` before the nearest `flows.json`'s
`{"deploy":{"bucket":"file:///absolute/bucket"}}`. Verified payloads are cached
under `$XDG_CACHE_HOME/flows/bundles/<hex-digest>/`, falling back to
`~/.cache/flows/bundles/<hex-digest>/`. Every cache hit is verified before use.
The canonical spec goes through the existing journal run path with command
preflight before any daemon connection. Local authoring files are unnecessary.
Refusals exit 2; transport failure after copying starts exits 1 (`deploy_partial`).

**Remaining work for #333:** S3 transport, trigger digest binding and conflict
checks, authored TypeScript execution, assets and placement, agent/LLM environment
preflight, and separating build-provable checks from environment checks.
Unsupported bundle execution is refused with `bundle_unsupported`; this slice
does not claim to implement the full production-digest contract above.

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

Gate 1 ships three CLI verbs over the journal protocol, plus two out-of-band
verbs: `observer`, which mints an observer link without contacting the
daemon, and `status`, which reads a run's journal without one:

```text
flows check [--watch] [--json] <flow.yaml|spec.json>
flows run [--json] [--no-spawn] [--data-dir <dir>] <flow.yaml|spec.json>
flows run [--json] [--no-spawn] [--data-dir <dir>] <flow.ts> --input <inline-json-or-file>
flows resume [--json] [--no-spawn] [--data-dir <dir>] <run-id>
flows answer [--json] [--no-spawn] [--data-dir <dir>] [--note <text>] [--by <identity>] <run-id> <wait-id> <yes|no>
flows observer [--data-dir <dir>]
flows status [--json] [--data-dir <dir>] [--tail <n>] [<run-id>]
```

Three further verbs read a **hosted** run over the Cloud API rather than a
journal. They are documented in [CLOUD.md](CLOUD.md#reading-a-hosted-run):

```text
flows runs [--limit <n>] [--json]
flows logs [--step <name>] [--raw] [--json] <run-id>
flows status --cloud [--json] <run-id>
```

### Agent sidechannel (initial byte-stream slice)

Local agent workers (`flows run --local-agent`) open
`<data-dir>/runs/<run-id>/steps/<step-id>/pty.sock` for the raw Claude/Codex
adapters and print `PTY <path>` on stderr. SDK workers opt in with `dataDir`
and can receive the path through `onPtyReady`. Run and step IDs come from the
kernel dispatch, including for authored `f.agent` calls.

A subscriber sends `HELLO view\n`, `HELLO drive\n`, or
`HELLO passthrough\n`, then receives live stdout/stderr bytes. View and
passthrough are passive. Only drive forwards subsequent bytes to child stdin.
In this pipe-based slice, a drive greeting must arrive within 100ms of child
startup. Without one, the worker closes stdin so unattended and passive-view
agents receive EOF. Later drive greetings are rejected without marking human
intervention; a closed stdin pipe cannot be reopened. Supporting drive attachment
at arbitrary times requires a future terminal/session transport. Drive readers
pause while child stdin writes flush, preserving input under backpressure.
There is no backlog, terminal resize, or framing after the greeting. Socket
access is restricted to the worker's OS user. Slow, malformed, excess, and
broken subscribers are disconnected independently; absent subscribers or an
unavailable socket do not fail a step or change its lease/deadline handling.

Operator input stays off journal. Influenced output follows the usual worker
output decoding and completion path. Any accepted drive greeting marks
`step.completed.human_intervention: true`, even without input. Passive and
unattached completions omit the field. The marker persists on failed attempts
as well, and marked completions are excluded from cross-run memoization.

`flows resume` refuses marked runs with exit 2 and
`REFUSED [human_influenced_run] step "<id>"` before recovery, unless passed
`--allow-human-influenced`. The same flag permits `flows replay` to cross a
marked completion; replay may already have printed earlier entries when it
refuses. `--at` can still inspect a prefix before that boundary. The flag is
per invocation and does not clear the journal marker.

**Follow-up scope:** this minimal slice forwards the existing process pipes;
it does not yet allocate an actual terminal. True PTY/resize support,
wrapper-session attachment, crash-safe intervention recording before a worker
completion, and the companion `agent-relay attach --external-pty` client are
follow-ups. Long UNIX socket paths and stale socket files disable this optional
channel; they do not prevent agent execution.

`flows observer` prints a single `https://agentrelay.com/observer?key=<ot_live_...>`
URL to stdout using the same mint used by `flows run`. It is daemon-free: no
socket is opened, no `relayflowd` binary is invoked, the data dir is not
touched. Refusals (`no workspace key configured`, mint failure) print
`REFUSED [observer_link_unavailable] <reason>` on stderr and exit 2.

### Reading a failed step

Step-failure messages share the evidence clauses below. A declarative run
uses the opening shown here; an authored child failure opens with
`journal step "<step-id>" completed with <reason>` before the same evidence.

```text
FAILED [step_failed] Run "<run-id>" failed with completionReason: step_failed.
 Step "<step-id>" (<type>) completionReason: <reason> attempt=<n>/<budget> exit=<code>.
Detail: <the worker's own account, when it left one>
Stdout (last 1,024 bytes):
<tail>
Stderr (last 1,024 bytes):
<tail>
Transcript: <path>
Inspect: flows replay <run-id> --at <step-id>
Journal: <data-dir>/runs/<run-id>.sqlite3
```

Each clause is present only when the journal holds the fact behind it; nothing
is defaulted. The same fields appear as named keys on the `--json` diagnostic
(`stepId`, `stepType`, `completionReason`, `attempt`, `maxIterations`,
`exitCode`, `stdoutTail`, `stderrTail`, `detail`, `transcriptPath`, `hint`,
`journalPath`), so the rendered line and the machine-readable record carry the
same facts rather than the message being the only copy.

`attempt=<n>/<budget>` is read from the journal, not from the spec: `n` is the
`step.attempt.started` envelope's attempt number and `budget` is the
`max_iterations` that attempt was started against. It is printed beside the
completion reason because `retries_exhausted` is the kernel's word for
"the attempt budget is spent" and does not imply that any retry happened — a
step with the default budget exhausts it on its first failure, and reads
`attempt=1/1`.

`Inspect:` is derived from the run id alone, so it is still printed when the
evidence itself could not be read. In that case the message says so —
`Could not inspect the failed step: <reason>` — beside the step failure rather
than in place of it.

**Authored bodies.** Each `f.run`, `f.agent` and `f.llm` operation creates a
child kernel run with its own journal, so `Inspect:` names the child, not the
authored root. These operations and lowered predicate gates are indexed on the root's
`authored-steps` durable stream as it happens: one
`relayflows.authored-step.v1` record naming the authored step id, the child
run id and its state, appended when the child is admitted and again when it
completes. Admission is indexed once `run.start` returns the child's id,
before waiting for an agent or LLM child. Deterministic children execute
inline, so their admission is indexed after that execution returns. A crash
before the `run.start` response or index append can still leave an unindexed
child. Helper-provider, MCP and plugin-effect children are not yet included
in this index. Once appended, the index survives process exit and is readable from
the journal on disk, including after a cooperative nonzero exit.

An authored step-failure JSON report keeps the child in `runId` and adds
`rootRunId` for the durable authored root. Consumers must use `rootRunId` for
the resume pointer and root index, and `runId` for the failing child's evidence.
The root driver assigns this field after any Node-child IPC boundary.

Cloud must separately collect these journals before tearing down a failed
sandbox. The index alone does not persist Cloud step rows or provide a
deterministic command's Cloud log endpoint.

### Run self-inspection: `flows status`

`flows status` is what a step can see about its own run. By default it reads
exactly one file — `<data-dir>/runs/<run-id>.sqlite3`, through the same
copy-then-verify snapshot `flows replay` uses (`--tail` additionally reads the
attempt transcript-tail files described below, and nothing else) — and folds it
into the run's status, each step's
state / attempt / lease / backoff / wait, the last completion's reason, gate
verdict and (redacted, ≤ 1 KiB) detail, a summary of the attempt's journaled
transcript digest, spend and step counts. It never opens the run
registry, `connection.json`, the daemon socket or the network, never spawns
a daemon, and holds no credential: the journal is on the same filesystem as
the process asking. It does not inherit `replay`'s `human_influenced_run`
refusal, since it re-executes nothing.

The transcript summary comes from the digest the worker journals in
`trajectory_tail.transcript` on every agent attempt: the model, turn and tool
counts, the provider's own cost, and the path, size and truncation flag of the
full per-attempt transcript file — plus the failure excerpt when the attempt
failed. `flows status` never prints the transcript itself; it points at the
file. The digest's strings were redacted when it was built and are redacted
again here. An attempt that journaled no digest (an `llm` step, or a run that
predates the digest) shows no transcript line and reports `null`.

Discovery: an explicit `<run-id>` (with `--data-dir`, default `.relayflowd`),
else `RELAYFLOW_RUN_ID` and `RELAYFLOW_DATA_DIR` from the environment, else
`REFUSED [run_unknown]` and exit 2. Every direct or wrapper agent attempt that
has a data dir is spawned with four non-secret names — `RELAYFLOW_DATA_DIR`
(absolute), `RELAYFLOW_RUN_ID`, `RELAYFLOW_STEP_ID`, `RELAYFLOW_ATTEMPT` — so
a bare `flows status` inside a step resolves that step's run and marks it
`← this step`. Without a data dir the four are absent, not empty; an ambient
value from an enclosing step never passes through. A spawn that names no
attempt sets the other three and leaves `RELAYFLOW_ATTEMPT` absent rather than
empty — the run and step are what resolve the view; the attempt only picks a
transcript tail. With these an agent can
open its journal and nothing else.

Exit codes: 0 rendered; 1 rendered but a section could not be read (`partial`
non-empty, e.g. `journal_read_failed` after a mid-journal parse error); 2
refused (`run_unknown`, `run_not_found`, `journal_busy` after five 50 ms
retries against a mid-flight writer, and the other `replay` refusals).

`--json` emits one canonicalised object (`v: 1`). Its schema has no field for
step instructions, input bindings, output bodies, wake contexts, pins or
effect refs, so their absence is structural. `LEASE OVERDUE by <t>` in the
text view is computed from the journaled lease deadline and the wall clock
alone — a local dead-man that needs no daemon.

`--tail <n>` renders the last *n* lines of this attempt's stdout and stderr
after redaction. Every direct agent attempt with a data dir tees its
transcript into `runs/<run-id>/steps/<step-id>/attempt-<n>.{stdout,stderr}.tail`:
a 64 KiB ring, mode `0600`, rewritten whole at most four times a second, with
a header line naming the run, step, attempt and start time so a file left by
an earlier life of the data dir is never read as this attempt's. These files
are evidence, not the record — a write failure is one process warning and the
step completes exactly as before; the journal remains truth. They are not
written for wrapper or relay transport. On disk they are raw; the same OS
user can already read `pty.sock`.

Redaction (`redact.ts`) applies to every free-text field the view prints:
the value of any current env var whose name matches
`TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH` and is ≥ 8 chars becomes
`[redacted:<NAME>]`; relay, bearer, header, vendor and `NAME=value` token
shapes become `[redacted]` with their name kept. Identifiers — run and step
ids, hashes, env *names* — are never rewritten, so the view stays greppable.

What `flows status` cannot tell a hosted run is Cloud's: its Cloud run id,
sandbox and listener, and anything about sibling runs. Given that run id,
`flows status --cloud`, `flows runs` and `flows logs` answer the same
questions from the Cloud API, under the caller's own Cloud credential and with
the same redactor applied. See
[CLOUD.md](CLOUD.md#reading-a-hosted-run) and
[CLOUD.md](CLOUD.md#current-limits-and-scope).

Inside `flows run` and `flows resume` that same mint is fire-and-forget. It is
issued **once per invocation**, before the run, and its outcome reaches nothing
but stdout/stderr. A failed mint — including the `HTTP 429` a busy workspace
can return, since the mint shares one per-workspace, per-minute rate bucket
with every other Relaycast call — prints `[observer] token mint failed:
<reason>; continuing without an observer link (the run is unaffected)` and
changes nothing else. It cannot fail a step, alter an exit code, or affect
worker attach: per RFC-0001 settled decision 7 the observer link is a
projection, not a source of truth. The line says the run is unaffected
explicitly because it lands on stderr beside real failures, where the previous
wording (`skipping observer link`) read like a cause and cost debugging time.

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

An authored body ends at one of four lowered completions. `done("success")`
completes the run; `done("needs_human")` parks it for a human; and
`done("step_failed")` declares that the flow's own checks did not pass — the
adversary review found problems, the tests did not go green — and reports a
failed run. `done("declined")` deliberately chooses not to act on the input.
The first lowers to a no-op terminal marker, because the marker
run's own `success` is already the record; the other three lower to a
deterministic step that writes `{"completionReason":"<reason>"}` to stdout, so
the verdict is a durable journal fact rather than an inference. All four
terminal markers are steps that SUCCEED: `done("step_failed")` is the body's
verdict, not a step that failed, so the terminal marker does not fabricate a
failing step. Actual step failures still take precedence over authored verdicts.

`canceled` and `budget_exceeded` are in the type but are refused with
`unsupported_completion`. They are kernel outcomes, not authored verdicts: the
kernel records them when it cancels a run or exhausts its budget, and a body
that declared one would be asserting a kernel fact that never happened.

Use `if (!input.ticket) return f.done("declined")` for a no-input guard.
Declination describes a decision, not a promise of zero prior effects: inspection
or notification may already have happened. It cannot conceal an actual failed step.

Declination exits 0 with a completed, ok report and kernel
`completionReason: success`. The local report adds severity `declined`, kind
`run_declined` (text: `DECLINED [run_declined]`). The marker stdout and
authored-root output retain `completionReason: declined`; kernel step and run
reasons remain `success`. Cloud's client validator accepts this report shape,
but its current projection drops diagnostics: `getCloudFlowRun`,
`waitForCloudFlowRun`, and `--cloud --wait --json` cannot distinguish it from
ordinary success. This is not verification of a deployed Cloud runtime.

Consumer examples must wait for matching Surface/SDK releases, updated consumer
pins, and a Cloud runtime artifact that executes this vocabulary. The onboarding
guards in agentrelay.com require a separate rollout and verification.

The exit codes are part of the surface contract:

| Exit | Outcome |
|---:|---|
| `0` | The run completed with `completionReason: success`; deliberate declination also carries a `run_declined` diagnostic locally. |
| `1` | The run failed with a declared `completionReason`, or a transport, runtime, or daemon protocol error left the outcome unknown. A `step_failed` run names the failing step and its per-step `completionReason`, plus the exit code and output tails the journal recorded for it. An authored `done("step_failed")` exits `1` as well, and says so without naming a step, because no step failed — the body declared the verdict. |
| `2` | The command was refused before a journal write: invalid input, failed preflight, unreachable daemon, or a `run_not_found` resume target. |
| `3` | The run parked. `PARKED [run_parked]` names the step and its `llm` or `agent` type, and distinguishes an unavailable worker from a `needs_human` recovery wait. An authored body parked on `f.human` reports the question, who it is for, and the `flows answer` invocation that records the decision (see *Human gates* below). |

Without an attached worker, reaching an `llm` or `agent` step returns a durable
parked outcome. For authored TypeScript, `--local-agent` attaches both local
workers as described above. Event, deployed-digest, HTTP, SDK-call, and
flow-to-flow invocation remain later-gate surface work; they are not shipped
by this CLI. Schedules are: `schedule.cron(...)` / `schedule.every(...)` are
declared on a flow, lowered to the `flows.tick` subscription, printed by
`flows check` with the `flows tick start` invocation that drives a fixed
interval locally, and registered on Cloud by `flows schedule` (see
[`packages/surface/src/triggers/README.md`](../packages/surface/src/triggers/README.md)
and [CLOUD.md](CLOUD.md#schedules)). Dispatching the authored handler body
itself, locally or hosted, is still #301: the hosted fire runs the default body.

When a worker is attached, the CLI follows the typed snapshot while its lease
is live and prints `WAITING [worker_lease]` with the step and lease deadline.
If the lease expires without a completion, the command fails closed instead of
polling forever. A manual-recovery agent whose worker dies parks in
`needs_human`; the same exit-3 report says it is waiting for human recovery.

### Human gates: `f.human`

```ts
const ok = await f.human(`Ship this?\n${plan.summary}`, { to: "khaliq" });
if (!ok) return f.done("declined");
```

`f.human(question, { to })` is the declared approval gate of RFC covenant 3.
It is not a child run. When the body reaches it with no answer on record, the
ROOT attempt parks on the kernel's durable `wait.human` (DESIGN.md §1.5) under
the call's own ordinal (`human-N`, counted with every other authored
operation), the lease is released, and the run is `parked` — exit 3, with a
`humanWait` field in the JSON report and a diagnostic that reads:

```
PARKED [run_parked] Run "<run-id>" is waiting for khaliq to answer human-2: "Ship this?\n…"
Answer with: flows answer <run-id> human-2 yes|no
Then continue with: flows resume <run-id>
```

No process waits. `flows answer <run-id> <wait-id> yes|no [--note <text>]
[--by <identity>]` records the decision as the answer contract `{ answer:
boolean, note?, answeredBy }` (`answeredBy` is `--by`, else the OS user; the
kernel refuses an unattributed answer, journals `attribution: client_asserted`
because the socket — not the kernel — authenticated the caller, and stamps
`at_ms` from its own clock, dropping any client-supplied time) — an `event.emit` keyed by the wait id, which the kernel
journals as `wait.completed{human_responded}` and closes the wait once: a
second answer is refused (`human_wait_unknown`), as is a wait the run is not
asking. `flows resume` then re-runs the body; every step before the gate is
memoized under its admission key, so nothing upstream repeats, and `f.human`
resolves from the journaled answer. The boolean the author branches on is
lowered as a `human-N` deterministic step carrying the answer on stdout, so it
is journal evidence in the same shape as every other authored step. A `no` is
a value the body decides on — `done("declined")` exits 0 — never a failure.

`to` names who is asked. It is recorded with the question and reported as
`humanWait.recipient`, parsed into one of four forms — the delivery contract
Cloud acts on (the local kit records it and delivers nothing):

| `to`              | Cloud delivers                                              | who may answer          |
|-------------------|-------------------------------------------------------------|-------------------------|
| `"slack:#eng"`    | a message in that channel                                   | anyone in the channel   |
| `"slack:@khaliq"` | a DM to that Slack user                                     | that user               |
| `"github:@khaliq"`| a comment on the triggering issue / PR, mentioning them     | that user               |
| `"khaliq"`        | the deploy's approver, on the channel the run was triggered from (the Slack thread, or the GitHub issue / PR) | that user |

Anything else — `slack:` with no target, `github:#eng`, an unknown provider,
a handle with spaces — is refused at the call as `human_to_invalid`, before an
ordinal is consumed or anything is journaled, rather than parking the run on a
question that can reach no one.

The person answers **where they were asked** — `yes` / `no` as a reply in the
Slack thread (or ✅ / ❌ on the message), or `@relay yes` / `@relay no` as a
comment on the issue — and Cloud records it as the run's answer and resumes
the run; the dashboard is never required. A literal `slack:` or `github:` `to`
is a requirement of the flow (`flows check` prints `slack (f.human to)`) and
`flows deploy` asks to connect it before activating. A computed `to`
(`input.approver`) is resolved by Cloud at park time.

Locally, authority is the journal socket: whoever can reach the daemon can
answer, and `answeredBy` records the OS user who did. On Cloud the same wait is
answered through the run's answer route — by the delivered channel above, or
`POST /api/v1/workflows/runs/<id>/answer` — with the answerer's identity
(`slack:@handle`, `github:@login`, or the Cloud user). `timeout` is not yet
enforced (DESIGN.md §1.4). `f.dispatch` still fails closed as
`unsupported_verb`.

`flows resume` reports `run_unavailable` only when relayflowd returns the
typed `run_not_found` refusal. A dropped connection, request failure, or
`journal_write_failed` response exits 1 as `protocol_error`, because the
journal may already have changed and the CLI cannot honestly claim the resume
was refused before a write.

A step that ran and failed is **not** one of those. It reports `step_failed`
with `status: failed`, for every step type and for authored TypeScript flows
as well as declarative ones. `protocol_error` is reserved for an outcome the
CLI genuinely could not establish; using it for a known step failure both
blamed the daemon for a healthy run and left the report with no `status`, so
the summary line read `RUN <id> unknown` about a run whose outcome was exact.

Every `step_failed` report ends with the `flows replay` invocation for that run
and, when a data dir is known, the path of the journal holding it. That footer
is derived from the run id alone, so it is present even when the evidence could
not be read or the failure shape was not recognised — a failure the CLI cannot
explain still says where the record is rather than ending the trail.

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

TypeScript additionally accepts a callback such as
`.gate(value => value.length < 200, "keep the summary short")`. That callback
is author code: `flows check` cannot prove it, YAML cannot serialize it, and
the journal cannot replay the closure. The authored runtime executes it as
runtime control flow — once, in the authoring process, on the value read back
from the step's `step.completed` — and journals the verdict as a lowered
`<step>.gate` deterministic step: a passing predicate journals
`{"gate":"predicate","step":"<id>","verdict":"pass","because":…}` as that
step's stdout with exit 0; a failing one (or one that throws) journals
`"verdict":"fail"` on stderr with exit 1, and the run fails as `gate_failed`
naming the step and the author's reason. Dependents therefore wait on a
journaled fact, and resume/replay read that fact rather than re-running the
closure. The function is never stringified into a spec, and `flows check`
prints no gate line for it — a predicate is runtime-only and unprovable
before execution, by construction. A step takes one `.gate()`. Authors who
need portable, inspectable gates use a named data check; plugins may
contribute named checks only by compiling them to existing kernel primitives.

`artifact_exists` is the named gate for "the agent wrote this file":
`.gate({ type: 'artifact_exists', path: 'review/security.md' })`. The worker
that spawned the agent CLI snapshots the agent's working directory before the
run and content-diffs it after, and journals the changed paths as
`output.artifacts` on the agent's `step.completed`; `AgentResult.artifacts`
is read from that journal entry, never from a later look at the disk, and the
gate lowers to a deterministic step that checks the journaled list. An agent
whose final message is a JSON object owns its output shape and journals no
artifacts; gate such a step on a deterministic check instead. The relay
transport journals none, because the agent ran on another host.

What the scan reports is every **regular file** under the working directory
that is new, or whose content changed, between the two snapshots — content
(size + sha256), not mtime, so a rewrite inside the filesystem's timestamp
resolution still counts. Symlinks are not followed. Three entry names are
skipped, matched **exactly**, at any depth, before the entry's type is
consulted: `.git` (a directory, or the regular file a linked worktree has),
`.relayflowd` (the default data dir) and `node_modules`. Exact names, not
prefixes — `.github`, `.relayflowd-notes` and every other author-chosen name
that merely starts the same way is scanned normally.

**Dot-directories are artifacts.** `.workflow-artifacts/` is the conventional
place a flow tells its agents to write, so
`.gate({ type: 'artifact_exists', path: '.workflow-artifacts/x/y.md' })` is an
ordinary gate and the path appears verbatim in `output.artifacts`. An earlier
scanner skipped every entry whose name began with a dot; that made a whole
class of author-chosen paths invisible to the journal, and a gate naming one
could never pass — it failed on a file that was sitting on disk, with nothing
in the completion to say why (flows#512).

The diff is of the working directory, not of what the agent did, so anything
written under it during the attempt is an artifact by default — including files
the runtime itself writes, and writes by any unrelated process that happens to
touch the tree. A content hash proves a change during the interval; it does not
prove the agent made it. The worker's own per-attempt evidence lives under
`<data-dir>/runs/<run-id>/steps/<step-id>/` (the transcript file, the
`attempt-<n>.<stream>.tail` files and the `.tmp` each tail is staged as), and a
local `--data-dir` inside the project puts all of it inside the scanned tree —
under any name the caller chose, which is usually not one of the three skipped
above. So `packages/sdk/src/worker-cli.ts` drops the **entire configured data
directory subtree** from the diff, comparing symlink-resolved paths against the
data dir the step was dispatched with. That is the attempt's own identity, the
same input that decides where each file is written, so the exclusion cannot
drift from the files. Deriving it from anything the run *produces* is a mistake
worth naming: an earlier version listed each runtime-written file by name and
read the transcript's path off `result.transcript.file`, which `finish` omits
when the close outruns its deadline or the attempt aborts, so the exclusion
lapsed on exactly the paths where the file is slowest to finish and most likely
to still be sitting there. A subtree exclusion has nothing to enumerate and so
nothing to forget.

Pollution of that list is silent by default. `step.complete` bounds
`trajectory_tail` and passes `output` through verbatim
(`kernel/relayflowd/src/server.rs`), so the kernel accepts whatever list the
worker sends and the run succeeds with it journaled as the agent's
`output.artifacts`. It only becomes loud where something reads that list: an
`artifact_exists` gate on a path that is now crowded, or a flow body that
asserts on `AgentResult.artifacts` — which is how the data-dir case was caught
at all, by `packages/sdk/tests/agent-transcript-live.test.ts` failing its own
`artifacts.length !== 0` check.

- Are YAML helper verbs (`slack:`, `mcp:`) core spec vocabulary or compile-time expansion into `run`/effect steps? Leaning: expansion — the kernel spec stays seven words; helpers stay a surface concern.
- Helper generation cadence: generated from relayfile adapter manifests at build time vs published per-adapter packages. Leaning: generated, with hand-tuned verb names for the top providers.
- `on` inside a running body (subscribe after start, buffer events while a step runs, end on `idle`/`deadline`). Proposed in [`docs/EVENT-AWAIT.md`](EVENT-AWAIT.md); motivating case is a flow that babysits the PR it opened.

## 7. Broker transport covenant

Broker interactions with a v2 flow are legal only as journaled effect steps.
Any bypass of that journaling makes the run non-replayable and must set
`step.completed.human_intervention: true`.

This is the required contract for channel rollout. Detecting bypasses and
carrying that marker through the completion protocol remain implementation
work; the initial post proof does not claim to enforce uninstrumented agent I/O.


### Standalone authored runtime

The standalone CLI embeds the Node authored runner in the same hashed executable.
Authored `.flow.ts` bodies require Node **22.14 or newer** on `PATH`, or an
absolute `FLOWS_AUTHORED_NODE` executable path. No runtime is downloaded. The
runner probes Node version and native promise-hook capability before root
admission/body effects; a missing, old, or incompatible runtime is refused.
Direct SDK authored execution likewise requires working native promise hooks.
Bun 1.4.0 exposes no-op `async_hooks`, so it cannot prove that a native `await`
consumed a step. Treating every `.then` call as an await would incorrectly accept
ignored operations; that verification remains unchanged inside Node.

Only the authored body runs in the Node child. The standalone CLI retains the
root worker lease, agent workers, declarative execution, daemon lookup, and
resume protocol. The child inherits the working directory/environment and uses
the same journal socket and child admission identities. It verifies the root's
pinned source graph and Surface package before executing the body. Root aborts
and signals stop the child. Parent-pipe loss exits a responsive child; an independent
watchdog thread checks parent identity every 50 ms and kills the process even if
the authored body blocks its event loop. This is bounded scheduling, not an
instantaneous termination guarantee. Result frames are authenticated and checked
against durable child completion before root success. The Node loader executes
captured, hash-verified authored source bytes at their original module URLs.
Successful root output records the Node version, executable SHA256, and embedded
payload SHA256 as `executionRuntime`. The payload remains part of the existing
artifact hash, and completed child effects remain journal results on resume.
