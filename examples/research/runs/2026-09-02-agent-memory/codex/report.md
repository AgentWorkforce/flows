# Agent memory for a cloud agent: best-in-class design and what to leverage

## Executive summary

Build the relayfile cloud agent as a **journaled materialized view over relayhistory-cloud**, not as a new generic memory platform. Keep immutable, cited session events as episodic evidence; derive versioned semantic claims and carefully admitted procedural memories; represent only useful cross-service relationships as a bitemporal graph in ordinary Postgres tables. At wake time, retrieve in parallel with exact/lexical, vector, metadata/time, file-overlap, and graph-neighbor searches; fuse and rerank the results; then construct an exactly token-counted, cited pack charged to the consuming Relayflow step.

This extends the current Neon/pgvector convergence store and preserves Relayflows' journal protocol. The critical prerequisite is better capture: today's cloud outbox omits tool calls, file edits, commit links, and trajectory updates, while current Learn and Pair cover only narrow subsets. Add a transactional memory-work outbox, authoritative project/dependency profiles, evidence classes, source-level ACLs, and bitemporal supersession before attempting autonomous consolidation.

Do not make Graphiti, Mem0, Letta, or Hindsight the system of record. Borrow their proven ideas and run Hindsight as a shadow benchmark. Ship only after a chronological relayfile evaluation shows cited memory prevents known mistakes under fixed latency and token budgets.

## Landscape and best practices

The older canonical work established the useful vocabulary: CoALA separates working, episodic, semantic, and procedural memory [1]; MemGPT treats limited context as a paging problem [2]; Generative Agents combines recency, relevance, importance, and reflection [3]; Reflexion reuses textual lessons from feedback [4]. The last 18 months have moved the center of gravity from “store chat embeddings” to a complete memory lifecycle.

### Broad consensus

- **Preserve evidence and derive revisable views.** Graphiti makes raw episodes the provenance root of temporal facts [7]. In Redis's June 2026 LongMemEval experiment, raw hybrid excerpts plus extracted facts scored 86.1% versus 71.2% for extracted facts alone in that particular setup [6]. This is vendor research, not a universal benchmark result, but it demonstrates why extraction must not destroy access to omitted names, dates, symbols, and numbers.
- **Use typed memory.** Episodic evidence answers “what happened”; semantic claims describe current dependencies, contracts, decisions, and incident state; procedural memory contains validated playbooks and recurring warnings. LangMem exposes this taxonomy and both hot-path and background formation [12]. The types can share one database, but should have different admission, decay, and retrieval policies.
- **Use hybrid, scoped retrieval.** Dense search handles paraphrases; lexical search handles package names, paths, error strings, API fields, and versions; metadata/time/ACL filters prevent broad semantic matches from leaking or crowding out exact evidence. pgvector itself recommends combining vector search with Postgres full-text search and fusion or reranking [17].
- **Treat change and uncertainty as first-class.** LongMemEval evaluates temporal reasoning, updates, and abstention [5]; MemoryAgentBench adds selective forgetting [10]. Engineering memory needs valid time, observation time, contradiction, supersession, confidence, and evidence status—not “latest note wins.”
- **Assemble bounded context, not a transcript dump.** LongMemEval-V2 fixes a reader model and evaluates a memory system that must return bounded evidence from 25M–115M-token agent histories, including workflows, gotchas, dynamic state, and false premises [9]. Claude Code's small startup index plus on-demand topic files [14], Letta's size-bounded blocks [13], and OpenAI's “map, not encyclopedia” repository practice [20] all support progressive disclosure.
- **Keep mandatory rules authoritative elsewhere.** Official Codex documentation says memory is a helpful recall layer, not the sole source for required team guidance [15]. Claude Code likewise distinguishes human-authored instructions from auto memory [14]. A memory may propose an `AGENTS.md` change; it should not silently become policy.
- **Product-native memories are useful edge caches, not the cross-tool plane.** Claude Code uses project-scoped files [14], Codex keeps a local recall store with background extraction/consolidation controls [15], and Cursor's sidecar proposes project memories for user approval [16]. None supplies the hosted, cross-repository, source-cited convergence required here.
- **Evaluate retrieval and behavior separately.** Measure evidence recall and citation support, but also whether the same task/model avoids a known mistake with memory enabled. LongMemEval's indexing/retrieval/reader decomposition [5] and LongMemEval-V2's bounded-context and latency protocol [9] are useful templates.

### Contested or emerging

Temporal knowledge graphs are valuable for “service A consumes contract B, which decision C changed,” but graph-first memory is not settled. Graphiti offers strong bitemporal provenance and incremental invalidation [7], while Hindsight combines vector, keyword, graph, and temporal retrieval over Postgres/pgvector [8]. Mem0's vendor-authored study shows only a modest aggregate improvement from its graph variant [11]. The best current position is a layered system: atomic notes/claims remain the main retrieval objects; a selective temporal graph supplies multi-hop candidates.

Other active debates are agent-managed writes versus background curation, learned self-organization versus constrained schemas, and universal time decay versus type-specific validity. A-MEM's dynamically linked notes are promising [21], but an unconstrained agent that rewrites its own procedures can amplify a hallucination. Procedural admission should require repeated independent outcomes, executable verification, or human approval. “Forgetting” should normally mean dormant/superseded and excluded from current retrieval, not deletion of cited history.

### Mostly marketing

“Human-like memory,” “memory operating system,” and “eliminates RAG” are metaphors or product positioning. Hindsight is genuinely MIT-licensed, Postgres/pgvector-backed, and unusually close to this stack [8][22], but its headline accuracy is still reported by its authors. The same caveat applies to Mem0 and Zep/Graphiti benchmark claims. Rankings are not comparable unless the dataset version, answer model, judge, extraction budget, retrieval budget, latency, and managed-versus-OSS implementation are held constant. Graphs, reflection, and more reasoning should therefore be ablations in a relayfile benchmark, not architecture articles of faith.

## Recommended approach

### 1. Preserve the journal boundary and close capture gaps

Relayflows Gate 5 already states the right contract: before an ephemeral agent step, `ai-hist pack`/`why_for_task` provides a cited pack; afterward `ai-hist learn` distills the trajectory; `pair` can serve cited warnings; memory tokens belong to the consuming step (`docs/RFC-0001-everything-is-a-relayflow.md`). `f.memory.recall`, `why`, and `learn` are the intended TypeScript surface (`docs/SURFACE.md`). However, the inspected `kernel/relayflowd-core/src/spec.rs` and `sdk/src/spec.ts` do not yet implement memory fields, so this is a target contract rather than a finished path.

Extend the Rust sync outbox first. It currently advances only `history_id` and `trajectory_rowid` and exports prompts plus trajectories (`../relayhistory/crates/ai-hist-core/src/outbox.rs`); it omits `session_events`, `tool_calls`, `file_edits`, and `session_commit_links`, and its own comment notes that row-id cursors miss an updated trajectory. The prompt mapper also drops local project information (`../relayhistory/crates/ai-hist-core/src/convergence.rs`). Add update watermarks and propagate normalized project, repository remote, task/run/trace IDs, commit SHA, file changes, tool results, and session outcomes. Prefer one shared deterministic capture ID across the journal, ai-hist, trajectories, and burn; scored cross-lens inference should be fallback only.

Treat a session as evidence of what was asserted or attempted—not proof that it shipped. Every extracted item should be `asserted`, `observed` (file/tool evidence), or `corroborated` (commit, CI, deploy, release, or incident evidence).

### 2. Make the relayfile neighborhood explicit

Create a versioned `project_profiles` record, preferably checked in and projected to cloud storage. It should list authorized aliases, owned entities, packages, domains, contracts, code paths, and one-/two-hop dependencies. Initial relayfile evidence exists in `../relayfile-cloud/docs/migration-plan.md`, `../relayfile/README.md`, and `../relayfile/package.json`: `relayfile`, `relayfile-cloud`, legacy `cloud/packages/relayfile`, `relayfile-adapters`, packages such as `@relayfile/core`, the `file.agentrelay.com` service, RelayAuth, and Relayflows are obvious seeds. Models may propose aliases or edges, but a deterministic source or human must activate them.

Every incoming event is sifted, but not every transcript receives an LLM call. Deterministic triage should score exact repo/package/domain/path matches, manifest/lock/API/schema edits, dependency-neighbor matches, incidents/reverts, file overlap, and repeated failures. For every retained item the extractor must state *why relayfile is affected*; “semantically similar” alone is insufficient.

### 3. Store three layers and a bounded temporal graph

Reuse `convergence_events` as the immutable episodic ledger and `patterns`/`pattern_hits` as the procedural scaffold (`../relayhistory-cloud/packages/relayhistory/src/db/schema.ts`). Add:

- `entities` and `entity_aliases` for projects, repos, packages, services, APIs, files, dependencies, and incidents;
- `memory_claims` with type, subject/predicate/object, statement, `impact_on_relayfile`, evidence class, confidence, salience, lifecycle status, valid-from/to, observed-from/to, expiry, supersession, extractor version, and embedding metadata;
- `memory_evidence`, linking every claim or pattern to the complete convergence natural key plus support/contradiction role and a resolvable source span/hash;
- `memory_jobs` for durable extraction/consolidation work; and
- `memory_retrieval_log` for candidates, scores, selection, pack digest, feedback, and outcome.

Statuses should include `candidate`, `active`, `contested`, `superseded`, `dormant`, and `retracted`. Ordinary Postgres edges are sufficient for the expected one- or two-hop relations; recursive CTEs avoid a second authorization and operations plane.

### 4. Make extraction durable, cited, and hostile-input-safe

In the same transaction that accepts/upserts a convergence event, insert candidate memory jobs keyed by `(event natural key, project-profile version, extractor version, content hash)`. A Relayflow drains them through deterministic shortlist, evidence-window expansion, strict structured extraction, citation validation, materialization, and consolidation steps. Each transition journals inputs, model/prompt/profile versions, token/cost usage, output IDs, retry state, and `completionReason`. The job table is truth; a queue only wakes workers.

Reject support keys or spans that were not in extractor input. Treat raw session content as quoted untrusted data, never as instructions; MINJA demonstrates that normal interactions can poison an agent's memory [18]. Enforce tenant and source-repository visibility both before ranking and when resolving citations. For the enterprise opaque tier described in `../relayhistory-cloud/docs/product-direction.md`, extraction must run inside the tenant/self-host boundary and push opaque derived artifacts; a vendor-readable cloud sifter cannot inspect E2E ciphertext.

### 5. Consolidate by evidence, not prose replacement

Cluster compatible claims by canonical subject/predicate/object/project and add evidence. Overlapping contradictions become `contested`; explicit temporal or authoritative evidence supersedes old state. Keep dependency/API facts active until superseded, give incident warnings a review date, and make single-session procedures candidates only. Promote a procedure after repeated independent successful outcomes, an executable check, or human approval. Inactivity lowers retrieval priority or makes an item dormant; it must not lower factual confidence by itself. Privacy deletion is a separate operation that cascades into claim recomputation.

Record embedding model, dimensions, content hash, and generation time separately from the claim. The present schema has embedding columns but no inspected producer/backfill path or model-version metadata; use dual-write and backfill before switching models.

### 6. Retrieve and pack under the step's real budget

At wake time, parse project, task, revision, trigger/thread, likely files/symbols/dependencies, and the declared memory budget. Expand through the project profile, then retrieve separate pools for current neighborhood changes, task facts/decisions, procedures, and incidents/mistakes. In parallel run exact identifier/path lookup, stored Postgres FTS, pgvector search, file overlap, valid-time queries, verified outcome search, and bounded graph neighbors. Apply ACL, project, status, and temporal filters before ranking; HNSW filtering can otherwise reduce recall [17].

Fuse ranks with reciprocal-rank fusion, rerank only the small fused set, diversify duplicates, and require resolvable evidence for selection. Construct sections such as “current state,” “recent changes,” “gotchas,” “playbooks,” and “uncertainties.” Each item carries a stable ID, explicit impact, evidence class, confidence, effective/observed dates, and citations. Label model-inferred impact as inference.

Use an exact target-model tokenizer and a utility-per-token selector with per-section ceilings and reserved citation overhead. Replace local `pack`'s current `tokens × 4` character approximation applied per result (`../relayhistory/crates/ai-hist/src/lib.rs`). Journal candidate scores, selected IDs, exact token count, and final pack digest; resume the same step/epoch with that digest. Pair should query the same derived index with stricter precision/latency thresholds and write `pattern_hits`, replacing its current independent raw-event path in `../relayhistory-cloud/packages/relayhistory/src/lib/pair.ts`.

### 7. Prove it chronologically

Build a leakage-safe relayfile benchmark: at query time *T*, retrieval sees only items observed by *T*, while labels may inspect later outcomes. Include dependency/API changes, sibling decisions, incidents, repeated mistakes, superseded facts, false premises, similarly named repos, missing project IDs, poisoned text, and ACL canaries.

Measure extraction F1 by item/project, citation attachment precision, asserted-versus-shipped errors, and cost; retrieval Recall@k/nDCG, project precision, temporal validity, contradiction recall, citation support, stale rate, token overflow, p50/p95, and cost; then replay the same Relayflow task/model with memory off/on and check task success, repeated-mistake avoidance, citations, tokens, dollars, and latency. Use ablations for raw-only, derived-only, hybrid, graph-off/on, and cheap/deep retrieval. Crash between ingest/job/materialization, remove sole support, add superseding evidence, revoke access, and change embedding models. Relayfile's `../relayfile/evals` and `../relayfile/scripts/evals` can host cases; Relayflows' journal crash tests should pin exactly-once materialization and budget charging. Gate 5's acceptance remains the decisive proof: a cited prior learning changes behavior.

## Trade-offs and risks

- **Selective graph versus graph service.** Relational edges are less expressive than Graphiti but keep tenancy, transactions, backups, and operations in Neon. If benchmarked queries require deeper traversal or relational CTEs miss SLOs at realistic scale, this recommendation becomes wrong and a dedicated graph backend should be reconsidered.
- **Extraction cost versus coverage.** Deterministic triage makes “all sessions” economical but can miss indirect impact. Track unresolved-project rate and sample rejected events. If marginal recall requires LLM inspection of nearly everything, budgets and batching need redesign.
- **Session claims versus truth.** Agents discuss plans that never ship. Without commit/CI/deploy/incident producers, the system will confidently remember fiction. Current code and live contract sources should be revalidated at wake when freshness matters; OpenAI's internal data agent similarly combines stored context with live checks [19].
- **Security and poisoning.** Cross-tool ingestion expands prompt-injection and secret exposure. Required controls are pre-storage and egress scrubbing, quoted-data rendering, admission quarantine for procedures, citation hashes, source trust labels, ACL canaries, and repository-level authorization—not only organization tenancy.
- **Staleness and self-reinforcement.** Retrieval clicks are not truth. Wrong memories can collect confirmations if later agents echo them. Require independent evidence, surface contradictions, and measure recurrence after warnings.
- **Vector/index behavior.** Approximate vector indexes trade recall for speed and can behave poorly with post-filtering [17]. Maintain exact-search shadow samples and inspect query plans. Embedding model changes require versioned dual indexes.
- **Opaque enterprise tier.** The default vendor-readable sifter cannot serve E2E ciphertext. If most target customers require opaque storage without tenant-side compute, the centralized design is wrong.
- **No demonstrated benefit yet.** If a time-split A/B shows no improvement in relayfile task success or known-mistake avoidance at the agreed token/latency/cost budget, do not ship the graph or consolidation machinery. Improve capture/relevance—or stop.

## What we can leverage

| Component | Fit assessment |
|---|---|
| `../relayhistory` Rust/SQLite/FTS5, distiller, convergence mapper, MCP | **Adopt and extend.** It already captures cross-tool local evidence and the citation-facing commands; expand its outbox, provenance, and exact token accounting. |
| `../relayhistory-cloud` Neon/Drizzle/Hono schema | **Keep as system of record.** `convergence_events`, `session_outcomes`, `patterns`, and `pattern_hits` are the right bones; add a transactional memory outbox and semantic/evidence tables. Standard Postgres limits data lock-in. |
| Existing cloud Learn and Pair | **Reuse contracts, replace internals.** Learn currently mines only reverted mistakes and activates at two samples; Pair ranks raw findings/reflections/decisions with `ILIKE`/runtime FTS and does not consume patterns. |
| Relayflows journal and `f.memory` surface | **Adopt as execution boundary.** It supplies identity, durability, `completionReason`, per-step budget ownership, and the wake/learn/pair lifecycle; implementation is still incomplete. |
| PostgreSQL FTS + pgvector [17] | **Adopt now.** Best stack fit and no extra service; use generated `tsvector`/GIN plus vector HNSW, exact-search shadows, and explicit model metadata. |
| Hindsight [8][22] | **Shadow benchmark/design source.** MIT, active, Postgres+pgvector and TypeScript client are unusually aligned; Python service and LLM extraction add operational cost, and vendor claims need reproduction. |
| Graphiti [7] | **Borrow the model, not runtime.** Apache-2.0 temporal provenance is strong; Python plus Neo4j/FalkorDB/Neptune adds a second store and authorization plane. |
| Mem0 [11][23] | **Use as extraction/search baseline.** Apache-2.0 with Python/TypeScript surfaces; generic user memory and managed/OSS differences do not fit a cited journal-owned system of record. |
| LangMem [12] | **Borrow hot/background patterns and prompts.** MIT and clean abstractions; Python/LangGraph is a poor core-runtime fit for Rust/TS. |
| Letta/MemGPT [2][13] | **Borrow paging and bounded-block ideas.** Stateful agent ownership conflicts with ephemeral Relayflow steps and journal-owned continuity. |
| LongMemEval, LME-V2, MemoryAgentBench [5][9][10] | **Reuse protocols and cases, not scores.** LME-V2 is closest to trajectory retrieval; add coding, provenance, and cross-repo impact cases. |
| Promptfoo [24] | **Adopt for model/prompt/adversarial comparisons.** MIT and provider-neutral; configurations/custom scripts remain trusted code. |
| `fastembed-rs` [25] | **Optional for local/E2E embeddings and reranking.** Apache-2.0/Rust-native; ONNX models add CPU/cache cost and do not fit Workers naturally. |

## Open questions

1. Which repos, packages, services, schemas, domains, owners, and aliases constitute relayfile's authorized one- and two-hop neighborhood, and who approves profile changes?
2. What RelayAuth policy permits a relayfile-scoped agent to inspect sibling-repo sessions, and must citation resolution re-check the requesting step's current access?
3. Which systems are authoritative for “shipped”: Git commits, CI, deployments, package registries, contract registries, incident tools, or all of them? Who will add those convergence producers?
4. Where does extraction run for the E2E tier, and can an opaque derived memory preserve verifiable citations without exposing content to the vendor?
5. What are the initial wake-pack and Pair token, p95 latency, and dollar budgets? Which target models/tokenizers must be supported?
6. What promotion threshold distinguishes a suggestion, an active warning, and a proposed source-controlled rule? Which cases require human approval?
7. What retention/deletion policy applies to raw episodes, snippets, embeddings, and derived claims, and how quickly must deletion recompute dependent memories?
8. Can the team curate a chronological gold set of real relayfile tasks and failures before schema work, including false premises and negative “nothing relevant” cases?
9. Are current cloud embedding columns populated anywhere outside the inspected repository? Which embedding/reranker models, dimensions, and migration policy are acceptable?
10. What measured graph-depth, scale, or latency threshold would justify a dedicated graph service rather than Postgres edges?

## Sources

1. **verified** — https://arxiv.org/abs/2309.02427 — CoALA memory taxonomy and modular agent architecture.
2. **verified** — https://arxiv.org/abs/2310.08560 — MemGPT virtual context management and memory tiers.
3. **verified** — https://arxiv.org/abs/2304.03442 — Generative Agents' recency/relevance/importance retrieval and reflection.
4. **verified** — https://arxiv.org/abs/2303.11366 — Reflexion's feedback-derived textual lessons.
5. **verified** — https://arxiv.org/abs/2410.10813 — LongMemEval abilities, decomposition, and retrieval refinements.
6. **verified** — https://redis.github.io/redis-ai-research-public/longmemeval-agent-memory/ — Redis raw-plus-extracted LongMemEval experiment; vendor study with disclosed limitations.
7. **verified** — https://github.com/getzep/graphiti — Apache-2.0 temporal graph, episode provenance, hybrid retrieval, and backend requirements.
8. **verified** — https://aclanthology.org/2026.acl-demo.27/ — Hindsight ACL 2026 system demonstration and architecture.
9. **verified** — https://arxiv.org/abs/2605.12493 — LongMemEval-V2 agent-trajectory memory benchmark.
10. **verified** — https://arxiv.org/abs/2507.05257 — MemoryAgentBench incremental evaluation and selective forgetting.
11. **verified** — https://arxiv.org/abs/2504.19413 — Mem0 architecture and vendor-authored evaluation.
12. **verified** — https://github.com/langchain-ai/langmem — MIT LangMem hot/background memory primitives.
13. **verified** — https://github.com/letta-ai/letta — Apache-2.0 Letta stateful-agent memory platform.
14. **verified** — https://code.claude.com/docs/en/memory — Official Claude Code instructions and auto-memory behavior.
15. **verified** — https://learn.chatgpt.com/docs/customization/memories — Official Codex memory behavior, controls, evidence, and guidance boundary.
16. **verified** — https://docs.cursor.com/en/context/memories — Official Cursor project memories and approval model.
17. **verified** — https://github.com/pgvector/pgvector — Postgres vector search, index/filter behavior, and hybrid-search guidance.
18. **verified** — https://arxiv.org/abs/2503.03704 — MINJA query-only memory-injection attack.
19. **verified** — https://openai.com/index/inside-our-in-house-data-agent/ — Multi-source context, memory, live validation, access control, and eval precedent.
20. **verified** — https://openai.com/index/harness-engineering/ — Small knowledge map, structured system of record, progressive disclosure, and doc gardening.
21. **verified** — https://arxiv.org/abs/2502.12110 — A-MEM linked, evolving note architecture.
22. **verified** — https://github.com/vectorize-io/hindsight — MIT Hindsight implementation, clients, and disclosed benchmark positioning.
23. **verified** — https://github.com/mem0ai/mem0 — Apache-2.0 Mem0 OSS implementation and integration surface.
24. **verified** — https://github.com/promptfoo/promptfoo — MIT evaluation and adversarial-testing framework.
25. **verified** — https://github.com/Anush008/fastembed-rs — Apache-2.0 Rust-native local embedding/reranking library.
