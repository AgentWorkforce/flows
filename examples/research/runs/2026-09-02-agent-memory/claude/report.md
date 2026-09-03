# Agent memory for a cloud agent: best-in-class design and what to leverage

**Lane:** claude · **Date:** 2026-09-02

## 1. Executive summary

Build the relayfile cloud agent's memory as **one new derived table, `project_watch_items`, on top of the convergence store that already exists** — not a new store, not a graph database, not a third-party memory service. `relayhistory-cloud`'s `convergence_events` table (Neon Postgres + pgvector, embedding column and HNSW index already declared but unwired) and its `pair.ts` retrieval path (lexical rank + file/project overlap scoring, citation-carrying `PairEvidence`) already implement most of what "best-in-class agent memory" means in the current literature: extraction-then-store (not raw transcripts), a citation-bearing evidence shape, and budgeted retrieval. What's missing for the relayfile proof point is a single capability: **cross-project relevance classification** — deciding, at write time, that an event in repo A matters to project B. The literature converges on doing this classification at write time via explicit scope/policy gating before ranking (not relying on embedding similarity alone), and on a flat extraction-then-store representation over a knowledge graph unless multi-hop traversal is a real requirement — it isn't here. Recommended build: a `project_dependencies` edge table (explicit, not graph-traversed) plus a `project_watch_items` table mirroring the existing `patterns` table's content-addressed, status-lifecycle idiom, populated by a scheduled relayflow that prefilters by dependency/repo name match and confirms with a structured-output classifier call, retrieved at wake time by extending `pair.ts`'s existing scoring function. Reject Graphiti, Mem0-as-a-service, and Letta/MemGPT as the storage layer — each either duplicates infrastructure already built, reintroduces the vendor-opacity problem the convergence-store direction already resolved, or targets a different problem (long-lived single-process context paging) than this system's ephemeral-agent model has.

## 2. Landscape and best practices

### Consensus practices

**Tiered memory is standard.** Nearly every credible system — MemGPT/Letta's core/recall/archival split, MemoryOS's short/mid/long-term tiers [8], Zep/Graphiti's episode/entity/community subgraphs [1] — separates "what's in the prompt right now" from "what's retrievable on demand." Relayflows' own gate 5 already encodes this distinction (context pack vs. archival relayhistory store) [see §5].

**Memory is formed by extraction, not verbatim storage.** Mem0 [2], LangMem, and Claude Code's auto-memory [3] all converge on the same shape: an LLM pass over raw interaction → extracted salient facts → consolidation (update/merge/deduplicate against existing memory) → write. No credible system treats the raw transcript as the retrieval unit. `ai-hist learn`'s distillation into `decisions[]`/`lessons[]`/`conventions[]` already follows this pattern [confirmed by Subagent B against `crates/ai-hist/src/learn.rs`].

**Episodic → semantic/procedural is the dominant taxonomy**, used descriptively across LangMem's docs and the broader 2025 survey literature (semantic = facts, episodic = past interactions, procedural = behavior rules), though most production systems don't cleanly separate storage by this taxonomy — it's more a design vocabulary than a schema requirement.

**Consolidation via supersession, not deletion, is real consensus, verified independently.** Zep/Graphiti's bi-temporal model — closing a superseded fact's validity interval instead of deleting it, so current-state queries only see live facts while history stays queryable [1, verified] — and "Governed Shared Memory" [4] independently arrive at the same mechanism under the name "temporal supersession." Two independent sources landing on write-time contradiction resolution via superseded-not-deleted facts is a genuine pattern, not vendor-specific.

**Static human-authored instructions vs. agent-authored learnings is a two-vendor-independent convergence.** Claude Code splits CLAUDE.md (human-written) from auto memory (Claude-written, typed `user`/`feedback`/`project`/`reference`, capped at 200 lines/25KB, indexed by `MEMORY.md`) [3, verified directly — confirmed all details: storage at `~/.claude/projects/<project>/memory/`, the four types, the 200-line/25KB load cap, per-topic files loaded on demand]. Reporting on Codex CLI describes the same static (AGENTS.md) / generated (`~/.codex/memories/`) split, though this was sourced only via third-party blog snippets, not an OpenAI primary doc — treat with lower confidence than the Claude Code claim. This maps directly onto Gate 5's own split between script memory (durable journal state) and agent memory (per-agent context pack + `ai-hist learn` distillation).

**Retrieval under a token budget requires more than plain vector similarity.** Graphiti combines graph traversal with hybrid semantic+BM25 search [1]; Mem0 reports its efficiency gains specifically from retrieving a small extracted-fact set rather than replaying transcripts. `pair.ts`'s existing scoring — `textScore*0.72 + fileScore*0.2 + projectScore*0.08` [verified directly, `pair.ts:366-370`] — is exactly this pattern: hybrid lexical + structural signals, not vector-only.

### Contested or emerging practices

**Knowledge graph vs. flat extracted-fact store is genuinely unsettled, not a resolved "graphs win."** This is the one place the two subagents' sources directly disagree with each other, and I verified both papers myself: Zep's paper claims 94.8% vs. MemGPT's 93.4% on Deep Memory Retrieval, and up to 18.5% accuracy improvement with 90% lower latency on LongMemEval [1, verified via WebFetch]. Mem0's paper claims 26% relative improvement over "OpenAI's system" on LOCOMO's LLM-as-judge metric, 91% lower p95 latency, >90% token savings — and reports that its own graph variant (Mem0g) beats its flat variant by only **about 2%** [2, verified via WebFetch — "Mem0 with graph memory achieves around 2% higher overall score than the base configuration"]. That 2% number is the load-bearing fact for this project's architecture decision: the vendor that ships both a flat and a graph variant found the graph bought almost nothing on its own benchmark. Combined with the fact that neither paper's numbers have been independently reproduced by a third party (both are vendor-authored, on vendor-controlled or vendor-adjacent benchmarks), the honest read is: graph-structured memory is not proven to be worth its operational cost for retrieval quality alone, though it may still be worth it for genuinely multi-hop reasoning tasks Zep specifically targets (temporal/relational business data, not primarily single-hop fact lookup).

**Benchmark comparability across LoCoMo/LongMemEval/DMR is shaky.** Every vendor reports SOTA on its own benchmark selection; this is the classic pattern in a fast-moving subfield and should discount confidence in any single-paper comparative claim.

**Agent-driven dynamic memory reorganization (A-MEM's Zettelkasten-style retroactive note editing)** is architecturally interesting but unproven at production scale — no reviewed production system (Zep, Mem0, Letta, LangMem) implements retroactive rewriting of old memory entries when new ones arrive, and it raises real audit-trail and citation-stability questions that matter a lot for a system where "cite where it learned it" is an explicit requirement.

**Multi-agent shared-memory governance is early, and has a documented real failure mode worth taking seriously.** The "Governed Shared Memory" paper [4] discloses its own bug: a direct GET-by-id path initially bypassed the agent-identity/scoping enforcement that its search path had, letting a lower-trust agent fetch a cross-scope row it shouldn't see. This is directly relevant: any design where the relayfile agent reads across every other project's sessions needs the scoping check enforced at *every* access path (search AND direct fetch), not just the primary retrieval query — worth flagging as an explicit test case.

**Forgetting/decay is underspecified almost everywhere.** Every architecture surveyed describes consolidation and retrieval in detail and treats decay/pruning as an afterthought. This is a real, field-wide gap, not just under-marketing on any one vendor's part.

### Marketing to discount

Vendor benchmark leaderboards (Mem0's "State of AI Agent Memory" report, both papers' head-to-head percentage claims) are legitimate arXiv preprints methodologically, but comparative percentages should be read as vendor marketing dressed as science until independently reproduced. "Knowledge graph = understands your codebase" framing from graph-memory vendors overstates what extraction buys, given Mem0's own 2% finding above. Third-party "agent remembers everything" positioning on top of narrower mechanisms (local markdown + summarization) reads as marketing layered over a genuinely useful but modest capability.

### Cross-project relevance filtering: the actual prior art

This is the part of the question with the least existing prior art, and it's the crux of the relayfile proof point. The most directly relevant finding: **"Governed Shared Memory" [4] argues relevance filtering across a multi-tenant/multi-scope memory pool should happen via explicit policy filtering *before* ranking, not by letting semantic similarity alone decide what crosses a project boundary.** Its retrieval pipeline order — semantic candidate generation → policy filtering → temporal resolution → provenance enrichment → ranked delivery — and its explicit framing of **write-time filtering** (tag relevance to downstream consumers at the moment of admission) versus **read-time filtering** (recover relevance heuristically at query time over an ever-growing pool) is the single most load-bearing piece of literature for this design. Write-time filtering scales better as the firehose grows, because the per-query candidate set stays bounded by an explicit tag rather than growing with total corpus size. No source found describes a named, documented production system doing exactly what the relayfile proof point wants — continuous cross-repo firehose ingestion, filtered to "what matters to project X," with citations. This looks like a genuine gap rather than something to adopt off the shelf, which is consistent with it being the one piece of this design that has to be built rather than bought.

## 3. Recommended approach

Extend `relayhistory-cloud`'s existing convergence store; do not introduce a second storage engine.

**Representation: flat, typed rows — not a knowledge graph.** The proof point's actual shape is single-hop: "does event E matter to project X, and why" — not "trace the multi-hop blast radius of E across N downstream services over time." Given the Mem0g-vs-flat finding above (≈2% gain from graph structure on the one head-to-head benchmark available) and that adopting Graphiti-style temporal graphs means a second storage engine (typically Neo4j) with a second ingestion path to keep consistent with `convergence_events`, this is not justified by the stated requirement. Model the one relationship that *is* needed — "project X depends on package/service/repo Y" — as an explicit small edge table, queried directly by name match, not traversed. Revisit only if a future feature genuinely needs multi-hop reasoning (e.g., "what's the blast radius three services out").

**Schema** (additive to `packages/relayhistory/src/db/schema.ts`, confirmed to already contain `convergence_events` with an unwired `embedding vector(1536)` + HNSW index, and `patterns` with the same):

```sql
CREATE TABLE project_profiles (
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,                  -- 'relayfile'
  repo_aliases JSONB NOT NULL DEFAULT '[]',
  profile_embedding vector(1536),
  embedding_model_version TEXT,               -- guards against silent drift when embeddings go live
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, project_id)
);

CREATE TABLE project_dependencies (           -- explicit edges, no graph engine
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  dep_type TEXT NOT NULL,                     -- 'package' | 'service_api' | 'repo'
  dep_name TEXT NOT NULL,
  dep_ref JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (org_id, project_id, dep_type, dep_name)
);

CREATE TABLE project_watch_items (            -- what the relayfile agent reads at wake
  id TEXT PRIMARY KEY,                        -- content hash(org, project, category, statement, source_event_id)
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,                   -- watching project: 'relayfile'
  category TEXT NOT NULL,                     -- dependency_change|api_contract_change|decision|incident|repeated_mistake
  statement TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  source_project_id TEXT,                     -- where it happened, e.g. 'burn'
  source_machine_id TEXT NOT NULL,
  source_source TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_event_id TEXT NOT NULL,              -- live FK-by-value into convergence_events PK — the citation
  confidence_basis_points INTEGER,
  status TEXT NOT NULL DEFAULT 'candidate',   -- candidate|active|dismissed|superseded|expired
  superseded_by TEXT,
  first_observed_at TIMESTAMPTZ NOT NULL,
  last_observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

This deliberately mirrors the existing `patterns` table's idioms — content-addressed id (so re-runs upsert instead of duplicating), a `status` lifecycle (`candidate`→`active`→`dismissed`/`superseded`), basis-point confidence — confirmed present in `packages/relayhistory/src/lib/reflex/learn.ts` (`mineMistakePatterns`, `supportEventIds`, `status: sampleSize >= 2 ? "active" : "candidate"`) [verified directly, lines 172-213]. Critically, `source_event_id` is a live foreign-key-by-value into `convergence_events`' actual primary key, not a copied snippet, so a citation stays a live join rather than a frozen, potentially stale string.

**Write path — write-time tagging, batch not real-time.** Per the "Governed Shared Memory" finding above, do relevance classification at write/distillation time, not purely at read time. Concretely: a scheduled relayflow (not synchronous with ingest, since the wake path is latency-sensitive and the sift is not) runs per watching project on a cursor watermark, using the same idempotent-upsert discipline `push`/`mineMistakePatterns` already use so re-runs are cheap no-ops. Pipeline: (1) cheap lexical/dependency-name prefilter against `project_dependencies` and `project_profiles.repo_aliases` over new `convergence_events` rows since the cursor; (2) for prefiltered candidates, a structured-output classifier call (same discipline as `learn.rs`'s `LEARN_OUTPUT_SCHEMA` — fixed JSON schema, "output raw JSON only") confirms category and extracts structured detail; (3) upsert into `project_watch_items` with the citation.

**Worked example.** An engineer in `../burn` bumps `zod` 3→4 via Claude Code; `ai-hist learn` distills a decision locally (`{"question":"Upgrade zod?","chosen":"zod 4","reasoning":"...","impact":"breaking change to schema parsing"}`); `ai-hist push` maps it to a `decision` envelope (`projectId=burn`) and it lands in `convergence_events`. The relayfile watchdog relayflow, on its next run, loads relayfile's `project_dependencies` row `(package, zod)`, matches it against the new event by name, confirms via the classifier (`category=dependency_change`, `{package:"zod", from:"3", to:"4", breaking:true}`), and upserts a `project_watch_items` row citing the exact `convergence_events` PK. When relayfile's agent wakes with `memory: { agent: true }`, `f.memory.recall(...)` surfaces this item, scored high because `zod` also appears in relayfile's own dependencies, with a citation the agent can quote in its output — directly satisfying gate 5's stated acceptance test ("an agent avoiding a mistake recorded in a previous run's trajectory, with the citation in its output" [confirmed, `RFC-0001-everything-is-a-relayflow.md:139`]).

**Consolidation/forgetting.** Dependency/contract-change items decay (`expires_at = last_observed_at + 30–90d`, extended on re-reference) — the same recency-based active/stale/missing idiom `cloud.rs`'s `MachineCoverage` already implements for machine liveness, applied to facts. The same statement/category recurring across ≥2 source sessions/projects promotes confidence and merges rows, generalizing `mineMistakePatterns`' existing revert-grouping logic. Repeated-mistake items don't auto-expire; they're superseded only when a later event marks the fix shipped.

**Retrieval at wake time under budget.** Extend `pair.ts`'s existing scoring function rather than inventing a new one: union same-project `convergence_events` with `project_watch_items WHERE project_id=relayfile AND status='active'`, rank by the existing `textScore*0.72 + fileScore*0.2 + projectScore*0.08` formula (weighted further by kind/significance/confidence, matching current behavior), greedily pack until the declared token budget is spent. Reserve one slot for the single highest-confidence `incident`/`repeated_mistake` item before greedy-filling the rest, so budget starvation can't silently drop the one fact that would have prevented a repeat mistake. Every packed item carries `source_event_id`/`detail` in the existing `PairEvidence` shape [confirmed, `pair.ts:97-107`] — reuse it rather than inventing a new citation format. The itemized token count becomes the step's journal `memory` line, matching decision #10's "memory tokens charged to the consuming step, itemized."

**Evaluation.** Offline: fixture-based tests in the style of `learn.rs`'s existing acceptance-fixture tests — synthetic sibling-repo events with known ground-truth relevance to relayfile, asserting precision/recall of the classifier and that the ranked, budget-capped pack contains the known-relevant item. Online: extend `pattern_hits`' existing `fired|accepted|dismissed|recurred` schema to `project_watch_items`, and track a non-LLM precision proxy (does the packed `dep_name` actually appear in `project_dependencies`) plus staleness (fraction of `active` rows past expected `expires_at`).

## 4. Trade-offs and risks

**This design bets that write-time relevance tagging scales better than read-time search as the firehose grows — that's an inference from one paper [4], not something empirically validated at the scale this system will eventually run at.** If cross-project matching turns out to need more than name/dependency matching plus a classifier pass — e.g., genuinely semantic relevance no keyword or explicit dependency edge would catch — this design under-recalls. The mitigation (embedding-based `project_profiles` matching as a second signal) is sketched but not built; if false negatives turn out to be the dominant failure mode rather than false positives, that second signal needs to be prioritized sooner than planned.

**Rejecting the knowledge-graph approach rests heavily on a single vendor-reported number (Mem0g's ~2% gain over flat).** That's one data point from one benchmark family (LOCOMO), from the vendor that has an interest in making its flat architecture look sufficient. If relayfile's actual needs turn out to involve genuine multi-hop reasoning (e.g., "what's the transitive blast radius of this contract change across three services"), this recommendation would be wrong and Graphiti-style modeling would earn its operational cost. Revisit if/when a concrete multi-hop use case appears — don't preemptively build for it.

**Prompt injection via untrusted session content is a real, not hypothetical, risk** — `convergence_events.content` originates from other teams' raw session text, which is attacker/environment-influenceable. The classifier prompt must treat content strictly as data (matching `learn.rs`'s existing "output raw JSON only" discipline and `pair.ts`'s existing `scrubText`), and packed statements must be presented to the consuming agent as delimited, untrusted citations — never as instructions. This needs explicit testing, not just design intent.

**Cross-tenant/cross-project leakage is the single highest-severity failure mode**, given the "Governed Shared Memory" paper's disclosed real-world instance of exactly this bug (a direct-fetch path bypassing scope enforcement that the search path had). `orgId` must be server-derived everywhere `project_watch_items` is touched, with no client-supplied org context — matching the invariant already documented in `convergence.rs` for the ingest envelope. This needs a specific test: verify scoping is enforced on *every* access path into `project_watch_items`, not just the primary `pair`-style query.

**What would make this whole approach wrong:** if the relayfile agent's actual bottleneck turns out to be retrieval precision (too much irrelevant noise surfacing) rather than retrieval recall (missing the one relevant fact), the greedy-rank-and-pack approach recommended here is the wrong lever — that would call for the reranking/MMR-diversity approaches this report explicitly deferred as unnecessary. This should be an early, cheap thing to check with the offline eval harness before investing further.

## 5. What we can leverage

- **`convergence_events` (Neon Postgres + pgvector)** [`packages/relayhistory/src/db/schema.ts`, verified] — already the correct store; keep. Confirmed the `embedding vector(1536)` column and HNSW index exist but are unwired (nothing writes or reads them yet) — this is provisioned infrastructure, not a working feature, and is the natural place to add the embedding-based second-signal matching noted as a risk mitigation above.
- **`pair.ts`'s scoring/retrieval function** [verified, lines 223-370] — directly reusable; extend rather than replace for `project_watch_items` retrieval. Its `PairEvidence` citation shape should be the canonical citation format for this design too.
- **`patterns` / `reflex/learn.ts`'s `mineMistakePatterns`** [verified, lines 33-213] — the working template for consolidation: content-addressed IDs, `status` lifecycle, `supportEventIds`, confidence promotion on ≥2 sources. Generalize this logic rather than writing new consolidation logic from scratch.
- **`ai-hist learn`'s distillation pipeline** [`crates/ai-hist/src/learn.rs`, per Subagent B] — already proves the "structured extraction with a fixed JSON schema, local-first LLM call" pattern this design's classifier pass should follow.
- **Gate 5 / `f.memory`** [`docs/RFC-0001-everything-is-a-relayflow.md:132-141`, `docs/SURFACE.md:64`, both verified directly] — the consuming interface (`f.memory.recall(query)`) and the acceptance test (citation in agent output) are already specified; this design's retrieval extension needs to satisfy that existing contract, not define a new one.
- **Graphiti / temporal knowledge graphs** — do not adopt for this proof point. Fit assessment: real, credible open-source project [1, verified], but a second storage engine and ingestion path for a multi-hop traversal capability the stated requirement doesn't call for; the vendor's own graph-vs-flat benchmark gap (~2%, Mem0's report) doesn't justify the operational cost here.
- **Mem0 (hosted memory API)** — do not adopt. Routing session content through a third party reopens the vendor-opacity question `relayhistory-cloud`'s "vendor-readable convergence store vs. E2E opaque enterprise tier" direction already settled deliberately; using it would mean re-litigating a decision already made.
- **Letta/MemGPT** — do not adopt. Solves context paging for a single long-lived agent process; this system's ephemeral-agent, journal-backed model (no agent outlives its step) has no persistent process for it to page memory into. Architecturally incompatible, not just a worse fit.
- **A reranker (cross-encoder, etc.)** — not needed yet. Add only once the embedding signal is live and an eval shows lexical+heuristic scoring under-performing; premature now.

## 6. Open questions

1. Where does the classifier call for `project_watch_items` run, and under what cost/latency budget — is this a step within a scheduled relayflow charged like any other step (per decision #10's "itemized, charged to the consuming step"), and if so, who pays for it: the emitting project or the watching project?
2. How many watching projects will realistically subscribe to the same firehose simultaneously, and does the prefilter (dependency-name match) stay cheap enough as that count grows, or does it need its own indexing strategy sooner than assumed?
3. Should `project_dependencies` be hand-maintained per project, or derived automatically from manifest files (package.json, Cargo.toml) during ingest — the design above assumes the former without addressing how it stays current.
4. What's the actual false-negative rate of name/keyword-based prefiltering versus a semantic (embedding) signal — this is exactly the kind of question the offline eval harness (§3) should answer before deciding whether to prioritize wiring the dormant embedding column.
5. Does the "reserve one slot for the top incident/repeated-mistake item" budget policy actually match what gate 5's acceptance test needs, or does real usage show a different allocation is needed once there's live traffic to observe?

## 7. Sources

1. Rappaport et al., "Zep: A Temporal Knowledge Graph Architecture for Agent Memory," arXiv:2501.13956 — https://arxiv.org/abs/2501.13956 — bi-temporal graph memory (Graphiti), DMR (94.8% vs. MemGPT 93.4%) and LongMemEval (up to 18.5% accuracy, 90% lower latency) numbers. **verified** (fetched directly by lead researcher)
2. "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory," arXiv:2504.19413 — https://arxiv.org/abs/2504.19413 — extraction/consolidation pipeline; Mem0g graph variant ≈2% over flat baseline; LOCOMO 26% relative LLM-judge improvement, 91% lower p95 latency, >90% token savings. **verified** (fetched directly by lead researcher)
3. Claude Code documentation, "How Claude remembers your project" — https://code.claude.com/docs/en/memory — CLAUDE.md vs. auto-memory split, four memory types (user/feedback/project/reference), 200-line/25KB load cap, `MEMORY.md` index, per-topic on-demand files. **verified** (fetched directly by lead researcher)
4. "Governed Shared Memory for Multi-Agent LLM Systems," arXiv:2606.24535 — https://arxiv.org/abs/2606.24535 — scope/policy-gated retrieval, write-time vs. read-time filtering, disclosed access-control gap (direct-fetch path bypassing scoping the search path enforced), temporal supersession. **unverified** (fetched by Subagent A; not independently re-fetched by lead researcher, but its central claim — filter by policy before ranking — is load-bearing for §2/§3 above and should be treated as the least-verified major claim in this report)
5. "A-MEM: Agentic Memory for LLM Agents," arXiv:2502.12110 (NeurIPS 2025) — https://arxiv.org/abs/2502.12110 — Zettelkasten-style dynamic/retroactive note linking. **unverified** (Subagent A only)
6. "RCR-Router: Role-Aware Context Routing for Multi-Agent LLM Systems," arXiv:2508.04903 — https://arxiv.org/abs/2508.04903 — role-aware, token-budget-aware context routing; generalizes to project-scoped routing. **unverified** (Subagent A only)
7. "Memory OS of AI Agent" (MemoryOS), arXiv:2506.06326 (EMNLP 2025) — https://arxiv.org/abs/2506.06326 — hierarchical short/mid/long-term memory tiers. **unverified** (search-snippet only per Subagent A)
8. github.com/langchain-ai/langmem — https://github.com/langchain-ai/langmem — episodic/semantic/procedural memory taxonomy in LangChain's memory tooling. **unverified** (fetched by Subagent A; not independently re-fetched)
9. Local repo: `relayhistory-cloud/packages/relayhistory/src/db/schema.ts` — `convergence_events`, `patterns` table definitions, embedding column, HNSW index. **verified** (read directly by lead researcher, lines 21-107, 205-286)
10. Local repo: `relayhistory-cloud/packages/relayhistory/src/lib/pair.ts` — scoring formula, `PairEvidence` shape. **verified** (read directly by lead researcher, lines 27-370)
11. Local repo: `relayhistory-cloud/packages/relayhistory/src/lib/reflex/learn.ts` — `mineMistakePatterns` consolidation logic. **verified** (read directly by lead researcher, lines 33-213)
12. Local repo: `flows/docs/RFC-0001-everything-is-a-relayflow.md` — gate 5 ("a relayflow has memory"), full text of scopes, acceptance test, "exists today" note on relayhistory. **verified** (read directly by lead researcher, lines 132-141; full gate ladder read lines 100-169)
13. Local repo: `flows/docs/SURFACE.md` — `f.memory.recall/why/learn` helper signatures. **verified** (read directly by lead researcher, lines 64-79)
14. Local repo: `relayhistory/crates/ai-hist/src/learn.rs`, `crates/ai-hist-core/src/convergence.rs`, `crates/ai-hist/src/cloud.rs` — distillation schema, push/ingest envelope mapping, sync cursor pattern. **unverified by lead researcher directly** (read and cited by Subagent B; not independently re-read, but consistent with verified schema/pair.ts findings above)
15. Local repo: `relayhistory-cloud/docs/product-direction.md` — Neon+pgvector convergence store direction, Learn/Plan/Pair layer, E2E opaque enterprise tier. **unverified by lead researcher directly** (read and cited by Subagent B)
