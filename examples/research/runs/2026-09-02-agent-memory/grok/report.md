# Agent memory for a cloud agent: best-in-class design and what to leverage

Lane: grok. Date: 2026-09-02.

Two subagents (Landscape, Applied) ran in parallel. This report merges them after parent spot-checks of local code and primary sources. Disagreements resolved in §3; dropped claims in §4 and §6.

## 1. Executive summary

Do not buy a memory SaaS and do not stand up Neo4j. Best-in-class for a **relayfile-scoped cloud agent** is a sleep-time relayflow over the store we already specified: lossless episodic events in Neon, derived temporal claims with citations and validity windows, procedural patterns for Pair, and a token-budgeted wake pack charged to the consuming step.

That is Gate 5: history is the journal; context is a view assembled per wake. Coding-agent vendors converged on a small always-on core (CLAUDE.md / AGENTS.md) plus retrieval, not a hosted KG. What transfers: Graphiti’s *schema* (bi-temporal facts, invalidate-don’t-delete), LongMemEval’s index/retrieve/read split, LangMem’s hot-path vs background split, and sleep-time compute — as a resident relayflow, not those products.

The proof is blocked by five existing gaps, not by missing vendors: (1) `convergence_events.embedding` is schema-only and never written; (2) history→prompt mapping sets `project_id: None`; (3) the outbox never emits `filesTouched` or `session_outcome`; (4) Learn mines only reverted commits; (5) `f.memory` exists in SURFACE.md, not in the kernel or SDK. Fix those, add a `neighborhood_claims` table and `POST /v1/memory/pack`, and the relayfile agent can cite what it learned.

## 2. Landscape and best practices

This is **not** LoCoMo/LongMemEval chat personalization. It is cross-corpus, project-scoped, temporal, cited retrieval over coding-agent traces, with sleep-time consolidation. Chat-memory leaderboards are the wrong gate.

### Canonical older work

RAG named provenance as an open problem [1]. ReAct: retrieve, don’t stuff [2]. Reflexion: verbal reflections in an episodic buffer (91% HumanEval pass@1 vs GPT-4 80% in-paper) [3]. Generative Agents is still the copied architecture: log → reflect → retrieve → plan [4]. MemGPT/Letta: small in-context core paged against archival storage [5]. Lost in the Middle: dumping a journal fails — U-shaped attention [6]. ExpeL distills insights from a collection of experiences — closest canonical analog of `ai-hist learn` [7]. Voyager’s skill library is the procedural analog of “how we do X in this repo” [8]. RFC-0001 Gate 4 already states the implication: history is the journal; context is a view assembled per wake [9].

### Last ~18 months

**Evaluation.** LoCoMo (ACL 2024) is very long *dialogue* (~300 turns, up to 35 sessions) [10]. LongMemEval (ICLR 2025) is more useful: five abilities — extraction, multi-session reasoning, temporal reasoning, **knowledge updates**, **abstention** — plus an index/retrieve/read recipe (session decomposition, fact-augmented keys, time-aware query expansion) [11]. MemoryAgentBench adds selective forgetting as a competency almost nobody masters [12]. Zep’s own paper dismantles MemGPT’s Deep Memory Retrieval: modern windows already score ~98% full-context on DMR, so the “SOTA vs MemGPT” gap is not a product argument [13].

**Graph / temporal.** Graphiti (Zep, Jan 2025) is the most important *architecture* paper for this proof: episodes (raw, non-lossy) → semantic entities/facts with bi-temporal `t_valid`/`t_invalid` → communities; new facts invalidate old edges rather than deleting them; hybrid cosine + BM25 + BFS; constructor emits dated facts with provenance [13][14]. Official backends are Neo4j, FalkorDB, or Amazon Neptune — not Postgres [14]. HippoRAG (NeurIPS 2024) is KG + Personalized PageRank for multi-hop QA; accretion, no invalidation [15]. GraphRAG is batch/static corpora [16].

**Extract-and-update.** Mem0’s 2025 paper extracts facts and ADD/UPDATE/DELETEs on conflict (LoCoMo LLM-as-judge gains; 91% lower p95 vs full-context) [17]. The April 2026 README *reverses* that: “Single-pass ADD-only… Memories accumulate; nothing is overwritten.” Platform LoCoMo 92.5 / LongMemEval 94.4 are “proprietary optimizations not available in the open-source SDK” [18]. A-MEM is Zettelkasten notes that link and evolve [19]. LightMem decouples sleep-time LTM from online inference [20]. Sleep-time Compute (Letta + Berkeley) is the justification for a sifting agent **not** on the coding-step hot path: ~5× less test-time compute; SWE case study [21].

**Coding-agent practice (official docs).** Claude Code: you write CLAUDE.md (target <200 lines; org → user → project → local); Claude writes auto memory under `~/.claude/projects/<git-repo>/memory/`; first 200 lines or 25KB of `MEMORY.md` load every session; machine-local, not team-shared [22]. Codex: AGENTS.md is the team layer; generated memories under `~/.codex/memories/` are off by default, treated as generated state [23]. Cursor’s documented persistence is Rules and AGENTS.md; “Memories” as a team product was not confirmed from Cursor’s own settings page (`unverified`) [24].

### Consensus / contested / marketing

**Consensus** (multiple independent primary sources): (a) history ≠ context; (b) typed memory — at least episodic / semantic / procedural; (c) retrieve under a budget; (d) hybrid lexical + dense beats embedding-only; (e) distill, then retrieve — don’t RAG raw transcripts as the only memory; (f) provenance is load-bearing if you will cite; (g) knowledge updates must invalidate, not only append; (h) sleep-time / background consolidation is how a non-session system continuously sifts; (i) coding-agent vendors share procedure via git markdown, not a hosted KG.

**Contested:** full temporal KG vs typed facts vs Zettelkasten vs trees; write-time LLM extraction vs cheap lexical ingest; UPDATE/DELETE vs accumulate-only (Mem0 paper vs Mem0 2026 README); always-on core vs fully retrieved; whether LoCoMo/LongMemEval predict coding-agent memory quality (they don’t, structurally).

**Marketing:** SuperMemory “#1 on every major benchmark” (not reproduced here); Mem0 platform scores with the OSS-will-not-match footnote [18]; Zep “SOTA vs MemGPT” on DMR, which their own paper then dismantles [13]; any vendor number **without a token budget**. A 2026 budgeted-eval paper is reported (search snippet only, **unverified PDF**) to show Graphiti’s lead vanishing at ~30k characters [25]. Direction matches Lost in the Middle [6] and RFC decision 10 [9]; we do not treat those numbers as reproduced.

## 3. Recommended approach

**One sentence.** A relayfile cloud agent is a sleep-time relayflow that reads `convergence_events`, writes temporal cited claims into Neon (invalidating superseded ones), and at wake returns a budgeted pack: live neighborhood facts + task-retrieved episodes + Pair warnings, each with `event_id` citations, charged to the step.

Lane disagreement resolved here: Landscape wanted L1 facts in the existing `patterns` table; Applied wanted a new `neighborhood_claims` table. **New table.** `patterns.kind` is `skill | rule | footgun | mistake | playbook | hotspot` [26] — procedural Learn output. Neighborhood facts need `valid_from` / `invalid_at`, `source_project` → `subject_project`, and entity lists. Overloading `patterns` would mix tiers and break Pair’s kind weights. Second disagreement: Landscape treated a graph as optional-later; Applied wanted a light `neighborhood_edges` table in the first slice. **Include the edges table.** The proof is “sibling API change impacts relayfile,” which is a relation. Recursive CTE / 1-hop SQL, not Cypher.

### 3.1 Layers

| Tier | Type | Store | Role |
|---|---|---|---|
| 0 | Working | assembled at wake | budgeted pack + citations; never source of truth |
| 1 | Episodic | `convergence_events` (exists) | lossless, org-scoped, never rewritten |
| 2 | Semantic (neighborhood) | **new** `neighborhood_claims` + `neighborhood_edges` | what is true *for relayfile now*; validity windows; cited |
| 3 | Procedural | `patterns` (exists) | skills, footguns, mistakes; Pair-consumable |
| 4 | Script | kernel journal + epoch summaries | Gate 5 script memory; later |

This matches LangMem’s taxonomy [27], Graphiti’s episode/semantic split [13], Claude/Codex small-core practice [22][23], and RFC Gate 4/5 [9].

### 3.2 What exists today (grounded)

**Relayflows.** Gate 5 specifies script vs agent memory, `ai-hist pack` / `why_for_task` / `learn` / `pair`, and the done-when: an agent avoids a previously recorded mistake **with a citation** [9]. SURFACE.md names `f.memory.recall(query)`, `f.memory.why(task)`, `f.memory.learn(finding)` [28]. Kernel `DESIGN.md` explicitly lists “memory verbs (gate 5)” as **not in v0** [29]. No `memory:` field on the SDK spec was found.

**Local ai-hist.** SQLite WAL + FTS5. Tables: `history`, `session_events`, `tool_calls`, `file_edits`, `session_commit_links`, `trajectories`, `tags` (`crates/ai-hist-core/src/lib.rs`). MCP: `search_history`, `get_context`, `search_trajectories`, `why_for_task`, `pack_evidence`, `pair_check` [30][31]. `ai-hist pack` is FTS over **history prompts**, truncating each prompt to `tokens*4` chars — it does not pack trajectories (`pack_entries` in `crates/ai-hist/src/lib.rs`). `ai-hist learn distill` LLM-compacts a session into decisions/conventions/lessons (`crates/ai-hist/src/learn.rs`). TS SDK `whyForTask` is `searchTrajectories(query, {limit:1})` via LIKE, because sql.js WASM has no FTS5 [32].

**Cloud mapping gaps (verified in code):**

- `map_history_entry` sets `project_id: None` even though local `history.project` is a path (`crates/ai-hist-core/src/convergence.rs` lines 142–162).
- Grep of `crates/` found **no** `filesTouched` / `session_outcome` emission. Cloud ingest *accepts* `session_outcome` (`lib/ingest.ts`); the client outbox does not emit it. Outbox cursors are `history.id` + `trajectories.rowid`; updated trajectory rows are not re-pushed (`outbox.rs` lines 9–12).
- `ingest.ts` never writes `embedding`. Pair v1 is lexical (`ilike` + `ts_rank_cd`); agent-integration.md says vector retrieval is “a future upgrade once embeddings are populated” [33][34].
- Pair’s project filter, when `projectId` is set, **includes NULL and empty `project_id`** (`lib/pair.ts` ~200–207) — so unscoped prompts leak into a “scoped” search.
- Learn engine `mineMistakePatterns` only reads `session_outcomes.reverted = true` and upserts `kind='mistake'` [35]. Nightly cron shape already exists (`POST /v1/internal/reflex/learn`, `scripts/register-reflex-learn-schedule.mjs`).
- `pattern_hits` is schema-only; Pair does not write it.

**Relayfile prior art (draft, unimplemented).** `docs/knowledge-graph-spec.md` (2026-03-12): typed knowledge, cascade invalidation, “graph as metadata, not a second store,” no SPARQL/Cypher [36]. `docs/knowledge-extraction-spec.md` (2026-03-27): path-scoped annotations, TTL, broker-time injection, **no embeddings in v1**, trajectories as the full record [37]. Vocabulary is right; tables are not shipped.

### 3.3 Ingestion and “what matters to relayfile”

Do not re-parse raw JSONL in the cloud. Product-direction: don’t rebuild capture [38]. Consume already-distilled `decision | finding | reflection` events, plus (once the mapper is fixed) `session_outcomes` and `filesTouched`.

**Deterministic first, LLM second.**

1. **Watchlist** (versioned in the flow spec): self aliases (`relayfile`, `relayfile-cloud`, `file.agentrelay.com`, `@relayfile/`, `packages/relayfile`, `cmd/relayfile`) and siblings (`relayauth`, `relaycast`, `burn`, `burn-cloud`, `relayhistory`, `relayhistory-cloud`, `sandbox-router`, `cloud`). Contract tokens: `EventFrameV1`, writeback/mount/adapter, relayauth path scopes, `rth_at_` / `brn_at_`.
2. **Lexical prefilter** on `content`, `task_title`, `project_id`, `files_touched`, `tags`. Same tools Pair already uses.
3. **Relevance gate:** self alias **or** (sibling match **and** (self alias in content **or** impact verbs: break, depend, adapter, contract, API, mount, writeback)) **or** `files_touched` intersects relayfile globs.
4. **One bounded LLM extract per gated batch**, not per line. Schema: `{kind, statement, body, source_project, subject_project, entities, impact, confidence, valid_from, supersedes_claim_id, evidence[]}`. `kind ∈ dependency_change | api_contract | sibling_decision | incident | repeated_mistake`. Fail closed on invalid JSON — same discipline as a failed journal write.

This is ExpeL + LightMem sleep-time + Sleep-time Compute [7][20][21], as a Gate 2+5 relayflow, not a daemon. Letta-as-runtime contradicts Gate 4 (“no agent outlives its step”) [9].

### 3.4 Storage

Reuse `convergence_events`, `patterns`, `session_outcomes`, `pattern_hits`. Add one migration:

```sql
-- neighborhood_claims: content-addressed id =
-- sha256(org, subject_project, kind, normalized statement)
-- status: candidate | active | superseded | expired | dismissed
-- valid_from / invalid_at: Graphiti-lite; never delete
-- support_event_ids: same natural-key shape as patterns
-- embedding vector(1536) + HNSW WHERE embedding IS NOT NULL

-- neighborhood_edges: (src_project, dst_project, relation, claim_id)
-- relation: impacts | depends_on | broke | supersedes

-- project_aliases: (org_id, alias) → canonical + kind self|sibling|contract
```

Tenancy stays server-derived from auth (`orgId`), never from the client payload [39]. Kernel stays tenant-unaware (RFC decision 15) [9].

Populate the **existing** `vector(1536)` columns at ingest with `text-embedding-3-small` (matches the declared dimension). Charge embed tokens to the miner or pack step.

### 3.5 Retrieval at wake (token budget)

New `POST /v1/memory/pack` (`rth:read`). This *is* WS-5 Plan, specialized [38].

Request: `{ subjectProject, task, files, budgetTokens, scopes: [claims, patterns, episodic] }`.

Assemble until budget is exhausted (Lost in the Middle: load-bearing bits at the **edges** of the pack [6]):

1. **Front — live claims** for `subject_project=relayfile`, `status=active`, `invalid_at IS NULL`. Hybrid: `ts_rank_cd` (already in Pair) + cosine once embeddings exist + recency (`last_confirmed_at`) + confidence + 1-hop `impacts` edges.
2. **Front — procedural** `patterns` (`project_id` in {relayfile, null}, `status=active`). Keep Pair’s kind weights (`reflection:suggestion`/`lesson` 1.08, `decision` 1.05; drop `:summary`/`:approach`) [33].
3. **Middle — episodic WHY**, top-k `decision|finding|reflection`, excluding narrative suffixes. Cloud `why_for_task`, not `LIKE LIMIT 1`.
4. **Do not** dump `kind=prompt` into the wake pack. Prompts are HOW; follow-up `recall` can spend leftover budget.

Every item carries Pair’s evidence key: `{ machineId, source, sessionId, kind, eventId, ts, snippet }` [40]. **No citation → item does not ship.** That makes Gate 5’s done-when structural.

Hard cap from `memory.budget` on the step. Overflow is a journaled `memory_truncated` count — never Claude’s silent 200-line drop [22]. RFC decision 10: memory tokens charged to the consuming step, itemized [9]. Until kernel memory verbs exist, the SDK journals usage on `step.complete` as an honest incomplete.

Claude’s 200-line/25KB and Codex’s generated-summary cap are existence proofs that **small always-on cores work for coding agents** [22][23]. Steal the cap, not the silence.

Mid-session: existing `pair_check` (advisory, fail-open) [40], extended to search `neighborhood_claims` and `patterns` with the same ranker.

### 3.6 Write path, consolidation, forgetting

| When | Who | Where |
|---|---|---|
| Continuously | `ai-hist push` | `convergence_events` |
| After a session | `ai-hist learn distill` | local `trajectories` → next push `lens=learn` |
| After ingest / cron | NeighborhoodMiner | `neighborhood_claims` / `_edges` |
| Pair fire / dismiss | Pair + UI | `pattern_hits` (`fired\|accepted\|dismissed\|recurred`) |
| Commit/revert | **to build:** push `session_commit_links` | `session_outcomes` → existing mistake miner |

Upsert by content-addressed id (copy `patterns.id` hashing in `learn.ts`). Re-observation grows `support_event_ids` (cap 200) and bumps `last_confirmed_at`. Contradiction: new claim with `supersedes_claim_id`, old `status=superseded`, `invalid_at=now()`. That is Graphiti fact succession without Graphiti [13][14].

Do not delete episodic events (RFC decision 8) [9]. Forgetting applies only to derived tiers: TTL → `expired`; dismissed hits → dismiss; `recurred` re-surfaces (Gate 5 “never twice”). Near-duplicate merge is a journaled sleep-time job, never a silent rewrite of `convergence_events`. Distilled memory may *propose* CLAUDE.md diffs; Gate 9 human/Garden approval required [9].

### 3.7 Evaluation

Do not use LoCoMo as the Gate 5 eval. Build a **relayfile neighborhood gold set** (~30 questions):

- Positive: writeback/lease incident, relayauth path-scope change affecting adapters, repeated permissions mistake. Must cite `eventId`.
- Negative: a `nightcto` session that never mentions relayfile must not appear.

Harness: (1) deterministic retrieval tests with fixtures — no LLM; (2) behavioral: pack vs no-pack, output contains the citation natural key (RFC done-when); (3) mutation-verify the relevance gate per Agents.md (revert, capture miss, restore, capture hit — paste both). Vendor LongMemEval numbers we did not run are not claimed.

### 3.8 First build slice

1. Mapper: `project_id` from `history.project` / git remote; `filesTouched` from `file_edits`; `session_outcome` outbox; `updated_ms` watermark for trajectory re-push.
2. Embed on ingest (`vector(1536)`).
3. `project_aliases` + `neighborhood_claims` / `_edges` + miner cron cloned from `/internal/reflex/learn`.
4. `POST /v1/memory/pack` with budget + mandatory citations; lexical now, vector as soon as embeddings exist.
5. ~20-question gold file; pack test fails if a known incident is missing.
6. SDK `f.memory.recall/why/learn` compiling to that API; kernel memory line later — don’t block the proof on `relayflowd` verbs.

## 4. Trade-offs and risks

**This is wrong if:** (a) most cloud rows are raw `kind=prompt` with no distill coverage — then the miner has no WHY and will either go silent or LLM-extract transcripts (secret-heavy, expensive); (b) the sibling watchlist is incomplete — silent false negatives, the failure mode the gold set’s negatives won’t catch; (c) we adopt Graphiti/Neo4j “because temporal KG” and inherit write-amplification plus a second database the kernel constraint forbids; (d) we treat Mem0/Zep LoCoMo scores as the Gate 5 bar; (e) we pin a large always-on pack and recreate Lost in the Middle [6]; (f) Enterprise E2E orgs are the demo target — they opt out of the readable flywheel [38].

**Failure modes and detection**

| Failure | Why here | Detection |
|---|---|---|
| Empty pack | `project_id` null, embeddings null, `filesTouched` empty, Pair `allow`+`[]` | Pack `debug.droppedReasons`; alert if miner saw events and gold task packs empty |
| Wrong-neighborhood pollution | org-wide events; Pair includes NULL `project_id` | Negative gold questions; `% pack items with subject_project=relayfile` |
| Stale claims | `updated_ms` not in outbox; TTL not run | `last_confirmed_at` vs latest supporting event `ts` |
| Uncited output | model ignores pack | Gate 9 check for `cite: eventId=`; quality record, not kernel completion |
| Budget lie | pack tokens not journaled | memory line on `step.complete.usage`; resumed spend = one execution |
| Secret leak into claims | distill can carry tokens; server scrub is the boundary (`learn.rs` tests rely on this) | claims through `scrubText`; never embed pre-scrub |
| Outcomes never arrive | client doesn’t push `session_commit_links` | `session_outcomes` ingest count; 0 after N pushes = this gap (open today) |
| Pair vs pack disagreement | Pair ignores `patterns` and claims | one ranker library; Pair gains those sources |

Dropped Applied claims we could not stand behind: Graphiti GitHub issue #779 as the Postgres-backend status (official docs list Neo4j/FalkorDB/Neptune [14]; issue not fetched); Zep Community Edition “discontinued Apr 2025” (not fetched); Selective Forgetting arXiv:2608.28978 graph-vs-vector numbers (not fetched). Dropped Landscape numbers from [25] as unverified PDF.

## 5. What we can leverage

| Item | Fit (one line) |
|---|---|
| `convergence_events` + Pair `evidence[]` | **Default episodic store and citation wire format. Use.** |
| `patterns` / `pattern_hits` / `session_outcomes` | **Procedural + mistake loop. Extend writes; don’t overload with neighborhood facts.** |
| `ai-hist learn` distill schema | **Reuse as the extract prompt family; add a project-relevance gate in front.** |
| `ai-hist pack` / MCP `pack_evidence` | **Shape only.** Today: prompt FTS + per-entry truncation, no trajectories, no citations. |
| MCP `why_for_task` | **Name is right; implementation is LIKE LIMIT 1. Replace for cloud pack.** |
| Neon pgvector HNSW `vector(1536)` | **Use. First job is to populate it.** License: pgvector (PostgreSQL). Ops: already on Neon. |
| `text-embedding-3-small` | **Matches column dim. Default embedder; charge to miner/pack.** Hosted lock-in is real; swap later. |
| Postgres FTS (`ts_rank_cd`) | **Already in Pair. Keep as the lexical half of hybrid.** |
| Nightly `/internal/reflex/learn` + relaycron | **Clone for the neighborhood miner. Don’t invent a new scheduler.** |
| Scrubber (`lib/scrub.ts`) | **Non-negotiable ingest/egress boundary. Run on claims too.** |
| Relayfile knowledge-extraction / knowledge-graph specs | **Vocabulary (typed claims, TTL, invalidate, path scope). Not a second store — those specs themselves forbid one [36][37].** |
| Graphiti OSS (Apache-2.0) | **Steal bi-temporal schema + invalidate-don’t-delete. Do not run it** (Python, Neo4j/FalkorDB/Neptune, LLM-heavy writes) [14]. |
| Mem0 OSS (Apache-2.0) | **Steal hybrid fusion (semantic+BM25+entity). Do not adopt as SoT** (chat fact-store; platform scores ≠ OSS [18]; no journal/budget). pgvector *is* a supported backend [41]. |
| LangMem (MIT) | **Steal hot-path vs background manager. Do not take LangGraph into Rust/TS core** [27][42]. Postgres store exists; runtime doesn’t fit. |
| Letta / MemGPT (Apache-2.0 lineage) | **Steal sleep-time compute + small pinned core. Do not run a long-lived agent process** [5][21][43]. |
| Claude Code CLAUDE.md + auto memory | **Steal cap sizes and “skip what’s in the code.” Anti-pattern: silent truncation, no citations, local-only [22].** |
| Codex AGENTS.md + `~/.codex/memories/` | **Steal “team rules in git; generated memories are recall, not law” [23]. Capture into ai-hist instead of depending on Codex files.** |
| Cursor Rules / AGENTS.md | **Procedural, versioned. Cursor Memories (personal, not git) is useless for an org cloud agent [24].** |
| HippoRAG (MIT) | **Defer** unless 1-hop SQL fails the gold set [15]. |
| Zep Cloud | **Do not adopt.** Not Postgres; lock-in; DMR marketing [13][14]. |
| Cognee / SuperMemory / MemOS / MIRIX | **Not SoT.** Cognee is a Postgres existence proof, not our tenancy. SuperMemory #1 unverified. MemOS is a research program. |
| LongMemEval / MemoryAgentBench | **Proxy only.** Homemade Gate 5 gold set is the actual gate [11][12]. |
| Apache AGE | **Defer.** Light `neighborhood_edges` is enough. |

Ops cost: one extra cron (already patterned), embed calls on distilled events, one LLM extract per gated batch. No new database. No per-message SaaS.

## 6. Open questions

1. **Which `orgId` does the proof mine?** Isolation is the token’s org. Confirm AgentWorkforce vs a dedicated workspace.
2. **Canonical project id.** Local `history.project` is a filesystem path; trajectories use strings like `"agent-workforce"`; Pair infers from `gitRemote`/`cwd`. Who owns `project_aliases` contents for `relayfile` vs `relayfile-cloud` vs `packages/relayfile`?
3. **Distill coverage.** How many cloud rows are `lens=learn`/`trajectories` vs `kind=prompt`? Neighborhood quality is bounded by this. Not measured in this lane.
4. **Has production Neon ever received `session_outcome` rows?** Client cannot emit them. If rows exist, another writer exists and we need to know.
5. **Are embeddings backfilled out of band?** Code does not write them. Assume null unless a job outside these trees is named.
6. **Embedder budget owner.** OpenAI 1536 vs self-hosted; does miner spend count against the relayfile agent’s daily dollar cap (`SURFACE.md` `budget: "$20/day"`)?
7. **Sibling watchlist.** Confirm the list in §3.3. A missing sibling is a silent false-negative class.
8. **Local vs cloud wake.** When the agent runs in a sandbox, pack hits Neon (right default for a cloud agent) or synced SQLite? Coverage already shows machines go mute.
9. **Enterprise.** Proof is default-tier readable. Confirm we are not targeting an E2E org.
10. **Gate 5 kernel timing.** Ship pack as cloud API + SDK helper first (recommended); kernel memory line when the Gate 5 work package starts.

Settle (3), (4), and (2) before the miner: they decide whether P0 mapper fixes suffice or the miner must temporarily read prompts.

## 7. Sources

1. https://arxiv.org/abs/2005.11401 — RAG (Lewis et al.). Provenance as open problem. `verified` (abs)
2. https://arxiv.org/abs/2210.03629 — ReAct. `verified` (abs)
3. https://arxiv.org/abs/2303.11366 — Reflexion. `verified` (abs)
4. https://arxiv.org/abs/2304.03442 — Generative Agents. `verified` (abs)
5. https://arxiv.org/abs/2310.08560 — MemGPT. `verified` (abs)
6. https://arxiv.org/abs/2307.03172 — Lost in the Middle. `verified` (abs; Landscape fetched)
7. https://arxiv.org/abs/2308.10144 — ExpeL. `verified` (abs; Landscape fetched)
8. https://arxiv.org/abs/2305.16291 — Voyager skill library. `verified` (abs; Landscape fetched)
9. `flows/docs/RFC-0001-everything-is-a-relayflow.md` — Gates 4/5, decisions 8/10/15. `verified` (local)
10. https://arxiv.org/abs/2402.17753 — LoCoMo. `verified` (abs)
11. https://arxiv.org/abs/2410.10813 — LongMemEval. `verified` (abs)
12. https://arxiv.org/abs/2507.05257 — MemoryAgentBench. `verified` (abs; Landscape fetched)
13. https://arxiv.org/abs/2501.13956 — Zep/Graphiti paper. `verified` (abs; Landscape also fetched HTML)
14. https://help.getzep.com/graphiti/getting-started/overview — Graphiti backends, bi-temporal model, hybrid search. `verified`
15. https://arxiv.org/abs/2405.14831 — HippoRAG. `verified` (abs)
16. https://arxiv.org/abs/2404.16130 — GraphRAG. `verified` (abs; Landscape fetched)
17. https://arxiv.org/abs/2504.19413 — Mem0 paper. `verified` (abs + HTML)
18. https://github.com/mem0ai/mem0 — Apache-2.0; April 2026 ADD-only algorithm; platform vs OSS scores. `verified` (README)
19. https://arxiv.org/abs/2502.12110 — A-MEM. `verified` (abs)
20. https://arxiv.org/abs/2510.18866 — LightMem. `verified` (abs; Landscape fetched)
21. https://arxiv.org/abs/2504.13171 — Sleep-time Compute. `verified` (abs)
22. https://code.claude.com/docs/en/memory — Claude Code CLAUDE.md + auto memory caps. `verified`
23. https://learn.chatgpt.com/docs/customization/memories?surface=app — Codex memories vs AGENTS.md. `verified`
24. https://cursor.com/docs/rules.md — Cursor Rules / AGENTS.md. `verified` (search/docs fetch). Cursor Memories settings page: `unverified`
25. https://arxiv.org/html/2607.16848v1 — Beyond Memory Leaderboards (budgeted eval). `unverified` (search snippet only)
26. `relayhistory-cloud/docs/decisions/2026-06-27-reflex-learnings-and-outcomes-layer.md` + `packages/relayhistory/src/db/schema.ts` — `patterns` kinds, `session_outcomes`, `pattern_hits`. `verified` (local)
27. https://langchain-ai.github.io/langmem/concepts/conceptual_guide/ — episodic/semantic/procedural; hot path vs background. `verified`
28. `flows/docs/SURFACE.md` — `f.memory.recall/why/learn`. `verified` (local)
29. `flows/kernel/DESIGN.md` — memory verbs not in v0. `verified` (local)
30. `relayhistory/README.md` — CLI, MCP, trajectory contract. `verified` (local)
31. `relayhistory/sdk-ts/src/mcp-server.ts` — MCP tools including `why_for_task`, `pack_evidence`, `pair_check`. `verified` (local)
32. `relayhistory/sdk-ts/src/index.ts` — LIKE search; `whyForTask` = limit 1. `verified` (local)
33. `relayhistory-cloud/packages/relayhistory/src/lib/pair.ts` — lexical Pair, NULL project leak, kind weights, evidence. `verified` (local)
34. `relayhistory/docs/agent-integration.md` — Pair contract; vector retrieval future. `verified` (local)
35. `relayhistory-cloud/packages/relayhistory/src/lib/reflex/learn.ts` + `routes/internal.ts` — mistake-only miner; cron webhook. `verified` (local)
36. `relayfile/docs/knowledge-graph-spec.md` — draft; graph as metadata; invalidate. `verified` (local)
37. `relayfile/docs/knowledge-extraction-spec.md` — draft; TTL; no embeddings v1; not a second store. `verified` (local)
38. `relayhistory-cloud/docs/product-direction.md` — Neon+pgvector; Learn/Plan/Pair; don’t rebuild capture. `verified` (local)
39. `relayhistory-cloud/docs/decisions/2026-06-21-normalized-agent-event-schema.md` — tenancy from auth; embedding column. `verified` (local)
40. `relayhistory/docs/agent-integration.md` + `docs/pair-hooks.md` — Pair request/response, fail-open. `verified` (local)
41. https://docs.mem0.ai/components/vectordbs/dbs/pgvector — Mem0 pgvector backend. `verified` (search/docs)
42. https://github.com/langchain-ai/langmem — LangMem MIT, hot-path tools, background manager. `verified` (Landscape fetched README)
43. https://docs.letta.com/guides/agents/architectures/memgpt/ — Letta core vs archival. `verified` (search/docs)
44. `relayhistory/crates/ai-hist-core/src/convergence.rs` — `project_id: None` on prompts; trajectory fan-out. `verified` (local)
45. `relayhistory/crates/ai-hist-core/src/outbox.rs` — no `updated_ms` watermark. `verified` (local)
46. `relayhistory-cloud/packages/relayhistory/src/lib/ingest.ts` — no embedding write. `verified` (local)
47. `relayhistory/crates/ai-hist/src/learn.rs` — distill schema. `verified` (local)
48. https://github.com/getzep/graphiti — Graphiti Apache-2.0, ~30k stars. `verified` (search + Landscape LICENSE fetch)
49. https://arxiv.org/abs/2305.10250 — MemoryBank / Ebbinghaus forgetting. `verified` (abs; Landscape fetched)
50. https://arxiv.org/abs/2404.13501 — Survey of LLM-agent memory. `verified` (abs; Landscape fetched)
