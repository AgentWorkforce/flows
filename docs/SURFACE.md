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
  if (!intent) return f.done("no_work");

  const plan = await f.agent("planner", {
    task: `Research and plan: ${intent}`,
    workspace: "acme/api: readonly",          // compiles to relayauth path scopes
  });

  const ok = await f.human(`Ship this?\n${plan.summary}`, { to: "khaliq" });
  if (!ok) return f.done("declined");

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
   the existing per-step `cli` and `model` fields and removes both the selector
   and map before the kernel boundary. Explicit step values win independently:
   step `cli`/`model` → named declaration → the existing flow/project CLI
   default. Model has no flow/project default. An inline step that selects no
   named declaration keeps the existing optional-model behavior; the worker
   explicitly removes ambient `RELAYFLOW_MODEL` when it is absent.

   **Anonymous resolution law:** `f.agent\`task\`` with no name is the *default agent*, resolved (never guessed) in order: step options → flow header → project config (`flows.json`) → platform default. *The platform-default rung is declared but not yet implemented: no platform default is provisioned as of gate 1, so a flow that reaches this rung refuses with `cli_unresolved` rather than guessing. `flows check` never invents an implicit default.* `flows check` prints each resolved step CLI and its declaration source, validates it before submission, and refuses a missing or unauthenticated resolution before the checked flow is submitted, never at minute 27. Gate 1 does not make this guarantee for callers that bypass `flows check`: the journal client's direct `run.start` path does not invoke surface preflight.

   **Preflightable-CLI contract:** to be checkable, a declared `cli` must answer `<cli> auth status` — exit `0` for authenticated, non-zero for not. When a step declares a model, the same probe runs with that exact value in `RELAYFLOW_MODEL`; exit `0` means the current credential can use that exact model. If the scoped probe fails, an unscoped probe distinguishes `model_unavailable` from `cli_unauthenticated`. `flows check` resolves the binary (a path is taken relative to the file that declares it — the flow for a step/flow-level `cli`, the project config for a `flows.json` default — while a bare name resolves via `PATH`) and runs that probe once per resolved `(cli, source, model)`: a path that does not resolve as an executable is `cli_missing`. A probe process that cannot be started, is terminated by a signal, or exceeds the 10-second auth-probe timeout is `probe_failed`; the diagnostic carries that classified cause without exposing raw process errors. The probe inherits the caller environment except that `RELAYFLOW_MODEL` is always removed and then set only from the compiled step. Preflight never invokes an undeclared model or guesses from host state.

   **Deterministic model registry:** model existence is not inferred from a
   regex or provider prefix. The nearest `flows.json` owns an exact,
   case-sensitive `models` allowlist. `flows check` first refuses a declared
   model absent from that list as `model_unknown`, without starting the CLI;
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

The authoring surface deliberately narrows `steps: []`: `flows check` refuses
it as `invalid_spec`, while the kernel accepts it. This is a chosen
authoring-time narrowing, not a kernel guarantee.

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
