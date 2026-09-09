# Durable step journals vs deterministic replay

Lane: grok. Date: 2026-09-08.

Two subagents (Landscape, Applied) ran in parallel. This report merges them after parent spot-checks of local kernel code and primary vendor docs. Disagreements resolved in §3. The research question asked to keep every report under 200 words; §1 is that comparison. The remaining sections exist because the lane protocol required them.

## 1. Executive summary

Keep a durable step journal as source of truth; recover by memoizing recorded results, not by re-executing workflow source. RFC-0001 decision #2: Temporal-style code replay is semantically wrong for `llm` and `agent` steps. This kernel already does journal + memoization: `RunState::fold` injects completed outputs as facts; `crash_resume` asserts completed effects are not replayed as code.

A journal without skip-on-resume double-charges. Code replay without a log dies with the process. They complement only if "replay" means folding facts. Temporal re-runs Workflow functions and matches Commands to Event History (determinism + versioning). Inngest, Restate, and DBOS inject stored step outputs — closer. LangGraph checkpointers snapshot state; they are not a command log.

Do not adopt Temporal/Restate/DBOS. The journal protocol is the product boundary. Finish epoch compaction, two-phase effects under crash, and Gate-5 archival; gate with existing crash-injection tests.

## 2. Landscape and best practices

### What the two phrases actually name

**Durable step journal.** An append-only, ordered log of facts about a run: this step started, this wait armed, this effect was elected, this attempt completed with `completionReason` and output. The log is the source of truth. Event sourcing is the general pattern [1]. Temporal Event History is one such log [2][3]. Restate, Inngest, and DBOS each persist per-step results in a journal or checkpoint table [4][5][6]. Fowler’s classic constraint still applies: external side effects must be gated so replay of the log does not re-send them [1].

**Deterministic replay.** Overloaded. Three distinct mechanisms share the word:

1. **Code replay (Temporal / Cadence).** On resume, the worker starts the Workflow function from the top. Commands emitted by that re-execution are matched against Event History. A mismatch is a *non-deterministic error*. Activities, timers, and signals are not re-done; their recorded results are fed back. Workflow code must be deterministic given that history: no raw `Date.now()`, RNG, or I/O outside Activities [3][7]. Versioning (patches, Worker Versioning) exists because deployed code is part of the recovery path [7].
2. **Result replay / step memoization (Inngest, Restate, DBOS, this kernel).** The handler or scheduler is re-entered, but completed steps are short-circuited: stored outputs are injected, unfinished work runs. Inngest is explicit that this is *not* Temporal’s model [5]. Restate journals `ctx.run` / equivalent and “replays the journal” as recorded results [4]. DBOS restarts the workflow function with checkpointed inputs and returns checkpointed step outputs [6].
3. **Snapshot restore (LangGraph checkpointers).** Persist graph state after a super-step; resume from the last snapshot. Durability modes include `exit` / `async` / `sync`; `InMemorySaver` does not survive process restart [8]. This is a checkpoint, not a command log.

Inngest’s own “Durable Agents” page calls (2) “deterministic replay” [9]. That naming is the main source of confusion in the last 18 months. RFC-0001 uses “deterministic replay” to mean (1), and rejects it [10].

### Consensus (multiple independent primary sources)

- Persist progress *before* the caller observes a result; the log is what happened [1][2][4].
- Isolate side effects from control flow. Temporal: Activities. Inngest/Restate/DBOS: `step.run` / `ctx.run` / `@DBOS.step`. Relayflows: `deterministic` | `llm` | `agent` with effects journaled separately [3][4][5][6][10].
- On recovery, do not re-execute completed side effects. Exactly-once *effects* is the claim; attempts may run more than once [6][10][11].
- Control flow, given recorded results, must be stable enough to reach the first unfinished step. That is weaker than “the source file is a pure function of history.”
- A journal that is only an observability trace (OpenAI/Anthropic session traces, unverified here) is not a recovery mechanism.
- Simulated-clock deterministic simulation (FoundationDB, TigerBeetle VOPR — Landscape cited; parent did not re-fetch) is a *test* technique, not production recovery. This kernel uses a simulated clock in `relayflowd-core` for that reason [12].

### Contested / emerging

- **Code replay vs memoization for agents.** Temporal’s 2025 blog argues agents are fine if LLM calls live in Activities [13, unverified]. RFC-0001 and Inngest argue the opposite for agent loops: the graph is drawn at runtime; forcing a hermetic Workflow function plus Activity split is the wrong authoring model [9][10]. This is the live industry split, not a settled science.
- **Snapshots vs event logs.** LangGraph time-travel wants snapshots [8]. Resident runs that must answer “which agent, under which credential, why” want an append-only journal [10]. You can project snapshots *from* a journal; you cannot reconstruct a journal from a snapshot.
- **Exactly-once vs at-least-once + idempotency.** Hatchet’s architecture docs state at-least-once and require idempotent tasks [14]. DBOS claims exactly-once for steps that share a Postgres transaction with the checkpoint [6]. Relayflows split election from provider call (two-phase `effect.recorded` / `effect.confirmed`) because the mount is not yet the writer [12]. Anyone selling “exactly-once” without naming the crash window is contested.
- **Workflow-as-code immutability.** Restate’s older write-up treats versioned deployments as the escape from Temporal’s patching [15, unverified by parent]. RFC-0001’s escape is different: replay results, not code, so an old segment needs only an old *reader* [10].

### Marketing (dropped or discounted)

- Hatchet marketing copy about a “transactionally-safe event log” implying no duplicates. Their own guarantees page says at-least-once [14].
- “Durable agents” on a `MemorySaver` or an LLM trace store. Persistence that dies with the process, or that cannot resume a killed run, is not durable execution [8].
- Vendor “exactly-once” without an elect-before-call or transactional piggyback story.

Canonical older work still in force: Fowler event sourcing and external-system gateways [1]; CQRS as a *read* projection, not a substitute for the write log [16, search only]; ARIES write-ahead logging and repeating history (Landscape fetched the PDF; parent did not, so the PDF is `unverified` here); sagas compensate rather than replay effects (ACM paper not fetched).

## 3. Recommended approach

**One sentence.** Treat the journal as the run; recover by folding it into `RunState` and dispatching only unfinished work. Do not re-run completed step code. That is already Gate 1 in this repo.

Landscape said crash-safe exactly-once “needs both” a journal and replay. Applied said this repo forbids deterministic replay. **Resolved:** need a durable log *and* a recovery procedure that consumes it. The recovery procedure is memoized result-fold, not Temporal code replay. Inngest’s use of “deterministic replay” for memoization is a naming collision; this report uses RFC vocabulary.

### 3.1 What already exists (do not redesign)

**Components.** `relayflowd-core` is a pure state machine on a `Clock` trait (`SimClock` in tests). `relayflowd-journal` is the SQLite implementation. `relayflowd` interprets `Action`s (append, exec deterministic, dispatch, arm timer, complete run). The TypeScript SDK speaks journal protocol v0 over a unix socket; it does not reach around the protocol [12][17].

**Write path.** One SQLite file per run: `<data-dir>/runs/<run_id>.sqlite3`, `PRAGMA journal_mode=WAL`, `PRAGMA synchronous=FULL`. One transaction per logical append. A failed commit returns `Err`; the protocol maps that to `journal_write_failed` and the step fails. No fallback [12][18][17]. Envelope fields: `seq`, `segment_id`, `entry_type`, `run_id`, `step_id`, `attempt`, `at_ms`, canonical JSON `payload` [12].

Entry types that matter for this comparison: `run.spawned`, `step.attempt.started` (pins, idempotency key, lease), `step.completed` (`completionReason`, `disposition`, memoized `output`, budget), waits/sleeps, `stream.appended` / channel facts, two-phase `effect.recorded` then `effect.confirmed`, `memory.injected`, `epoch.summary`, `segment.closed`, `run.completed` [12].

**Retrieval / resume.** `Engine::resume` opens the run file, loads spec, folds current-segment entries via `RunState::fold`, runs `recovery_actions_filtered` for dead attempts, then continues scheduling [19][20][21]. Completed steps with `disposition=step_done` become `Done`; their `output` is injected as fact, spending zero tokens and appending zero entries [12]. A `step.attempt.started` without `step.completed` is abandoned as `crashed` or `lease_expired` unless a live worker still holds the lease [21]. Open waits re-arm; elapsed timers fire.

**Effects.** Appendix A rule 5: exactly-once *effects*, not exactly-once execution. v0 is elect → perform → confirm. An unconfirmed election does not suppress the next attempt (the winner may have died before the provider call). A successful completion holding an unconfirmed election is refused [12][22]. Idempotency key is `sha256(run_id ‖ step_id)`, stable across attempts [12].

**Agent starting state.** `step.attempt.started` pins workspace revisions and stream offsets. Recovery modes: `reset` (default, restore pins), `inspect` (dirty workspace + trajectory tail), `manual` (`needs_human`) [10][12].

**Channels.** Replay reads recorded deliveries in journal sequence; it does not execute consumer code or invoke receive again [23].

**Memory.** Crash recovery reuses the journaled `memory.injected` pack; the provider is not called again. The current provider is `FixedMemoryProvider` (synthetic pack) — substrate stub, not retrieval quality [24].

**Consolidation / forgetting.** Decision #8: segment-per-epoch. Rollover appends `segment.closed` + `epoch.summary` in one transaction; closed segments are never rewritten [10][12]. `rollover_is_atomic_scaffolding_for_epoch_resume` exists [25]. Gate-5 archival of closed segments to relayhistory is specified, not implemented as a live reader (Applied; parent did not find a reader either).

**Evaluation already in-tree.** `kernel/relayflowd/tests/crash_resume.rs`: SIGKILL at every hello-ladder boundary and mid-step, then `resume` CLI. Assertions: completed marker effects are not re-executed; journal attempt counts match (`assert_exact_journal`); mid-step dead attempt is explained and retried [26]. That is the gate, not a nice-to-have.

### 3.2 Architecture to keep building (not a new engine)

```
spec (data) ──run.start──► journal append (run.spawned)
                              │
                              ▼
                     fold → RunState
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
     ExecDeterministic    Dispatch llm/agent   ArmTimer / wait
              │               │
              │          effect.record ─► provider ─► effect.confirm
              │               │
              └──── step.completed (memo) ────┘
                              │
                     resume = fold + dispatch unfinished
```

Control flow lives in the spec + kernel machine, not in user source that must re-emit the same Commands. Non-determinism is recorded as facts: LLM output, agent pins, memory pack, routing decision, effect election.

**Do not add Temporal.** Adopting it would require wrapping every `llm`/`agent` step as an Activity and keeping Workflow source deterministic — the thing decision #2 forbids. Parent grep found no Temporal/Inngest/Restate/DBOS adapters in kernel or SDK; do not create them.

**Do copy the useful idea from the memoization family:** named step boundaries whose outputs are the memo table. This kernel already has that as `step.completed.output`. Inngest’s extra trick — defining steps *at runtime* inside an agent loop — is useful for Gate 4 resident loops, but those loops must still journal each iteration as a step, not as Temporal history events.

## 4. Trade-offs and risks

**What this gets right for agents.** An `llm` or `agent` step is not a pure function. Re-running its source to rebuild locals would either re-call the model (budget invariant fails) or require the author to have split every non-deterministic call into an Activity (authoring friction, Temporal versioning hell). Journal + memoization records the *result* and never re-enters completed work. RFC §7’s versioning story follows: old segments need old readers, not old code [10].

**What Temporal still does better.** Fine-grained locals and branches inside one long Workflow function, without declaring a spec step for each. Signal/query as first-class. A large ecosystem (Nexus, multi-language workers, patching libraries). If this product were only hermetic activities with no agents, code replay would be the conservative choice.

**What would make journal + memoization wrong.**

- All steps become deterministic, hermetic, and cheap to re-enter — then code replay’s “workflow is a function” DX wins and the spec compiler is overhead.
- The journal protocol is abandoned for a vendor runtime. Then pins, `completionReason`, two-phase effects, per-step token budgets, and tenant-unaware cells (decision #15) have to be re-expressed in someone else’s model. They will not fit.
- Epoch summaries drift from the folded log (`steps_done` / `budget_spent` disagree). Resume would skip or double-run. Detect by folding the current segment and comparing to `epoch.summary`.
- Unconfirmed effects complete successfully — the crash window between elect and provider call becomes “zero provider calls.” The kernel already refuses this; a regression is a P0.
- Silent re-exec of `step_done` work. Detect: crash tests plus “resumed spend equals one success per step” [12][26].
- Treating LangGraph `durability="async"` or in-memory checkpointers as equivalent. They are not fail-closed [8].
- Calling simulated-clock DST “production replay.” Core tests on `SimClock` pin the machine; they do not replace SQLite crash-injection.

**Operational cost of staying custom.** You own fsync discipline, compaction, leases, and worker dispatch. That is the point of a small Rust kernel. The cost is real: epoch archival is still scaffolding [25]; memory is a stub [24]; mount-as-writer (collapsing two-phase effects) waits on later gates [12].

## 5. What we can leverage

| Item | Fit assessment |
|---|---|
| This kernel’s journal + `RunState::fold` (`kernel/relayflowd-core/src/state.rs`, `machine.rs`, `machine/recovery.rs`) | **Use as-is.** This *is* the recommended approach, already implemented. |
| SQLite WAL + `synchronous=FULL` (`kernel/relayflowd-journal/src/append.rs`) | **Keep.** Fail-closed append; one file per run matches decision #15 (sleeping cell costs storage only). |
| Crash-injection suite (`kernel/relayflowd/tests/crash_resume.rs` and submodules) | **The evaluation harness.** Extend; do not replace with vendor replay testers. |
| Journal protocol v0 (`packages/sdk/src/protocol.ts`, `kernel/DESIGN.md` §5) | **The product boundary.** SDKs speak it; nothing reaches around it. |
| Two-phase effects (`kernel/relayflowd/src/engine/effects.rs`) | **Keep.** Honest about the elect/perform crash window; closer to exactly-once than “at-least-once + hope.” |
| Epoch rollover (`kernel/relayflowd-journal/src/segment.rs`, test in `lib.rs`) | **Scaffolding, not forgetting.** Finish archival to relayhistory; do not rewrite closed segments. |
| Durable channels (`kernel/DURABLE-CHANNELS.md`) | **Result-replay of messages.** Offsets are facts; receive is not re-executed. |
| Step memory (`kernel/MEMORY.md`) | **Journaled pack reuse on resume is right.** Provider is a stub; do not confuse it with Gate 5 quality. |
| Temporal (Event History + code replay) [2][3][7] | **Do not adopt.** Contradicts decision #2. Useful as the negative example and as the competitor Gate 1 must match on durability, not on mechanism. |
| Inngest step memoization [5][9] | **Closest commercial analog.** MIT/SSPL mix and HTTP-invoke model; no artifact/pins/budget kernel. Steal the *explanation*, not the service. |
| Restate journals + Virtual Objects [4] | **Similar durability, wrong protocol.** Extra runtime in front of services; would replace `relayflowd`. License not re-verified here. |
| DBOS Transact on Postgres [6] | **Apache-2.0, library-in-process.** Good fit for DB-local steps; does not give `llm`/`agent` rails, pins, or a journal protocol. Do not replace the kernel with it. |
| Hatchet [14] | **Postgres task log, at-least-once.** Fine as a queue; weaker effect story than Appendix A. |
| LangGraph checkpointers [8] | **Snapshots for graph agents, not a run journal.** `MemorySaver` is not durable. Do not use as the kernel store. |
| Fowler event sourcing + gateways [1] | **Prior art for “replay results, disable external gateways.”** Already encoded as memoization + effect election. |
| 12-factor-agents factor 5 (thread as state) [27] | **Aligned at slogan level** (unify execution and business state as events). Their “thread is the context window” is Gate 4’s *view*, not the journal. History stays complete; context is assembled per wake [10]. |
| Cadence replayer/shadower | **Unverified** (parent did not fetch). Temporal’s ancestor; same code-replay family. |
| FoundationDB / TigerBeetle DST | **Unverified by parent.** Relevant to `SimClock` tests, not to production resume. |

## 6. Open questions

1. **Has a live resident run crossed an epoch boundary on a new `journal_version`?** RFC §7 leaves spec/journal/protocol versioning open until that happens [10]. Result-replay is the claimed escape from Temporal versioning; it is unproven in production in this repo.
2. **When does Gate 4 collapse elect/confirm into “the mount write is the effect record”?** Until then, exactly-once is two-phase and the crash window is real [12].
3. **Channel compaction.** Channel replay currently scans retained segments; there is no bounded snapshot for deleting old segments [23]. Resident runs will hit this.
4. **Dynamic steps inside an agent loop.** Inngest allows `step.run` names decided at runtime [9]. Relayflow specs are compiled, content-addressed bundles (decision #14) [10]. Can a Gate 4 loop journal iteration N as data without minting a new digest every iteration?
5. **Semantic retry vs Temporal retry.** Kernel retries `verification_failed` as a new attempt with a new model call, bounded by `max_iterations`, charging each attempt [12]. Confirm the budget invariant still holds when `inspect` recovery re-enters a dirty workspace.
6. **Vendor lock-in if we ever *embed* Restate/DBOS for a subset of deterministic steps.** Probably not worth it; the protocol would fork.

## 7. Sources

1. https://martinfowler.com/eaaDev/EventSourcing.html — Event log as source of truth; rebuild; external gateways on replay. `verified`
2. https://docs.temporal.io/encyclopedia/event-history/ — Event History; Commands mapped to Events; crash recovery via replay. `verified`
3. https://docs.temporal.io/workflows — Resume re-runs Workflow code from the beginning against history; Activities not re-executed. `verified`
4. https://restate.dev/what-is-durable-execution — Journaled steps; restart and replay recorded results. `verified`
5. https://www.inngest.com/docs/learn/how-functions-are-executed — Step memoization vs Temporal deterministic replay; each step a separate HTTP invocation. `verified`
6. https://docs.dbos.dev/architecture — Postgres checkpoints; recover by restarting the workflow and skipping checkpointed steps; workflow must be deterministic given step outputs. `verified`
7. https://docs.temporal.io/workflow-definition — Determinism constraints; Command/Event matching; non-deterministic errors; versioning. `verified`
8. https://docs.langchain.com/oss/python/langgraph/persistence — Checkpointers as graph-state snapshots; in-memory saver is not durable. `verified`
9. https://www.inngest.com/docs/learn/durable-agents — Calls memoization “deterministic replay”; dynamic agent loops. `verified`
10. `docs/RFC-0001-everything-is-a-relayflow.md` — Decision #2 no deterministic replay; journal + memoization; Appendix A; epoch compaction. `verified`
11. `kernel/DESIGN.md` — Entry types, SQLite schema, memoized resume algorithm, protocol v0. `verified`
12. Same as [11] plus `kernel/relayflowd-core/src/state.rs`, `machine.rs`. `verified`
13. https://temporal.io/blog/of-course-you-can-build-dynamic-ai-agents-with-temporal — Agents via Activities. `unverified` (search snippet only)
14. https://docs.hatchet.run/v1/architecture-and-guarantees — Postgres state; **at-least-once**; tasks must be idempotent. `verified`
15. https://restate.dev/blog/solving-durable-executions-immutability-problem/ — Versioned deployments vs patching. `unverified` (parent did not fetch)
16. https://martinfowler.com/bliki/CQRS.html — CQRS. `unverified` (search only)
17. `packages/sdk/src/protocol.ts` — Verb set including `run.resume`, `effect.record`/`confirm`, `journal.read`. `verified`
18. `kernel/relayflowd-journal/src/append.rs` — Immediate transaction, fail-closed. `verified`
19. `kernel/relayflowd/src/engine.rs` — `resume` / `resume_filtered`. `verified`
20. `kernel/relayflowd-core/src/state.rs` — `RunState::fold`. `verified`
21. `kernel/relayflowd-core/src/machine/recovery.rs` — Dead attempts → `crashed` / `lease_expired`. `verified`
22. `kernel/relayflowd/src/engine/effects.rs` — Elect / confirm. `verified`
23. `kernel/DURABLE-CHANNELS.md` — Replay deliveries, do not re-execute receive. `verified`
24. `kernel/MEMORY.md` — Pack reused on resume; provider stub. `verified`
25. `kernel/relayflowd-journal/src/lib.rs` — `rollover_is_atomic_scaffolding_for_epoch_resume`. `verified`
26. `kernel/relayflowd/tests/crash_resume.rs` — SIGKILL then resume; “completed effects must not be replayed as code”. `verified`
27. https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-05-unify-execution-state.md — Unify execution/business state; resume by loading the thread. `verified`
28. https://web.stanford.edu/class/cs345d-01/rl/aries.pdf — ARIES WAL. `unverified` (Landscape claimed fetch; parent did not)
29. https://cadenceworkflow.io/docs/go-client/workflow-replay-shadowing — Cadence replayer. `unverified`
30. https://apple.github.io/foundationdb/testing.html — Deterministic simulation. `unverified` (parent did not fetch)
31. https://docs.tigerbeetle.com/concepts/safety/ — VOPR / WAL. `unverified` (parent did not fetch)
