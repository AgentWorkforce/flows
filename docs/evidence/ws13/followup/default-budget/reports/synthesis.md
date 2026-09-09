# Synthesis — Durable step journals vs. deterministic replay

Editor's note on lane compliance: the question asked for reports under 200 words.
Only **codex** complied (~190 words). **grok** wrote a compliant §1 and then ~2,900
words under a lane protocol it says overrode the limit; **claude** wrote ~1,900
words with no acknowledgement of the limit. Length did not track quality:
codex's short report is correct but thin, grok's long report carries the most
verified primary-source and in-repo grounding, and claude's mid-length report
contains the one factual error found in this pass (see §3.1).

---

## 1. Recommendation

Keep the durable step journal as the source of truth and recover by folding
recorded facts into state — do not adopt Temporal-style code replay. All three
lanes reach this conclusion independently, and it is already the settled
decision in this repo (RFC-0001, decision #2 [16]). Nothing here argues for a
new engine; the work is finishing the one that exists.

Build, in order:

1. **Close the epoch loop.** Rollover is scaffolding today [23]; finish Gate-5
   archival to relayhistory and add a live reader. Never rewrite a closed
   segment — our escape from Temporal's `GetVersion` tax [4] is *old readers*,
   not old code paths kept alive forever.
2. **Add a summary-vs-fold divergence check.** Fold the current segment and
   assert it equals `epoch.summary`. Drift here silently skips or double-runs
   steps on resume — the highest-severity failure mode this design has.
3. **Harden two-phase effects.** `effect.recorded` → provider → `effect.confirmed`
   [21] leaves a real crash window. Keep refusing a successful completion that
   holds an unconfirmed election; treat regression as P0. Audit which adapters
   actually pass a provider idempotency key (codex).
4. **Extend crash injection, don't replace it.** `crash_resume.rs` [24] is the
   acceptance gate: SIGKILL at every step boundary, assert resumed spend equals
   exactly one success per step. Extend it across epoch boundaries and channels.
5. **Bound channel replay.** Replay scans retained segments with no snapshot
   [25]; resident runs will hit this.

Do not build Temporal, Restate, DBOS, or Inngest adapters. Do borrow their
vocabulary when explaining the design.

## 2. Where the lanes agree

- **Journal + memoization beats code replay for agent/LLM workloads.** An `llm`
  or `agent` step is not a pure function; re-entering its code either re-bills
  the provider or forces every non-deterministic call into an Activity-shaped
  split. (claude, codex, grok)
- **The two are not competing storage technologies.** An append-only log is the
  shared primitive; code replay and result memoization are two *recovery
  procedures* over it. A journal with no skip-on-resume double-charges; code
  replay with no log dies with the process. (claude, grok; codex implicitly)
- **Temporal is the canonical code-replay system, and determinism is the price.**
  Workflow code re-runs from the top against Event History; Activities are not
  re-executed, their results are fed back; incompatible changes need versioning
  [1][2][3][4]. (claude, codex, grok)
- **Isolate side effects from control flow.** Temporal Activities, Inngest
  `step.run`, Restate `ctx.run`, DBOS `@DBOS.step`, Relayflows'
  `deterministic | llm | agent` with effects journaled separately.
  [3][5][7][9][16] (claude, codex, grok)
- **"Exactly-once" is a claim about *effects*, not executions.** Attempts may
  run more than once; idempotency keys and provider cooperation are what make
  the effect single. Vendor "exactly-once" copy that never names the crash
  window is marketing. Hatchet's own guarantees page says at-least-once
  [11]. [9][11][16] (claude, codex, grok)
- **Stable idempotency key across attempts.** `sha256(run_id ‖ step_id)`.
  (claude, grok)
- **Compaction is required and must be lossless.** Segment-per-epoch rollover
  with a summary entry; closed segments archived, never rewritten
  (decision #8) [16][23]. (claude, grok)
- **Don't adopt a vendor runtime.** DBOS/Inngest/Restate validate the pattern;
  migrating buys little and would cost the pins, budgets, `completionReason`,
  and protocol boundary. (claude, codex, grok)
- **Deterministic *simulation* testing (FoundationDB, TigerBeetle) is a
  different thing** wearing the same word — a test technique, not production
  recovery. (claude, grok — both lanes marked their sources unverified, so no
  entry appears in §8)

## 3. Where the lanes disagree

### 3.1 Do step-journal systems re-execute workflow code? — resolved against claude

**claude:** step-journal systems "reject code replay entirely"; DBOS, Restate,
AWS Step Functions "persist step *results* only and never re-execute code."
**grok:** result memoization *does* re-enter the handler — "DBOS restarts the
workflow function with checkpointed inputs and returns checkpointed step
outputs" — and DBOS therefore still requires the workflow function to be
deterministic given step outputs [9].

**Ruling: grok is right, and this is the one substantive error in the pass.**
I re-fetched the DBOS architecture doc to settle it. It states: "DBOS restarts
each interrupted workflow by calling it with its checkpointed inputs. As the
workflow re-executes, it checks before each step if that step's output is
checkpointed in Postgres. If there is a checkpoint, the step returns the
checkpointed output instead of executing," and "The workflow function must be
**deterministic**: if executed multiple times, with the same arguments and step
return values, the workflow should invoke the same steps with the same inputs
in the same order." [9]

This matters beyond pedantry. claude used "never re-executes code" as the
generic property of the step-journal family, which would imply DBOS/Inngest
carry no determinism constraint at all. They carry a *weaker* one —
determinism of control flow given recorded step outputs, rather than
determinism of the whole function including clocks and RNG. The property
claude describes is real, but it belongs to **this kernel specifically**, and
it comes from a different design choice: control flow lives in a declarative
spec folded by `RunState::fold` [18], not in user source that must re-emit the
same calls. That is a stronger position than DBOS's, and it should be argued
on that basis rather than on a false generalization.

### 3.2 Is "deterministic replay" one thing or three? — grok

**grok** splits the term into (1) code replay (Temporal/Cadence), (2) result
replay / step memoization (Inngest, Restate, DBOS, this kernel), (3) snapshot
restore (LangGraph checkpointers), and notes Inngest itself calls (2)
"deterministic replay" [6]. **claude** and **codex** treat the term as
Temporal's meaning only.

**Ruling: adopt grok's taxonomy.** It is the difference between a naming
collision and a disagreement, and it dissolves 3.1's confusion. Use RFC-0001
vocabulary in our own docs — "deterministic replay" means (1) and is rejected —
but expect readers arriving from Inngest to mean (2).

### 3.3 Are agents fine under Temporal if LLM calls are Activities?

**grok** surfaces Temporal's 2025 position that they are (marked unverified,
search snippet only), against RFC-0001's and Inngest's position that agent
loops draw their graph at runtime and the hermetic-function-plus-Activity
split is the wrong authoring model [6][16]. claude and codex do not engage the
counter-argument; claude asserts full-workflow replay is "actively unsafe" for
agent steps.

**Ruling: grok states it fairly and claude overstates.** Temporal-with-
Activities is *workable* — it is not unsafe, it is expensive in authoring
friction and versioning. The honest form of our claim is: the mechanism costs
more than it returns for runtime-shaped agent graphs, not that it corrupts
state. Note this is an unsettled industry split, and grok's citation for
Temporal's side is unverified.

### 3.4 What would make this recommendation wrong?

**claude:** mature-ecosystem pull — Temporal Cloud, observability, six-plus
language SDKs — could outweigh the versioning cost for deterministic
orchestration. **grok:** the falsifiers are internal — all steps becoming
cheap and hermetic, epoch summaries drifting, unconfirmed effects completing.
**codex** does not address it.

**Ruling: both, and they are not in tension.** claude's is the "should we have
started here" question and is now moot; grok's are live regression detectors
and belong in CI. Item 2 of §1 comes from grok's list.

### 3.5 Depth and scope

**codex** answered the question asked, at the length asked, and its terse
claims all hold. **grok** exceeded the limit tenfold and returned the only
report with a per-file map of the existing implementation. **claude** exceeded
it fivefold and returned the weakest source verification (five of eleven
sources unverified, including two it built argument on).

**Ruling: grok's report is the spine of this synthesis, codex's is the correct
answer in miniature, claude's contributes the ZenML citation and the
external-maturity framing.** Length was not what separated them — verification
discipline was.

## 4. Single-source claims worth keeping

- **ZenML's "No Journal, No Replay" / Kitaru** (claude, verified [13]) — the
  clearest public statement of the counter-position: cache step *outputs* in an
  artifact store, accept seconds-not-milliseconds resume, on the argument that
  LLM latency dominates anyway so the "determinism tax" buys nothing. This is
  the best external corroboration of decision #2 and the only lane to find it.
- **Temporal's versioning tax has a name and an API** (claude, verified [4]) —
  `GetVersion`/Patch requires permanent code branches for the lifetime of any
  long-running execution started under the old version. This is the concrete
  cost our "old readers, not old code" story avoids.
- **Hatchet is explicitly at-least-once** (grok, verified [11]) — the cleanest
  citation for why "transactionally-safe event log" marketing copy does not
  imply no duplicates.
- **LangGraph checkpointers are snapshots, not a command log** (grok, verified
  [12]) — `InMemorySaver` does not survive restart; `durability="async"` is not
  fail-closed. You can project a snapshot from a journal, not the reverse. Worth
  keeping because "durable agents" claims in this space often rest on this.
- **The elect→perform→confirm duplication window** (codex and grok, from
  `kernel/DESIGN.md` [17][21]) — codex names it as the headline risk in five
  words; grok explains that an unconfirmed election deliberately does not
  suppress the next attempt because the winner may have died before the
  provider call. Both matter: it is the sharpest honest weakness in the current
  design.
- **Provider idempotency is per-adapter, not global** (codex, open question) —
  the kernel's stable key is worth nothing on an adapter whose provider ignores
  it. No other lane asked.
- **12-factor-agents factor 5** (grok, verified [15]) — aligned at slogan level
  only; their "thread is the context window" is a *view*, not the journal.
- **Fowler's external-gateway rule** (grok, verified [14]) — the 2005 statement
  of the same constraint: replaying the log must not re-send external effects.
  Useful as prior art when explaining that none of this is novel.

## 5. The plan

**Repository mapping.** The question named no repositories; all three lanes
grounded it in this repo, and I follow them. The system under discussion is the
`relayflowd` kernel (`kernel/relayflowd-core`, `kernel/relayflowd-journal`,
`kernel/relayflowd`) plus the TypeScript SDK (`packages/sdk`), governed by
`docs/RFC-0001-everything-is-a-relayflow.md` and `kernel/DESIGN.md`. External
repos (temporalio, dbos-inc, inngest, restatedev, langchain-ai/langgraph) are
reference material, not integration targets — the lanes are unanimous that no
adapter should be written, and grok's grep confirms none exists.

### Phase 0 — hold the line (already done; do not redesign)

Verified present: pure state machine on a `Clock` trait with `SimClock` in
tests [18]; SQLite per run with `journal_mode=WAL`, `synchronous=FULL`, one
transaction per append, fail-closed to `journal_write_failed` [22]; envelope of
`seq`, `segment_id`, `entry_type`, `run_id`, `step_id`, `attempt`, `at_ms`,
canonical JSON payload [17]; `Engine::resume` folding entries and filtering
dead attempts [20][19]; crash-injection suite [24].

### Phase 1 — data model

Keep the entry set: `run.spawned`, `step.attempt.started` (pins, idempotency
key, lease), `step.completed` (`completionReason`, `disposition`, memoized
`output`, budget), waits/sleeps, `stream.appended`, `effect.recorded` /
`effect.confirmed`, `memory.injected`, `epoch.summary`, `segment.closed`,
`run.completed` [17]. Additive-only payload fields with versioned readers
(claude's mitigation for schema drift, which is the mechanism RFC §7 leaves
open). One SQLite file per run — a sleeping cell then costs storage only
(decision #15).

### Phase 2 — write path

Unchanged in shape: append before the caller observes a result; a failed commit
fails the step with no fallback [22]. Effects stay two-phase until Gate 4 makes
the mount the writer and the election *is* the record. Until then, document the
window rather than claiming exactly-once.

### Phase 3 — retrieval / resume

`resume` = open run file, load spec, fold current segment via `RunState::fold`,
run recovery for dead attempts (`crashed` / `lease_expired` unless a live
worker holds the lease), dispatch only unfinished work [18][19][20]. Completed
steps become `Done` with `output` injected as fact: zero tokens, zero new
entries. Open waits re-arm, elapsed timers fire. Channel replay reads recorded
deliveries in journal sequence and does not re-invoke receive [25]. Memory
reuses the journaled pack rather than re-calling the provider [26] — noting the
provider is currently `FixedMemoryProvider`, a substrate stub, and its being a
stub says nothing about retrieval quality.

### Phase 4 — consolidation / forgetting

Segment-per-epoch. Rollover appends `segment.closed` + `epoch.summary` in one
transaction; closed segments are never rewritten [16][17]. `segment.rs` and the
`rollover_is_atomic_scaffolding_for_epoch_resume` test exist [23]; Gate-5
archival to relayhistory is specified but has no live reader — that is the gap.
Add the fold-vs-summary equality check here.

### Phase 5 — evaluation

`kernel/relayflowd/tests/crash_resume.rs` [24] is the gate, not a nice-to-have:
SIGKILL at every hello-ladder boundary and mid-step, then `resume`; assert
completed marker effects are not re-executed, journal attempt counts match
(`assert_exact_journal`), and mid-step dead attempts are explained and retried.
Extend with: epoch-boundary crashes, channel-replay crashes, an
unconfirmed-election regression test, and the resumed-spend invariant stated as
an explicit assertion. `SimClock` tests pin the machine and do not substitute
for SQLite crash injection. claude's suggested "replay-divergence checks"
apply only to any code-replay component we adopt — we have none, so the
equivalent here is the fold-vs-summary check.

### Phase 6 — boundary discipline

Journal protocol v0 (`packages/sdk/src/protocol.ts` [27], `kernel/DESIGN.md`
§5) is the product boundary: SDKs speak it, nothing reaches around it. Grok's
framing is right — the protocol, not the storage engine, is what would be lost
by adopting a vendor runtime.

## 6. Leverage, ranked

1. **This kernel's journal + `RunState::fold`** [16][17][18] — *use as-is*; it
   is the recommendation, already implemented. (claude, codex, grok)
2. **Crash-injection suite** [24] — the evaluation harness; extend, never
   replace with a vendor replay tester. (grok, codex)
3. **SQLite WAL + `synchronous=FULL`, one file per run** [22] — keep;
   fail-closed append matched to decision #15. (codex, grok)
4. **Journal protocol v0** [27] — the product boundary. (grok)
5. **Two-phase effects** [21] — keep; honest about the crash window, closer to
   exactly-once than at-least-once-and-hope. (codex, grok)
6. **Inngest step memoization** [5][6] — closest commercial analog; steal the
   *explanation* (including their runtime-defined step names for Gate 4 loops),
   not the service. HTTP-invoke model, no artifact/pins/budget kernel. (codex,
   grok)
7. **Fowler event sourcing + external gateways** [14] — the canonical prior art
   for "replay results, disable external gateways"; already encoded here.
   (grok)
8. **DBOS Transact** [9][10] — Apache-2.0, in-process library, Postgres
   checkpoints. Good study material for checkpoint/dedupe SQL; adopting it
   means abandoning the Rust/SQLite kernel and it gives no `llm`/`agent` rails,
   pins, or protocol. Note it *does* re-enter workflow code (§3.1). (claude,
   codex, grok)
9. **ZenML "No Journal, No Replay" / Kitaru** [13] — no code to adopt; the best
   external write-up of our own position. (claude)
10. **Restate journals + Virtual Objects** [7][8] — similar durability, wrong
    protocol; an extra runtime in front of services that would replace
    `relayflowd`. License not re-verified by any lane. (claude, codex, grok)
11. **Hatchet** [11] — Postgres task log, explicitly at-least-once; fine as a
    queue, weaker effect story than Appendix A. (grok)
12. **12-factor-agents factor 5** [15] — aligned at slogan level; useful
    framing, no implementation. (grok)
13. **Temporal** [1][2][3][4] — *do not adopt*; contradicts decision #2. Its
    genuine advantages (fine-grained locals inside one long function without
    declaring a spec step, signals/queries as first-class, multi-language
    workers, Nexus) are the honest case against us, and are worth naming in
    docs rather than eliding. (claude, codex, grok)
14. **LangGraph checkpointers** [12] — snapshots, not a run journal; not
    durable by default. Do not use as the kernel store. (grok)
15. **AWS Step Functions / Azure Durable Functions** — cloud-locked, wrong
    model for a self-hostable multi-language kernel. Ranked last and cited by
    claude only, whose sources for both were unverified — no §8 entry.

## 7. Open questions

1. **Has a live resident run crossed an epoch boundary on a new
   `journal_version`?** RFC §7 leaves spec/journal/protocol versioning open
   until one has. "Old readers, not old code" is our claimed escape from
   Temporal's patching and is unproven here. (claude, grok)
2. **Do epoch summaries provably match the folded log?** No check exists.
   Drift means skipped or double-run steps on resume. (grok)
3. **Can every adapter enforce provider idempotency?** A stable key is worth
   nothing against a provider that ignores it; which adapters actually pass it
   through? (codex)
4. **What retention and resume-latency bounds pass crash injection?** No
   quantified resume-latency comparison against Temporal-style replay exists —
   decision #2 rests on qualitative reasoning. That is defensible, but say so.
   (claude, codex)
5. **When does Gate 4 collapse elect/confirm into "the mount write is the
   effect record"?** Until then the crash window is real. (grok)
6. **Channel compaction.** Replay scans retained segments with no bounded
   snapshot; resident runs will hit this. (grok)
7. **Dynamic steps inside an agent loop.** Can a Gate 4 loop journal iteration
   N as data without minting a new content-addressed spec digest per iteration
   (decision #14)? (grok)
8. **Does `inspect` recovery into a dirty workspace preserve the budget
   invariant** when `verification_failed` retries charge each attempt? (grok)
9. **How does compaction handle a step whose output payload schema changes
   across a kernel upgrade** in practice? (claude)
10. **Is embedding Restate/DBOS for a deterministic-step subset ever worth it?**
    Grok's own answer — probably not, the protocol would fork — is convincing;
    left open only because nobody has priced it. (grok)

## 8. Sources

Union of sources at least one lane marked **verified**. Sources the lanes
listed as unverified are excluded (Vanlightly's determinism essay, the DBOS
VLDB paper, Cadence replayer, ARIES, CQRS, FoundationDB, TigerBeetle, Temporal's
dynamic-agents blog, Restate's immutability post, Azure Durable Functions,
Restate Go durable-steps) except where I fetched them myself — see [9].

1. https://docs.temporal.io/encyclopedia/event-history/ — Event History as
   durable log; Commands mapped to Events; recovery by replaying code.
   (claude, grok)
2. https://docs.temporal.io/workflows — resume re-runs Workflow code from the
   top against history; Activities are not re-executed. (grok)
3. https://docs.temporal.io/workflow-definition — determinism constraints,
   Command/Event matching, non-deterministic errors, versioning. (codex, grok)
4. https://docs.temporal.io/develop/go/workflows/versioning — `GetVersion` /
   Patch API for replay-safe code evolution. (claude)
5. https://www.inngest.com/docs/learn/how-functions-are-executed — step
   memoization; explicitly distinguished from Temporal's model; each step a
   separate invocation. (codex, grok)
6. https://www.inngest.com/docs/learn/durable-agents — calls memoization
   "deterministic replay"; runtime-defined steps in agent loops. (grok)
7. https://restate.dev/what-is-durable-execution — journaled steps; restart and
   replay recorded results. (grok)
8. https://docs.restate.dev/ai/patterns/durable-agents — the same applied to
   LLM/tool calls. (codex)
9. https://docs.dbos.dev/architecture — Postgres checkpoints; recovery restarts
   the workflow function with checkpointed inputs and short-circuits
   checkpointed steps; workflow must be deterministic given step outputs.
   (grok; **re-fetched by the editor** to resolve §3.1)
10. https://www.dbos.dev/blog/postgres-is-all-you-need-for-durable-execution —
    workers checkpoint steps to Postgres; recovery from checkpoints; Postgres
    constraints dedupe concurrent attempts. (claude)
11. https://docs.hatchet.run/v1/architecture-and-guarantees — Postgres state;
    at-least-once; tasks must be idempotent. (grok)
12. https://docs.langchain.com/oss/python/langgraph/persistence — checkpointers
    as graph-state snapshots; in-memory saver is not durable. (grok)
13. https://www.zenml.io/blog/no-journal-replay — the case against journal-replay
    for AI agents; Kitaru caches step outputs in an artifact store. (claude)
14. https://martinfowler.com/eaaDev/EventSourcing.html — event log as source of
    truth; external gateways must be gated on replay. (grok)
15. https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-05-unify-execution-state.md
    — unify execution and business state; resume by loading the thread. (grok)
16. `docs/RFC-0001-everything-is-a-relayflow.md`
    — decision #2 (no deterministic replay), journal + memoization, Appendix A,
    epoch compaction, decisions #8/#14/#15. (claude, grok)
17. `kernel/DESIGN.md` — entry types, SQLite
    schema, memoized resume algorithm, protocol v0, elect/perform/confirm.
    (codex, grok)
18. `kernel/relayflowd-core/src/state.rs`,
    `machine.rs` — `RunState::fold`; pure state machine on a `Clock` trait.
    (grok)
19. `kernel/relayflowd-core/src/machine/recovery.rs`
    — dead attempts resolved to `crashed` / `lease_expired`. (grok)
20. `kernel/relayflowd/src/engine.rs` —
    `resume` / `resume_filtered`. (grok)
21. `kernel/relayflowd/src/engine/effects.rs`
    — two-phase election and confirmation. (grok)
22. `kernel/relayflowd-journal/src/append.rs`
    — immediate transaction, fail-closed append. (grok)
23. `kernel/relayflowd-journal/src/segment.rs`,
    `lib.rs` — segment rollover;
    `rollover_is_atomic_scaffolding_for_epoch_resume`. (grok)
24. `kernel/relayflowd/tests/crash_resume.rs`
    — SIGKILL at step boundaries then `resume`; completed effects must not be
    replayed as code; `assert_exact_journal`. (grok)
25. `kernel/DURABLE-CHANNELS.md` — replay
    recorded deliveries; do not re-execute receive. (grok)
26. `kernel/MEMORY.md` — journaled pack
    reused on resume; `FixedMemoryProvider` is a stub. (grok)
27. `packages/sdk/src/protocol.ts` — verb set
    including `run.resume`, `effect.record` / `confirm`, `journal.read`. (grok)
