# RFC-0001: Everything is a Relayflow

- **Status:** Draft for review
- **Author:** Khaliq (drafted with Claude)
- **Date:** 2026-08-27
- **Supersedes/extends:** `../relayflows-rewrite-0825/REWRITE-CHARTER.md` (2026-08-25) — the charter's settled decisions carry forward unchanged; this RFC replaces its phase list with use-case gates and adds the dogfood rule.
- **Prior art it builds on:** the "Six Repos, One Engine" consolidation survey; the sandbox-program runs in `.workflow-artifacts/`.

---

## 1. Thesis

A **Relayflow is a deterministic script that composes agentic primitives** — an LLM call, an agent, a virtual filesystem, memory, identity, and authorization — into anything from a one-shot pipeline to a resident harness to an entire application. The product thesis in one line: **we are taking prompting and making it reliable, with natural rails and gates.**

The primitives form a ladder, and every rung is a legal relayflow:

```
deterministic step          # a pure script — no LLM anywhere (legal; today's validator wrongly rejects zero-agent flows)
  + llm step                # a bare model call — prompt in, verified output out; no PTY, no sandbox
    + agent step            # a harnessed agent in a workspace — artifact + diff + trajectory
      + memory / identity   # context packs in, trajectories out; scoped credentials
        + resident triggers # a proactive agent, a garden, a harness, an application
```

`llm` is a **kernel-level step type distinct from `agent`**: it has no workspace, its output is a value, and its verification is the rail that makes a prompt reliable. Most flows a customer writes on day one are deterministic + llm steps; agents are the rung you climb to when the step needs hands.

### The two covenants

Every gate, surface, and SDK is bound by two covenants, born from real cofounder friction with the current engine:

**Covenant 1 — easy to write, easy to read.** A relayflow's spec reads like the plan it came from. The measure is the **cofounder test**: a technical founder writes their first working relayflow in under ten minutes without reading engine docs, and can read a stranger's flow aloud and say what it does. Error messages name the author's mistake in the author's vocabulary, never engine internals. Sage is the zero-syntax on-ramp (conversation → spec). Authoring friction is a gate-blocking defect, not a docs problem.

**Covenant 2 — no unexpected failures.** A relayflow may fail only in ways it declared. Two mechanisms enforce this:
- **Preflight.** At submit time the engine proves everything provable — spec validity, CLI existence *and auth health*, credential scopes, integration mounts, a worker existing to execute every trigger — and **refuses or warns before the run starts** on anything it cannot prove. Nothing may fail at minute 27 that was checkable at minute 0. (Evidence from the first dogfood run, 2026-08-27: an unknown `cli: grok` passed `--dry-run` and killed the run 27 minutes in; gemini's auth was dead and was discovered mid-run; a cron trigger reported `succeeded` into a void with no worker enrolled.)
- **Typed failure.** At runtime every failure is one of a closed set of declared kinds (`gate_failed`, `verification_failed`, `budget_exceeded`, `needs_human`, `environment_lost`, …), journaled with its `completionReason`. A raw stack trace, a silent wrong-workspace run, or a "succeeded" that did nothing is by definition a kernel bug. A flow with unprovable assumptions starts only after stating them to its author.

The engine underneath must be **competitive with Temporal and Inngest** as durable execution, and **agentic-leading** where those engines are structurally blind:

| Capability | Temporal | Inngest | Relayflows target |
|---|---|---|---|
| Durability mechanism | deterministic code replay | step journal + memoization | **step journal + memoization** (replay is semantically wrong for agents — settled decision #2) |
| Retry semantics | transient (same call, same result expected) | transient | **semantic** — verification gates + bounded iteration, because an agent's failure mode is *wrong output*, not *no output* |
| Step output | JSON return value | JSON return value | **artifact + diff + trajectory** — the workspace is part of run state |
| Resource accounting | CPU/memory | none | **tokens + dollars**, enforced by the kernel |
| Human-in-the-loop | signals (DIY) | `waitForEvent` (DIY) | **first-class durable await** (`needs_human`) |
| Cross-step communication | activities are hermetic | steps are hermetic | **durable channels** — journaled streams; agents coordinate mid-flight *and the coordination survives resume* |
| Memory across runs | amnesiac by design | amnesiac | **relayhistory-backed** — script-level and per-agent |
| Integrations | activities you write | `step.run` you write | **relayfile mount** — a SaaS is a directory, not an API |
| Execution placement | your workers | their infra | **routed sandboxes** — cost/latency/capability-ranked |

The kernel remains what the charter's phase 4 specified: **step journal, idempotency keys, one lease primitive, durable timers, retry with backoff + jitter**, built against a simulated clock, with `completionReason` on every journal entry and an explicit **starting-state contract for agent steps** — specified in full in Appendix A.

## 2. The method: rewrite relayflows using relayflows

The rewrite is not a project *about* relayflows; it is a program *of* relayflows. Every capability below ships as a relayflow, and **the acceptance gate for each relayflow is that it supports the use case it exists to achieve** — not that its tests pass, not that a demo runs once, but that the real consumer (a persona, the garden, chief) runs on it.

Rules of the program:

1. **Each gate is a relayflow in this repo** (`workflows/gates/gate-N-*.yaml` or `.ts`), runnable by the *previous* generation of the engine until the new kernel can host it — the same way a compiler bootstraps.
2. **A gate is green only when the real workload runs on it.** "hn-monitor runs as a relayflow" means the deployed hn-monitor, not a fixture that resembles it.
3. **Gate runs are journaled and pushed to relayhistory** — the rewrite's own trajectory is the first data the memory system serves (gate 5 eats gate 1's output).
4. **No gate may weaken another's invariant.** The sandbox-program runs already proved why: a repair agent must never be able to edit the gate that judges it (charter phase 1b). Gate definitions are owned outside the mutating agent's write scope.
5. **The rulebook is alive.** The repo runs `../workflows`-style maintenance flows continuously (`maintain-agent-rules` is the template): standards rules are **added when a review surfaces a new failure class and pruned when they stop firing** — the rulebook grows and shrinks with evidence, never by accretion.
6. **Features solidify into the catalog.** As each relayflows feature lands it is solidified three ways (`feature-catalog-guardian-audit` is the template): **tests** pin the deterministic code, **live runs** exercise the agentic product features continuously against the real codebase (a feature that stops working in a real run is a red gate, not a stale demo), and **evals** score the agentic behavior that tests can't pin.
7. **Every PR is met by a review swarm.** Several proactive review agents fire on each PR — distinct lenses, minimally: **maintainability**, **git history** (does this change fit the story of the code), and **code structure** — the pattern already run on hoopsheet. Each reviewer is itself a relayflow (a gate-2 proactive agent triggered by the PR event), so the review system is built out of the thing it reviews.

### The Relayflow Lead

Yes — immediately, and it is the first consumer of this document. The **Relayflow Lead** is a chief-shaped system fully dedicated to relayflows: it encodes RFC-0001 as its constitution, runs long-lived in the cloud, and Khaliq speaks to it directly. It coordinates the entire product lifecycle — sequencing the gates, dispatching gate work to the Garden/factory machinery that exists today, running the review swarm and the rulebook flows, tracking design-partner acceptance evidence, and reporting state honestly. Per gate 4 it is not a long-running agent but a **system**: a loop of ephemeral agents over durable state (this RFC, the journal, the repo, its memory). It bootstraps *now* on the existing persona/chief machinery — the 0825 charter already appointed a `relayflows-rewrite-lead`; this promotes that role to a resident system — and migrates onto the kernel as gates land, becoming gate 4's first live proof. Two hard rails carry over: **it never merges** (a human merges), and it cannot edit the gates that judge its work (decision #6).

### Gate dependency order

```
1 run ──► 2 proactive ──► 3 garden ──► 4 chief/harness
   │           │
   ├──► 6 integrations (relayfile)      9 self-improving agents
   ├──► 7 sandbox routing                       ▲
   ├──► 8 identity/credentials                  │
   └──► 5 memory ───────────────────────────────┘
```

Gates 5–8 are horizontal capabilities that start as soon as gate 1 holds and are consumed by 2–4. Gate 9 closes the loop and depends on 5 + 8.

---

## 3. The nine gates

### Gate 1 — a relayflow can run

**Proves:** the kernel. Journal + memoization, resume without re-execution of completed steps, deterministic and agent steps, verification as control flow.

**Forces into existence:** `@relayflows/kernel` (charter phase 4 + 5): append-only fsync'd journal that *fails the step* when the write fails (fail-closed, no `homeFallback` silently leaving the relayfile mount), idempotency keys, leases, durable timers, `completionReason`, **out-of-band step completion** — a step an external worker finishes asynchronously (Native's render workers), journaled with the same `completionReason` discipline as in-process steps — and **durable channels**: an inter-agent message is a journal append with consumer offsets, at-least-once and replayable, so coordination in flight survives `kill -9` like every other kind of state.

**Done when:** the canonical hello *ladder* — (a) a pure deterministic flow with zero agents (legalizing what today's validator rejects), (b) the same flow plus a bare `llm` step with a verification gate, (c) the same flow plus an `agent` step — each survives `kill -9` at every step boundary and between them, resumes completing only unfinished work, and its journal replays *results, not code*. Budget accounting is exact: the resumed run's token spend equals one execution of each step. **Preflight holds (covenant 2):** `flows check` refuses the ladder flows when a declared CLI is missing or unauthenticated or a trigger has no executor, warns on unprovable assumptions before starting, and the failure taxonomy is closed — every failed run's journal terminates in a declared failure kind, never a raw error.

**Exists today:** `runner.ts` (11,560 lines, no checkpoint, no backoff) — the thing being replaced. The YAML/TS/Python authoring surface survives as compilers targeting the journal protocol.

### Gate 2 — a relayflow can power a proactive agent

**Proves:** triggers are entry conditions, not schedulers. Webhook (`EventFrameV1` via relayfile's webhook server) + agent definition + **persona import**.

**Persona import is first-class:** `agents:` entries already accept `persona:` resolved through `@agentworkforce/persona-registry` (`packages/core/src/persona-runtime.ts`). The gate deepens this: a `persona.ts` from `../agents` or `../internal-agents` imports directly — its `triggers` become the flow's entry conditions, its handler becomes agent steps with `ctx.step()` boundaries (charter phase 6). A persona is sugar for a relayflow.

**Done when:** `hn-monitor` (or `linear`) runs as a relayflow in production — triggered by its real events, with **zero bespoke persistence functions** (its current twelve are the measure), retried at step granularity, deduped by idempotency key. The trigger plane is **liveness-checked**: a schedule or subscription that stops firing is detected and swept (RelayCron's deterministic-id claim + `stale_after` reconciliation), because a flow that is never triggered is silently zero — Native's silent-death problem.

**Exists today:** cloud webhook router binds `EventFrameV1` matchers to personas but not to workflows (charter phase 3 — `scheduleType: "event"`); `watch`/`subscriptions` fields in the schema.

### Gate 3 — a relayflow can power a factory → **Software Garden**

**Proves:** the flagship DAG. Discover → implement → review → merge-gate → close, on kernel leases instead of factory's ~10 hand-rolled claim protocols (`leaseUntilMs` ×71, `heartbeat` ×490).

The rebrand is part of the gate: **Software Garden** is the presentation layer a customer authors against without ever meeting a lease, a journal, an attempt counter, or a dedupe key (charter phase 8). Factory's `FactoryLoop` (~16,900 lines) dies by migration, one claim family per PR (charter phase 7).

**Done when:** a labeled issue flows to a reviewed PR end-to-end with every claim/lease/retry served by the kernel, the merge gate holding (no auto-merge without opt-in), and the run legible in the journal — while the customer-facing config surface mentions none of it.

### Gate 4 — a relayflow can run chief (a relayflow can be a harness)

**Proves:** resident *runs*, not resident processes. Chief is not a single long-running agent — it is a **system**: a loop of many agents, none of them long-running, over durable state. No agent outlives its step; what persists is the run — the journal, the **backed filesystem** (the relayfile mount), and memory (gate 5). "Chief" names the loop, not a process. That is how it runs for months or years: there is nothing to keep alive, only state to keep consistent. `waitFor` gates on surfaces, dispatch to the garden, checkpoint back, human approval as a durable await; journal segmentation keeps the unbounded run's journal bounded.

**Done when:** chief's loop — surface intent → dispatch → checkpoint → approval — runs for a week of real use (design target: indefinitely) with every participating agent ephemeral, waking on triggers and sleeping between them, and the whole system restartable at any moment from journal + mount + memory alone: kill every process, resume, no lost or duplicated dispatches. Skip attaches as a client of the run/event API, proving harness = relayflow + renderer.

**The corollary is a product:** what the market sells as "an agent" — Viktor, Tembo, Tasklet, Warp — is in relayflows terms a *small system*: triggers (gate 2) + ephemeral agent steps + a backed filesystem + memory (gate 5) + identity (gate 8) + performance review (gate 9). It self-improves and never dies because it was never alive. Once gate 4 holds, "build an agent" is an afternoon of authoring, not a product category we have to chase.

### Gate 5 — a relayflow has memory: for the script, and per agent

**Proves:** memory is a kernel-adjacent concept with two scopes:

- **Script memory** — the flow's own durable state across runs: prior run outcomes, learned parameters, "what happened last time." Backed by the journal + relayhistory trajectories.
- **Agent memory** — per-agent identity-scoped context: before a step, the agent receives a context pack (`ai-hist pack` / `why_for_task`); after, its trajectory (decisions, retrospectives) is distilled back (`ai-hist learn`), and `pair` serves cited warnings mid-session.

**Done when:** a step can declare `memory:` (scope: script | agent, query, budget) and the injected pack demonstrably changes behavior — the acceptance test is an agent avoiding a mistake recorded in a previous run's trajectory, with the citation in its output. Every relayflow run pushes trajectories to relayhistory without opt-in code.

**Exists today:** relayhistory (Rust, SQLite/FTS5, MCP server, `pack`/`learn`/`pair`) — promoted from tool to core component, consumed over its serialization contract, not rewritten.

### Gate 6 — integrations are first-class via relayfile, with no `integration` primitive

**Proves:** settled decision #1, taken to its conclusion. The `type: integration` step and `@relayflows/slack-primitive` / `github-primitive` are **deleted** (browser-primitive stays — nothing covers it). An integration step is a file operation on the relayfile mount, served by `@relayfile/adapter-*` (50 providers): create a PR by writing a file, read an issue with `cat`, react to Slack by writing into the tree. Writeback, auth, retry semantics live in the adapter — where they already exist.

**Done when:** every integration step in the existing example flows (github create-pr, linear update, slack post) expresses as mount reads/writes; the 3,185 transport lines leave `runner.ts`; and a new provider becomes available to *every* relayflow by existing as a relayfile adapter, with zero relayflows code.

### Gate 7 — a relayflow routes to the right sandbox under the hood

**Proves:** execution placement is the engine's job. A step declares requirements — interactive PTY vs batch, expected duration, network needs, cost sensitivity — and `../sandbox-router` selects from provider pools (`../sandbox` runtimes: local, daytona, e2b, modal, agent37, …) by its deterministic `cost` / `latency` / `reliability` / `balanced` ranking. Long-running agents route to agent37 per the 2026-08-23 ruling (~25× cheaper per running-hour); the author writes none of this.

**Done when:** the same flow YAML runs locally and in cloud with no placement config; the routing decision (profile matched, provider chosen, fallbacks attempted) is a journal entry; and killing a sandbox mid-step resumes per gate 1's contract with the workspace pinned by relayfile revision.

### Gate 8 — agent identity, scoped credentials, traceable work

**Proves:** every agent in a flow is a principal. Stable identity per agent (not per process), credentials resolved through the proxy (`AgentCredentialConfig` exists; the gate makes it the only path — no ambient env inheritance), scoped by the flow's `permissions` model (file globs, network allowlists, access presets) and relayfile ACLs, revocable mid-run.

**Done when:** for any side effect of any run — a file write, a PR, a Slack message — the journal answers *which agent, under which credential scope, in which step, why* (`completionReason` + identity attribution). An agent given `readonly` provably cannot write through any path: direct fs, mount writeback, or exec.

### Gate 9 — agents that continuously improve, as relayflow steps

**Proves:** the loop closes with no new machinery. Performance review is *just steps*: a reviewer agent scores a run's trajectory against its verification record, writes findings to relayhistory (`learn`), and the next run's memory injection (gate 5) carries them. Model/prompt/persona adjustments proposed by review are themselves gated relayflows (a persona change is a PR through the garden — gate 3 — approved by a human — gate 4's approval primitive).

**Self-authoring is the strong form.** Because the composable unit is a spec — data, not code — *writing a relayflow is just a step whose output is a spec*. A relayflow system improves by **authoring relayflows for itself on the fly**, the way `../ricky` already sketches at product level: monitor a run → diagnose the failure or quality gap → author a new or amended flow → ship it through the Garden as a gated change → resume. Ricky's entire feature list (debug, fix, restart safely, analyze quality over time, suggest improvements, generate workflows) dissolves into relayflows over the journal. The rails hold precisely here: a self-authored flow passes the same verification gates and human approvals as a human-authored one, and it can never widen its own permissions or edit the gates that judge it (settled decision #6). The system builds and enhances itself; the gates decide what ships.

**Done when:** two chains are demonstrated in journals. *Learning:* run N+1 measurably outperforms run N on its own verification metrics because of an injected learning from N's review step, over a multi-week window. *Self-authoring:* in response to an observed failure or quality signal, the system authors a flow change, ships it through the Garden with the required approval, and the change measurably resolves the signal — ricky's monitor → diagnose → fix → resume loop, rebuilt as relayflow steps, with every link (trajectory → diagnosis → authored spec → gated deploy → improved outcome) visible.

---

## 4. The language decision

We are starting from scratch, so this is decided here, not inherited:

**The kernel and control plane are Rust. Everything a user or product touches is TypeScript-first.**

- **`relayflowd` (Rust):** the journal, scheduler, leases, durable timers, and event router ship as one static binary on the same SQLite substrate relayhistory already owns — journal and memory become **one storage engine**, and gate 5 stops being an integration and becomes a table. It runs embedded under the CLI for local dev and hosted for cloud, and the same binary is the **self-host story** for design partners with compliance requirements. The kernel never holds provider SDKs — LLM calls and agent execution happen SDK-side or in routed sandboxes.
- **SDKs and surfaces (TypeScript, then Python):** the authoring builder, YAML compiler, personas, Garden, chief, sage, nightcto — the entire estate is TS and stays TS. Authoring never requires Rust.
- **The journal protocol is the boundary.** SDKs speak it over local socket/HTTP; Skip (Swift) and any future surface are clients of the same contract.

Why not TypeScript all the way down, given the velocity argument: the kernel is the component that must never lose data and runs for years, and we have already measured where "engine written in the app language" ends — an 11,560-line runner whose largest concern is resolving Slack channel IDs. A binary you call over a protocol *cannot* absorb product logic; the language boundary enforces the architectural boundary. The cost — slower initial kernel velocity — is bounded because the kernel is deliberately small (§1) and built against a simulated clock with no I/O.

## 5. Consumers and the sales motion

The gates exist to be sold, not admired. The consumer list, in order of proof value:

- **Native** (`../customer-agents/native`) — the **first and most important design partner**, and the prime pipeline use case: Autopilot is a per-brand daily tick restoring one invariant — *the next 14 days must contain N posts per week*. The POC already runs as a relayflow, and it teaches the engine four things the gates must absorb:
  1. **Reconciliation over retries** — failed work releases its slot, the gap reappears in the planner, the next tick fills it. There is no retry queue. The kernel's retry policy (gate 1) must be optional machinery, not the only shape of self-healing; invariant-restoring loops are a first-class flow pattern.
  2. **Deterministic gates around untrusted agents** — the invariant is a pure function at the front and a deterministic `verify-invariant` gate at the back; *no agent is ever trusted to assert the calendar is full*. This is the "rails and gates" thesis running at a customer.
  3. **Out-of-band step completion** — nothing awaits an image; render workers complete posts asynchronously and a later step picks up whatever became ready. The journal needs a step state completable by an external worker, not only by the step's own process.
  4. **Trigger liveness** — Native's sibling-engine story: built, allowlisted, never provisioned, silently zero for weeks. A flow that is never triggered reports nothing. RelayCron's deterministic-id single-winner claim + `stale_after` sweep is the answer, and gate 2's trigger plane inherits it as a requirement, not an option.

  Autopilot's `automationSignature` consent model — every automated action attributable and withdrawable, nothing a human touched ever revoked — is gate 8's evidence at a customer, alongside the SOC 2 plan below.

- **Sage** (`../sage`) — PDERO's Plan phase already "produces structured plans that become relay workflow definitions." That makes sage the natural **authoring frontend**: conversation → plan → relayflow spec. Sage is both *powered by* relayflows (its own loop — research, clarify, remember, plan — is a resident relayflow: gates 2 + 4 + 5) and its output *is* relayflows. Rewriting sage on relayflows is the proof that an application is a relayflow.
- **NightCTO** (`../nightcto`) — rewritten **by** relayflows and running **on** relayflows: the Software Garden (gate 3) performs the rewrite as its own gated program, and the result — per-client resident personas over WhatsApp/Slack/Telegram/Signal, webhook-driven monitoring, sandbox agents that sleep and wake — is gates 2 + 4 + 7 as a $149/mo product. Dogfood squared: the engine rebuilds a product onto itself.
- **Ricky** (`../ricky`) — dissolves into the platform: workflow reliability, coordination, and authoring become relayflows over the journal, and its monitor → diagnose → fix → resume loop is gate 9's self-authoring chain. Ricky the product becomes the first resident consumer of the kernel's own observability.
- **The "agent" category** — the competitive answer to Viktor / Tembo / Tasklet / Warp falls out of gate 4's corollary: an agent is a named identity + trigger set + backed filesystem + memory, executed as ephemeral steps and improved by gate 9. We don't build an agent product; we make agents an afternoon of authoring on the platform — with rails and gates the incumbents don't have.
- **Design partners** — Julian (Nabis) and John (SecLock) and everyone in `../sales`. Julian's certification run (`sales/nabis/julian-fann/RELAYFLOWS-DEFECTS.md`) is the acceptance evidence the gates must retire: partially-scoped credentials silently swallowing writebacks (gate 8: fail-closed credential resolution), a failing lane's output never surfaced (gate 1: `completionReason` + journal legibility), gates failing open (settled decision #6). **A gate isn't sellable until the defect class it covers can't recur by construction.** The SOC 2 traceability plan in the same folder is gate 8's commercial spec.

## 6. Settled decisions, carried forward

1. **No `@relayflows/adapter-*`** — relayfile-adapters owns providers (now enforced structurally by gate 6).
2. **No deterministic replay** — journal + memoization only.
3. **`agents` / `internal-agents` keep their split** — both become thin persona layers over relayflows, neither folds in.
4. **Garden and workforce build on relayflows internals** — presentation layers, not arms-length clients.
5. **New (this RFC): the composable unit is the spec + journal protocol, not any language.** The kernel/control plane is Rust (§4); TypeScript is the first SDK; relayhistory (Rust) and Skip (Swift) speak the same contract.
6. **New: no gate may be editable by the agents it judges** — learned from the sandbox-program integrity incident.
7. **New: relaycast is a projection, not a source of truth.** Today the runner coordinates over relaycast as a chat bus (`send_dm` / `check_inbox` / `post_message`) — at-most-once, no offsets, no replay. That is not durable enough to be a core unit against Temporal/Inngest. In the rewrite, **channels are kernel streams**: append-only, journaled by `relayflowd`, consumed by offset. **Settled 2026-08-27: agents move to a new stream API; relaycast becomes pure UX** — a client of kernel streams for delivery, presence, inboxes, and the human-facing workspace, with no execution semantics of its own. The chat-verb MCP surface is not re-pointed; it is retired for agents. Execution-relevant facts (approvals, gate verdicts, step handoffs, agent spawn/remove) are real only when journaled; a chat message may carry a pointer to a fact, never be the fact. Soft state (presence, typing, read receipts) stays soft on purpose.
8. **New: journal compaction is segment-per-epoch.** A resident run periodically closes its current journal segment and opens a new one whose first entry is an epoch summary — everything still live (open slots, active waits, stream offsets, pinned revisions). Resume reads only the current segment; closed segments are never rewritten and are archived to relayhistory, where they become memory (gate 5) instead of garbage. Append-only is preserved everywhere.
9. **New: the persona interface is compiled.** `persona.ts` is the flexible authoring surface at the edge (CLI and sage compile it); the **compiled persona spec (`persona.json`) is the contract at the kernel boundary** — data, schema-validated, diffable, signable (gate 8), and emittable by a step (gate 9's self-authoring). Same pattern as every other surface: TS in, spec at the boundary.
10. **New: memory tokens are charged to the consuming step, itemized.** An injected context pack spends the step's own budget and appears as a distinct memory line in that step's journal entry. No shared pools: gate 1's invariant — resumed spend equals one execution of each step — stays checkable only if every token has exactly one owner.
11. **New: the verification split holds** — the kernel judges *completion* (`completionReason`), the evidence layer judges *quality* (review gates, owner adjudication). Garden merge gates are evidence-layer.
12. **New: "Software Garden" is a product-level brand only.** Repos keep their names; no `factory` → `garden` rename.
13. **New: the kernel vocabulary is closed; the surface is open.** Three step verbs (`run`/`llm`/`agent`) + four resident verbs (`on`/`human`/`dispatch`/`done`) are the whole kernel language. Everything else — integration helpers (generated from relayfile adapters), `f.memory` (relayhistory), auth-by-declaration (relayauth path scopes), `f.mcp`, and community **plugins** (herdr-model marketplace) — is surface that compiles to kernel primitives. A plugin contributes verbs, triggers, and gate predicates; it must state its preflight (covenant 2) and cannot touch the kernel. Full design: `docs/SURFACE.md`.
14. **New: a relayflow compiles to an immutable, content-addressed bundle.** `flows build` produces a sealed artifact — canonical spec JSON, compiled TS dialect with pinned dependencies, helper/plugin lockfile, assets, the flow's preflight declaration, and a signature from its identity — addressed as `flow@sha256:…` and pushed to a bucket/registry. **Runs reference digests, never working trees.** What this buys, by construction: every journal records exactly which flow version produced it (provenance); triggers bind to digests, so a scheduled run is executable from the bucket by any cell with no checkout (the fix for the workerless/ephemeral-run failure class seen 2026-08-27); rollback is pointing at the previous digest; upgrades-at-epoch-boundaries (versioning policy) means "the next epoch opens on a new digest"; and gate 9's self-authoring ships a new digest through the Garden — an agent can propose a bundle but can never mutate a deployed one.
15. **New: tenancy is option C — the kernel is tenant-unaware.** `tenant_id` never appears inside the kernel. Cloud is a **cell orchestrator** that provisions, wakes, and sleeps per-tenant `relayflowd` cells; a sleeping tenant costs storage only (the journal is a SQLite file). Self-host is running your own cell: the same binary, zero divergence, per-tenant isolation true by construction.


## 7. Open questions

- **Spec / journal / protocol versioning.** Three artifacts version independently: the **journal format** (additive-only entry fields, `journal_version` stamped per segment; readers read every past version, writers write only the newest), the **spec schema** (semver; compilers always emit latest; the kernel supports a window), and the **SDK protocol** (versioned handshake, N−1 compatibility). Proposed unifying policy: **upgrades apply only at epoch boundaries, and epochs are cheap** (decision #8) — a resident flow finishes its current epoch on the versions it started with; the next epoch opens on the new ones. Because the journal replays results, not code, an old segment ever needs only an old *reader*, never old *code* — that is the structural escape from Temporal's versioning hell. Stays open until a real kernel upgrade has been executed under a live resident run.


## 8. What this replaces in the charter

The charter's phases 1–3 (CI + three defects, integration deletion, event ingress) are **unchanged and remain the immediate work** — they are prerequisites of gates 1, 6, and 2 respectively. Phases 4–8 are reorganized into the gates above. PR `relayflows#39` (`terminalSuccessExitCodes`) still lands first, not duplicated.

---

## Appendix A — the agent-step starting-state contract (v1)

The problem, from the charter: exactly-once for an *agent* step needs a definition of the step's starting state — a half-finished repo edit is not undone by a lease expiring. This contract finishes that specification.

1. **Declared state surfaces.** An agent step declares its mutable surfaces up front: **workspace** (relayfile mount paths and/or a worktree), **streams** (channels it may write), and **external effects** (integration writebacks — which, per gate 6, are mount writes). Anything undeclared is outside the contract and outside the step's permissions (gate 8 makes this enforceable, not advisory).
2. **Pin on start.** Each attempt begins with a journaled `step.attempt.started` entry carrying: the relayfile **revision id** of every declared mount surface (or the worktree base commit), the **stream offsets** at start, and the attempt's **idempotency key**.
3. **Effects are journaled facts.** A writeback is a mount write; the mount write is the effect record — attributed to the agent identity, revisioned, and replayed as *fact* on resume, never re-executed.
4. **On crash or lease expiry, the workspace is dirty, not undone.** The kernel never rolls back an agent's edits. The next attempt starts under one of three per-step recovery modes (default `reset`):
   - **`reset`** — restore declared workspace surfaces to the pinned revision (relayfile revision restore / fresh worktree from the base commit). The new attempt starts clean. Safe as the default because external effects only occur via journaled mount writebacks, which are deduped (rule 5).
   - **`inspect`** — the new attempt starts *inside* the dirty workspace, with the failed attempt's journal record (trajectory tail, last `completionReason`) injected as context: continue or redo is the agent's judged decision, verified by the step's gate like any other output.
   - **`manual`** — park as `needs_human` with a diff of pinned revision vs. current state.
5. **Exactly-once means exactly-once *effects*, not exactly-once execution.** Attempts may run more than once. Declared external effects are deduped at the mount boundary by `(step id, idempotency key, surface path)`: two attempts writing the same writeback produce one provider call.
6. **Completion pins the end state.** `step.completed` journals ending revision ids, stream offsets, and `completionReason`. The next step's starting state *is defined as* this ending state — the chain of pins is the run's filesystem history.
7. **The crash-injection gate extends to agent steps.** Under `reset`: kill mid-edit, resume, and assert (a) the second attempt observed the pinned revision, (b) the provider observed exactly one effect, (c) the journal explains both attempts.
