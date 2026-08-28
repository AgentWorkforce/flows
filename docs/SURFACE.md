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
6. **Agent definitions come in three sizes** — and a reusable agent *is* a flow:
   ```yaml
   - agent: Review this diff for security issues.        # 1. anonymous
   agents:
     reviewer: claude                                    # 2. named — name: cli
     auditor: { cli: claude, memory: true, tools: { mcp: [semgrep] }, workspace: readonly }  # 3. escalated
   ```
   Defining your team's reviewer = writing `reviewer.flow.ts` (identity + memory + body); other flows compose it with `use:` / `f.agent(reviewer, task)`. Persona import is flow composition, not a special mechanism.

   **Anonymous resolution law:** `f.agent\`task\`` with no name is the *default agent*, resolved (never guessed) in order: step options → flow header → project config (`flows.json`) → platform default. *The platform-default rung is declared but not yet implemented: no platform default is provisioned as of gate 1, so a flow that reaches this rung refuses with `cli_unresolved` rather than guessing. `flows check` never invents an implicit default.* `flows check` prints each resolved step CLI and its declaration source, validates it before submission, and refuses a missing or unauthenticated resolution before the checked flow is submitted, never at minute 27. Gate 1 does not make this guarantee for callers that bypass `flows check`: the journal client's direct `run.start` path does not invoke surface preflight.

   **Preflightable-CLI contract:** to be checkable, a declared `cli` must answer `<cli> auth status` — exit `0` for authenticated, non-zero for not. `flows check` resolves the binary (a path is taken relative to the file that declares it — the flow for a step/flow-level `cli`, the project config for a `flows.json` default — while a bare name resolves via `PATH`) and runs that probe once per resolved `(cli, source)`: a path that does not resolve as an executable is `cli_missing`, and non-zero is `cli_unauthenticated`. A probe process that cannot be started, is terminated by a signal, or exceeds the 10-second auth-probe timeout is `probe_failed`; the diagnostic carries that classified cause without exposing raw process errors. The probe executes the flow-declared CLI with the checking process's complete caller environment inherited. This is the whole contract — preflight never sends a prompt, never spends a token, and never invokes any other subcommand. A non-zero refusal names the exact `auth status` probe and tells the operator to authenticate the CLI or implement the probe to return exit `0`; health is never assumed.

   **Project-config discovery:** starting in the flow file's directory, `flows check` walks parent directories through the filesystem root and selects the first readable `flows.json`. That nearest file is the whole project config; it is not merged with outer files. Its schema is `{ "cli"?: <non-empty string>, "executors"?: <non-empty string>[] }`; unknown keys fail closed as `config_invalid`. A nearer config therefore defines a self-contained nested project boundary and prevents accidental inheritance of outer credentials or executors. The selected path is printed with project-level resolutions and named in an unresolved-CLI refusal; if it declares no `cli`, outer configs remain shadowed. At gate 1, a trigger executor is considered registered only when its name is present in this author-written `executors` array; `flows check` does not yet contact a registry, broker, or RelayCron, and absence is `no_executor`.
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

## 5. Invocation: three ways in

A deployed flow is reachable three ways, all landing on the same digest and the same journal:

1. **Events** — `on(...)` triggers: relayfile webhooks, mentions, file changes.
2. **Schedules** — RelayCron: durable alarms + sweep.
3. **Direct call** — a flow is a *function*:
   - CLI: `flows run release-note --input '{"branch":"main"}'` (or `flows run flow@sha256:…`)
   - HTTP: every deployed flow is an endpoint — `POST /flows/release-note` returns the result for short flows, or a run handle (`202 + run id`) to poll/stream for long ones
   - SDK: `await flows.call("release-note", input)` from any app (this is how sage and consumer apps invoke pipelines)
   - Flow-to-flow: `f.dispatch("garden/implement", plan)` — same mechanism, child run with its own journal

The caller always gets the same contract back: a typed result on completion, or a durable run handle it can await, stream, or abandon — the run finishes either way, journaled.

## 6. Open surface questions (for gate-1 SDK work)

- `gate:` in YAML: tiny expression language (`length < 200`) vs named checks only. Leaning: a deliberately small expression grammar + named checks for everything else.
- Are YAML helper verbs (`slack:`, `mcp:`) core spec vocabulary or compile-time expansion into `run`/effect steps? Leaning: expansion — the kernel spec stays seven words; helpers stay a surface concern.
- Helper generation cadence: generated from relayfile adapter manifests at build time vs published per-adapter packages. Leaning: generated, with hand-tuned verb names for the top providers.
