# Agent memory for a cloud agent — synthesis

**Date:** 2026-09-02 · **Lanes:** claude, codex, grok · **Role:** editor, not a fourth researcher.

Two claims were checked directly by the editor to resolve conflicts between lanes: the Zep/Graphiti DMR
numbers (§3, D4) and the existence and content of arXiv:2606.24535 (§3, D1 note; §8 source 33).

---

## 1. Recommendation

Build a **sleep-time relayflow that materializes a cited, project-scoped view over `convergence_events`
in Neon**. No memory SaaS, no Neo4j, no second store — all three lanes agree on that much.

Order of work:

1. **Fix capture first.** Two lanes verified at file/line that the pipeline cannot yet support the proof:
   `map_history_entry` sets `project_id: None`; the outbox emits no `filesTouched`, no `session_outcome`,
   and has no update watermark, so revised trajectories never re-push; `ingest.ts` never writes the
   declared `vector(1536)` column; `pair.ts`'s project filter admits NULL `project_id` — a live scoping
   leak; Learn mines only reverted commits; `pattern_hits` is never written. Nothing downstream works
   until these do.
2. **Add the derived tier.** `project_aliases`, `neighborhood_claims` (bi-temporal, content-addressed,
   `support_event_ids`, status lifecycle), a 1-hop `neighborhood_edges` table, durable `memory_jobs`.
   Clone the `patterns` idioms; do not overload `patterns`.
3. **Write path.** Deterministic watchlist / alias / file-overlap triage → one bounded structured LLM
   extract per gated batch → upsert with citations. Every claim states *why relayfile is affected* and
   carries an evidence class (asserted / observed / corroborated).
4. **`POST /v1/memory/pack`.** Hybrid FTS + vector + file/edge signals, filter before ranking, exact
   tokenizer, mandatory citations, journaled truncation, charged to the consuming step.
5. **Gate on a relayfile gold set** with negatives and chronological splits — not LoCoMo, not vendor scores.

Ship as cloud API plus SDK helper; do not block the proof on kernel memory verbs.

---

## 2. Where the lanes agree

1. **Extend the existing Neon + pgvector convergence store; do not make any vendor the system of record.**
   Mem0, Letta, Zep Cloud, Graphiti and Hindsight are all rejected as SoT by every lane. (claude, codex, grok)
2. **Do not run Graphiti; steal its schema.** Bi-temporal facts with `valid_from`/`invalid_at`,
   invalidate-don't-delete, episodes as the provenance root. Its official backends are Neo4j / FalkorDB /
   Neptune — a second store and a second authorization plane. (claude, codex, grok) [7][26][27]
3. **Letta/MemGPT is architecturally incompatible, not merely a worse fit.** It solves context paging for a
   long-lived process; Gate 4 says no agent outlives its step. Borrow the bounded-core idea only.
   (claude, codex, grok) [2][13][33]
4. **Typed tiers over one Postgres.** Immutable episodic (`convergence_events`) → derived semantic claims →
   procedural (`patterns`) → a working pack assembled per wake that is never a source of truth.
   (claude, codex, grok) [1][31]
5. **Relevance is decided at write time by deterministic triage, then a bounded LLM extraction.** Embedding
   similarity alone must not decide what crosses a project boundary. Cheap lexical/alias/dependency/file
   prefilter first; LLM second; fail closed on invalid JSON. (claude, codex, grok)
6. **Hybrid retrieval, not vector-only.** Lexical/FTS carries package names, paths, error strings, versions,
   API fields; dense carries paraphrase; structural (file and project overlap) carries the rest. pgvector's
   own guidance says the same. (claude, codex, grok) [35]
7. **Citations are structural, not decorative.** Every packed item carries the convergence natural key
   (`machineId, source, sessionId, kind, eventId, ts`). No citation → the item does not ship. That makes
   Gate 5's done-when mechanically checkable. Reuse the existing `PairEvidence` shape rather than inventing
   a format. (claude, codex, grok)
8. **Content-addressed upsert IDs, a status lifecycle, and `support_event_ids`** — copied from the working
   `patterns` / `mineMistakePatterns` idiom, so re-runs are cheap no-ops. (claude, codex, grok)
9. **Consolidate by supersession; forget only in derived tiers.** Contradiction closes a validity window and
   sets `superseded`; episodic events are never rewritten or deleted (RFC decision 8). "Forgetting" means
   dormant/expired/excluded-from-retrieval. (claude, codex, grok)
10. **Run it off the hot path on the existing cron.** A scheduled miner cloned from
    `POST /v1/internal/reflex/learn`, not a daemon and not synchronous with ingest. (claude, codex, grok)
11. **Vendor benchmark numbers are not the gate.** Mem0, Zep, Hindsight and SuperMemory all report their own
    scores on their own selections; none is independently reproduced. Build a relayfile-specific gold set
    with negative cases. (claude, codex, grok)
12. **Raw session content is untrusted input.** Prompt injection / memory poisoning is demonstrated, not
    hypothetical; render content as quoted data, scrub before storage and egress, quarantine procedural
    admissions. (claude, codex, grok) [12]
13. **Tenancy is server-derived on every access path.** `orgId` from auth, never from the client payload,
    enforced on direct fetch as well as search. (claude, codex, grok) [25][52]
14. **Human-authored rules stay authoritative; generated memory proposes, it does not legislate.** Both
    Claude Code and Codex draw this line explicitly (CLAUDE.md / AGENTS.md vs. generated memories); a
    distilled claim may propose a diff, subject to Gate 9 approval. (codex, grok) [36][37]
15. **Small always-on core plus progressive disclosure under a hard budget.** Claude Code's 200-line/25KB
    cap and Codex's generated-summary cap are existence proofs that small cores work for coding agents.
    (claude, codex, grok) [36][37]
16. **The vendor-readable cloud sifter cannot serve the E2E opaque tier.** For that tier, extraction must run
    inside the tenant boundary and push opaque derived artifacts. (codex, grok) [51]

---

## 3. Where the lanes disagree

### D1. How much already exists — "additive one table" vs. "capture is broken"

- **claude:** the convergence store "already implements most of what best-in-class agent memory means"; the
  single missing capability is cross-project relevance classification, delivered as `project_watch_items`
  plus `project_dependencies`, additive to the existing schema.
- **codex:** "the critical prerequisite is better capture" — the outbox omits tool calls, file edits, commit
  links and trajectory updates, and its own comment admits row-id cursors miss updated trajectories.
- **grok:** names five specific blockers verified in code and says the proof is blocked by those, not by
  missing vendors.

**Ruling: codex and grok.** Two lanes independently inspected the Rust outbox and mapper and reached the same
conclusion with file-and-line evidence; claude's lane marked its own Rust-side source (`convergence.rs`,
`outbox.rs`, `cloud.rs`) as *not independently re-read by the lead*, so it is the one lane that did not check.
The consequence is not cosmetic: with `project_id: None` on prompt events, no `filesTouched`, and no
embeddings, claude's prefilter-then-classify write path has almost nothing to filter on. **P0 is capture, not
the new table.** claude's design of that table is still the right shape once capture lands — see §5.

*Editor note on claude's load-bearing citation:* arXiv:2606.24535 was marked unverified by its own lane and
carries claude's central write-time-filtering argument. I fetched it. It is real and does describe scoped
retrieval, temporal supersession, provenance, and a disclosed asymmetric-scope-enforcement bug. But it frames
its contribution as scoped retrieval *plus* supersession *plus* provenance rather than as "write-time beats
read-time filtering" — claude's sharpened framing is an inference beyond the paper. It survives anyway because
codex and grok reached deterministic write-time triage independently, on cost grounds.

### D2. Does the pack carry raw episodic excerpts, or only derived claims?

- **claude:** "no credible system treats the raw transcript as the retrieval unit"; the pack is derived items
  whose citations are live joins back to the event.
- **codex:** preserve evidence and derive revisable views on top. Cites the Redis LongMemEval experiment:
  raw hybrid excerpts *plus* extracted facts scored 86.1% vs. 71.2% for extracted facts alone, in that setup —
  extraction destroys access to omitted names, dates, symbols and numbers.
- **grok:** a middle episodic-WHY tier in the pack (top-k `decision|finding|reflection`), while explicitly
  refusing to dump `kind=prompt` rows in.

**Ruling: codex and grok.** claude is right that extraction, not verbatim storage, is what forms memory — and
right that transcripts must not be the retrieval unit. It is wrong that this implies the *pack* should contain
only derived statements. The distinction that resolves it: derived claims lead the pack and drive ranking;
bounded raw excerpts ride along as evidence for the top items. codex's number is a vendor experiment on one
setup and should not be treated as a law, but the mechanism it demonstrates — identifiers and versions
surviving in raw text that extraction drops — is exactly the failure mode a coding-agent memory cannot afford.

### D3. Is there an edges table in the first slice?

- **claude:** no graph, and no traversal. One `project_dependencies` table matched by name, explicitly not
  traversed; revisit only when a real multi-hop use case appears.
- **grok:** include `neighborhood_edges` in slice one, because "sibling API change impacts relayfile" *is* a
  relation. 1-hop SQL, not Cypher.
- **codex:** `entities` + `entity_aliases` + relational edges, with recursive CTEs, from the start.

**Ruling: grok, with codex's recursive CTEs deferred.** All three reject a graph *runtime*, unanimously and
correctly. But claude conflates rejecting Neo4j with rejecting an edge table, and leans on Mem0's ~2%
graph-vs-flat delta to do it (see D5). The proof point's own sentence — "decisions taken elsewhere that touch
relayfile" — is a relation between projects, and modelling it as an edge costs one table in Postgres. Ship
`neighborhood_edges` in slice one; use 1-hop joins only; add recursive CTEs when a gold-set question needs
two hops, and a dedicated graph backend only if a measured depth/latency threshold is crossed.

### D4. What the Zep/Graphiti DMR result shows — same source, opposite readings

- **claude:** cites 94.8% (Zep) vs. 93.4% (MemGPT) on Deep Memory Retrieval as evidence that graph memory is
  a credible, verified contender.
- **grok:** "Zep's own paper dismantles MemGPT's DMR: modern windows already score ~98% full-context, so the
  SOTA-vs-MemGPT gap is not a product argument" — and files the number under marketing.

**Ruling: grok. Verified by the editor.** Both lanes report the abstract correctly; grok read the evaluation
section. The paper's own body states: "Using gpt-4-turbo, the full-conversation baseline achieved 94.4%
accuracy, slightly surpassing MemGPT's reported results... When using gpt-4o-mini, both approaches showed
improved performance: 98.0% for full-conversation." It notes each conversation "contains only 60 messages,
easily fitting within current LLM context windows," concedes "significant weaknesses in the benchmark's
design," and concludes "the high performance achieved by simple full-context approaches using modern LLMs
further highlights the benchmark's inadequacy for evaluating memory systems." **Do not cite the DMR delta in
either direction.** The LongMemEval results in the same paper are the part worth reading.

### D5. How much weight the Mem0 graph-vs-flat number can carry

- **claude:** makes Mem0g's ≈2% gain over flat "the load-bearing fact for this project's architecture
  decision."
- **codex:** "vendor-authored study shows only a modest aggregate improvement" — one input to a layered
  position, with graph ablations deferred to our own benchmark.
- **grok:** undercuts the source itself — Mem0's April 2026 README *reverses* the paper's ADD/UPDATE/DELETE
  algorithm to "single-pass ADD-only… memories accumulate; nothing is overwritten," and the headline platform
  scores (LoCoMo 92.5 / LongMemEval 94.4) are "proprietary optimizations not available in the open-source SDK."

**Ruling: the number cannot be load-bearing for anyone.** grok's finding is decisive: the shipped OSS no longer
implements the algorithm the paper benchmarked, so a delta measured on the paper's configuration says little
about the artifact you would adopt. The right basis for skipping a graph runtime is the requirement (today's
questions are one-hop) and our own gold set — not a vendor's self-reported 2%. claude reaches the correct
conclusion on faulty evidence; codex's "make it an ablation, not an article of faith" is the right posture.

### D6. External memory benchmarks — reuse, or reject?

- **codex:** reuse LongMemEval / LongMemEval-V2 / MemoryAgentBench protocols and case types (not scores);
  LME-V2 is closest to trajectory retrieval.
- **grok:** "this is not LoCoMo/LongMemEval chat personalization… chat-memory leaderboards are the wrong
  gate," structurally.
- **claude:** neither — fixture-based offline tests in the style of `learn.rs`'s acceptance fixtures.

**Ruling: both codex and grok, on different objects.** grok is right that no external score is a ship gate:
these are dialogue-personalization corpora and ours is cross-repo coding-trace retrieval. codex is right that
their *protocols* are the best available templates — the index/retrieve/read decomposition, bounded-context
evaluation with a fixed reader, and the abstention and knowledge-update ability classes, which are precisely
the cases a naive gold set omits. Adopt codex's protocol onto grok's relayfile gold set. claude's fixtures are
the unit-test layer beneath both, not a substitute.

### D7. Extraction granularity and cost

- **claude:** a structured-output classifier call per prefiltered candidate.
- **grok:** one bounded LLM extract per *gated batch*, not per line.
- **codex:** a durable `memory_jobs` table keyed by `(event natural key, profile version, extractor version,
  content hash)`; the job table is truth, the queue only wakes workers.

**Ruling: grok's batching inside codex's job table.** Per-candidate calls do not survive a firehose across
every repo. codex's durability framing is the part claude's scheduled-cursor design is missing: a cursor
watermark alone loses work on a crash mid-batch.

---

## 4. Single-source claims worth keeping

**From grok:**
- **`pair.ts`'s project filter includes NULL and empty `project_id` when `projectId` is set** (~lines 200–207)
  — a "scoped" search silently admits unscoped prompts from other projects. This is a live scoping bug today
  and it is the exact failure class claude's cross-tenant risk section warns about in the abstract. Fix it
  before building anything that depends on project scoping.
- **The relayfile repo already contains draft `docs/knowledge-graph-spec.md` and
  `docs/knowledge-extraction-spec.md`** (typed knowledge, cascade invalidation, TTL, path-scoped annotations,
  "graph as metadata, not a second store"). The vocabulary is already agreed internally; only the tables are
  missing — and those drafts independently forbid a second store.
- **Kernel `DESIGN.md` lists memory verbs as explicitly not-in-v0.** Therefore ship pack as a cloud API plus
  SDK helper and journal usage on `step.complete` as an honest incomplete; do not block the proof on
  `relayflowd`.
- **Lost in the Middle → put load-bearing items at the *edges* of the pack**, and journal a
  `memory_truncated` count on overflow rather than reproducing Claude Code's silent 200-line drop. "Steal the
  cap, not the silence." [6][36]
- **Sleep-time compute is the published justification for sifting off the hot path** (~5× less test-time
  compute, with a SWE case study), alongside LightMem's decoupling of sleep-time LTM from online inference.
  [13][14]
- Local `ai-hist pack` is FTS over *prompts*, truncating each to `tokens*4` characters, and does not pack
  trajectories; the TS SDK's `whyForTask` is `LIKE` with `limit 1` because sql.js has no FTS5. Both are
  "right name, wrong implementation" — reuse the shape, replace the internals.

**From codex:**
- **Evidence classes: `asserted` / `observed` / `corroborated`.** A session is evidence of what was *asserted
  or attempted*, not proof that it shipped. Without commit/CI/deploy/incident producers the system will
  confidently remember fiction. No other lane raises this, and it is the single most valuable idea in the
  three reports for a memory built out of coding transcripts.
- **Replace `pack`'s `tokens × 4` character approximation with a real target-model tokenizer** and a
  utility-per-token selector with per-section ceilings and reserved citation overhead.
- **`memory_retrieval_log`** recording candidates, scores, selection, and a pack digest — so a resumed step
  replays the same pack and budget charging is auditable.
- **pgvector post-filtering degrades HNSW recall**: apply ACL/project/status/temporal filters *before*
  ranking, keep exact-search shadow samples, and version embedding models with dual-write backfill.
- **Hindsight** (MIT, Postgres + pgvector, TypeScript client, ACL 2026 demo) is unusually close to this
  stack — run it as a shadow benchmark and design source. No other lane found it.
- **MINJA**: a query-only memory-injection attack showing ordinary interactions can poison agent memory. [12]
- **OpenAI's harness-engineering and in-house-data-agent write-ups**: "a map, not an encyclopedia," and
  stored context combined with live revalidation at wake. [40][41]

**From claude:**
- **Reserve one pack slot for the highest-confidence incident / repeated-mistake item** before greedy filling,
  so budget starvation cannot silently drop the one fact Gate 5's acceptance test is about.
- **`source_event_id` as a live foreign-key-by-value into `convergence_events`, not a copied snippet** — a
  citation stays a resolvable join rather than a frozen, possibly stale string.
- **No named production system does what the relayfile proof point describes** — continuous cross-repo
  firehose ingestion, filtered to "what matters to project X," with citations. This is genuinely build, not
  buy, and that is a finding, not an absence of one.
- The **asymmetric scope-enforcement bug** disclosed in [25] (a direct GET-by-id path bypassing the scoping
  the search path enforced) should become a named test case, not a design intention.

---

## 5. The plan

### 5.1 Data model

Four tiers over one Postgres (Neon), mirroring the local SQLite shape:

| Tier | Contents | Store | Mutability |
|---|---|---|---|
| 0 · Working | the wake pack + citations | assembled per step | never a source of truth |
| 1 · Episodic | sessions, prompts, decisions, findings, reflections, outcomes | `convergence_events` (exists) | append-only, never rewritten |
| 2 · Semantic | what is true *for relayfile now* | **new** `neighborhood_claims` + `neighborhood_edges` | supersession only |
| 3 · Procedural | skills, footguns, mistakes, playbooks | `patterns` / `pattern_hits` (exist) | status lifecycle |
| 4 · Script | journal + epoch summaries | kernel journal | Gate 5, later |

New tables (one migration in `relayhistory-cloud/packages/relayhistory/src/db/schema.ts`):

- **`project_aliases`** — `(org_id, alias) → canonical_project, kind ∈ self | sibling | contract`. Seeds for
  relayfile: `relayfile`, `relayfile-cloud`, `packages/relayfile`, `@relayfile/`, `file.agentrelay.com`;
  siblings `relayauth`, `relaycast`, `burn`, `burn-cloud`, `relayhistory`, `relayhistory-cloud`,
  `sandbox-router`; contract tokens `EventFrameV1`, writeback/mount/adapter, `rth_at_`, `brn_at_`. Versioned
  and human-approved; models may *propose* aliases, a deterministic source or a human activates them.
- **`neighborhood_claims`** — content-addressed `id = sha256(org, subject_project, kind, normalized
  statement)`; `kind ∈ dependency_change | api_contract | sibling_decision | incident | repeated_mistake`;
  `source_project`, `subject_project`, `statement`, `body`, `impact_on_subject`, `entities[]`,
  `evidence_class ∈ asserted|observed|corroborated`, `confidence`, `status ∈ candidate|active|contested|
  superseded|dormant|expired|retracted`, `valid_from`, `invalid_at`, `observed_from`, `last_confirmed_at`,
  `expires_at`, `supersedes_claim_id`, `support_event_ids` (capped, same natural-key shape as `patterns`),
  `extractor_version`, `profile_version`, `embedding vector(1536)` + partial HNSW.
- **`neighborhood_edges`** — `(src_project, dst_project, relation ∈ impacts|depends_on|broke|supersedes,
  claim_id)`. 1-hop joins only.
- **`memory_jobs`** — durable extraction/consolidation work keyed by `(event natural key, profile version,
  extractor version, content hash)`; the table is truth, the cron only wakes workers.
- **`memory_retrieval_log`** — candidates, scores, selected IDs, exact token count, pack digest, later feedback.

`contested` (codex) is kept alongside `superseded`: two live claims that conflict without temporal ordering
are a real state, and collapsing them to "latest wins" is exactly the failure mode bi-temporality exists to
prevent.

### 5.2 Write path

**P0 — capture (blocking, in `../relayhistory`).** Nothing else is worth building first.

1. `crates/ai-hist-core/src/convergence.rs` — populate `project_id` from `history.project` / git remote
   instead of `None`.
2. `crates/ai-hist-core/src/outbox.rs` — emit `filesTouched` (from `file_edits`), `session_commit_links` →
   `session_outcome`, and add an `updated_ms` watermark so revised trajectories re-push.
3. `relayhistory-cloud .../lib/ingest.ts` — write the `vector(1536)` column (`text-embedding-3-small` matches
   the declared dimension), with model/dimension/content-hash/generated-at recorded *beside* the row.
4. `relayhistory-cloud .../lib/pair.ts` — fix the NULL/empty `project_id` admission in the project filter.

**P1 — the miner.** A scheduled relayflow cloned from `POST /v1/internal/reflex/learn` + the existing
relaycron registration. Per run:

1. **Deterministic triage** over new/updated `convergence_events` since the watermark: alias match, dependency
   name match, `files_touched` intersection with relayfile globs, manifest/lock/API/schema edits, incidents
   and reverts, repeated failures. Gate = self-alias **or** (sibling match **and** (self-alias in content
   **or** an impact verb: break, depend, adapter, contract, API, mount, writeback)) **or** file overlap.
2. **One bounded structured extraction per gated batch** — not per candidate — using the `ai-hist learn`
   distill schema family with a project-relevance gate in front. Strict JSON schema, raw JSON only, fail
   closed on invalid output. The extractor **must** state why the subject project is affected;
   "semantically similar" is not an admissible reason.
3. **Citation validation:** reject any support key or span that was not in the extractor's input.
4. **Upsert** content-addressed. Re-observation grows `support_event_ids` and bumps `last_confirmed_at`.
   Contradiction writes a new claim with `supersedes_claim_id`, sets the old one `superseded`,
   `invalid_at = now()`. Overlapping conflicts with no temporal ordering become `contested`.
5. **Journal** each transition: inputs, model/prompt/profile/extractor versions, tokens, cost, output IDs,
   retry state, `completionReason`.

Scrub on the ingest and egress boundary (`lib/scrub.ts`) and never embed pre-scrub text. Treat all session
content as quoted untrusted data.

**Consolidation and forgetting.** Dependency and contract facts stay active until superseded. Incident
warnings get a review date. Single-session procedures are `candidate` only; promotion to `active` requires
repeated independent outcomes, an executable check, or human approval. Inactivity lowers retrieval priority or
makes a claim `dormant` — it must not lower factual confidence by itself. Episodic events are never deleted
(RFC decision 8); privacy deletion is a separate operation that cascades into claim recomputation.

### 5.3 Retrieval at wake

New `POST /v1/memory/pack` (scope `rth:read`), which is the WS-5 Plan surface specialized to one project.
Request: `{ subjectProject, task, files, budgetTokens, scopes }`.

- Expand the query through `project_aliases` and 1-hop `neighborhood_edges`.
- Run pools in parallel: exact identifier/path lookup, Postgres FTS (`ts_rank_cd`, already in Pair), pgvector
  cosine, file overlap, valid-time queries, verified-outcome search, bounded edge neighbors.
- **Filter before ranking** — ACL, org, subject project, status, temporal — because post-filtering an HNSW
  index degrades recall [35]. Fuse with reciprocal-rank fusion; rerank only the small fused set; diversify.
- **Assemble by position, not just score** (Lost in the Middle [6]): live claims and procedural patterns at
  the front, bounded episodic WHY evidence in the middle, uncertainties last. Reserve one slot for the top
  incident / repeated-mistake item before greedy filling. Do not dump `kind=prompt` rows in.
- **Every item carries a resolvable citation or it does not ship.** Each also carries stable ID, explicit
  impact, evidence class, confidence, effective/observed dates; model-inferred impact is labelled inference.
- **Budget:** exact target-model tokenizer, utility-per-token selection, per-section ceilings, reserved
  citation overhead. Overflow is a journaled `memory_truncated` count, never a silent drop. Journal the
  itemized token count against the consuming step (RFC decision 10) and pin the pack digest so a resumed step
  replays one execution's spend.
- **Pair** queries the same index and the same ranker library with stricter precision/latency thresholds, and
  writes `pattern_hits` (`fired|accepted|dismissed|recurred`) — replacing its current independent raw-event path.

### 5.4 Evaluation

The gate is a **relayfile neighborhood gold set** (~30 questions), not a public leaderboard:

- **Positives** with required `eventId` citations: a writeback/lease incident, a RelayAuth path-scope change
  affecting adapters, a repeated permissions mistake, a sibling dependency bump.
- **Negatives:** an unrelated session that never mentions relayfile must not appear; similarly-named repos;
  events with missing project IDs; false premises; poisoned text; ACL canaries.
- **Chronological and leakage-safe:** at query time *T*, retrieval sees only items observed by *T*, while
  labels may inspect later outcomes.

Three layers, borrowing LongMemEval's index/retrieve/read decomposition and LME-V2's bounded-context protocol
[5][8] as *protocol only*:

1. **Deterministic retrieval tests** on fixtures, no LLM: Recall@k, nDCG, project precision, temporal
   validity, contradiction recall, citation-support rate, stale rate, token overflow, p50/p95, cost.
2. **Extraction tests:** F1 per item and project, citation-attachment precision, and asserted-vs-shipped error
   rate — the metric that catches remembering fiction.
3. **Behavioral A/B:** replay the same relayflow task and model with memory off vs. on; check task success,
   known-mistake avoidance, presence of the citation natural key in the output, tokens, dollars, latency.
   **This is Gate 5's done-when and the decisive proof.**

Ablations: raw-only / derived-only / hybrid, graph-off / graph-on, cheap vs. deep retrieval. Fault injection:
crash between ingest, job and materialization; remove sole support; add superseding evidence; revoke access;
change embedding models. **If the A/B shows no improvement at the agreed budget, do not ship the consolidation
machinery — fix capture and relevance, or stop.**

### 5.5 Repository mapping

| Repo | Work |
|---|---|
| `../relayhistory` (Rust core) | P0 mapper/outbox fixes: `project_id`, `filesTouched`, `session_outcome`, `updated_ms` watermark. Replace `pack`'s `tokens × 4` truncation with a real tokenizer. Reuse the `learn distill` schema as the extract prompt family. |
| `../relayhistory-cloud` (Neon/Drizzle/Hono) | System of record. Migration for the four new tables; embedding write in `ingest.ts`; the miner cron cloned from `/internal/reflex/learn`; `POST /v1/memory/pack`; the Pair project-filter fix; one shared ranker library for Pair and pack. |
| `../relayfile` | Owns `project_aliases` content and the gold set. Its draft `knowledge-graph-spec.md` / `knowledge-extraction-spec.md` supply the vocabulary; `evals/` and `scripts/evals` host the cases. |
| `flows` (this repo) | The miner and the wake path as relayflows (Gate 2 + Gate 5). SDK `f.memory.recall/why/learn` compiling to the cloud API. Journal crash tests pinning exactly-once materialization and budget charging. Kernel memory verbs land later — `DESIGN.md` puts them out of v0, so do not block on them. |

### 5.6 First slice, in order

1. P0 capture fixes (four changes above). 2. Embeddings written on ingest. 3. `project_aliases` +
`neighborhood_claims` + `neighborhood_edges` + `memory_jobs` migration. 4. Miner cron with deterministic gate
+ batched extraction. 5. `POST /v1/memory/pack`, lexical + structural now, vector as soon as embeddings land.
6. ~20–30 question gold file; the pack test fails if a known incident is missing. 7. SDK helper.

---

## 6. Leverage, ranked

| # | Item | Fit | Lanes |
|---|---|---|---|
| 1 | **`convergence_events` + `PairEvidence` citation shape** | Adopt as-is. Already the right episodic store and the right citation wire format. | claude, codex, grok |
| 2 | **`patterns` / `pattern_hits` / `session_outcomes` + `mineMistakePatterns`** | Adopt the idioms (content-addressed IDs, status lifecycle, `support_event_ids`, ≥2-sample promotion) for the new tables. Do **not** overload `patterns` with neighborhood facts — its `kind` enum is procedural and Pair's kind weights would break. | claude, codex, grok |
| 3 | **Postgres FTS (`ts_rank_cd`) + pgvector HNSW on Neon** | Adopt now. Best stack fit, no extra service. Filter before ranking; keep exact-search shadow samples; version embedding models. | claude, codex, grok [35] |
| 4 | **Nightly `/internal/reflex/learn` + relaycron + `lib/scrub.ts`** | Adopt. Clone the scheduler; do not invent one. Scrub is a non-negotiable boundary and must run on claims too. | grok |
| 5 | **`ai-hist learn` distill schema and its strict-JSON discipline** | Adopt as the extract prompt family; add the project-relevance gate in front. | claude, codex, grok |
| 6 | **Graphiti (Apache-2.0)** | Steal the bi-temporal schema and invalidate-don't-delete. Do **not** run it: Python, Neo4j/FalkorDB/Neptune, LLM-heavy writes, second authorization plane. | claude, codex, grok [7][26][27] |
| 7 | **Relayfile's draft knowledge-graph / knowledge-extraction specs** | Adopt the vocabulary — typed claims, TTL, cascade invalidation, path scoping. The drafts themselves forbid a second store. | grok |
| 8 | **LongMemEval / LME-V2 / MemoryAgentBench** | Reuse protocols and case types (index/retrieve/read, bounded context, abstention, knowledge updates, selective forgetting). Do **not** reuse scores; they are dialogue corpora. | codex, grok [5][8][9] |
| 9 | **Hindsight (MIT, Postgres + pgvector, TS client, ACL 2026)** | Shadow benchmark and design source — unusually close to this stack. Python service and LLM extraction add operational cost; author-reported accuracy needs reproduction. | codex [24][28] |
| 10 | **LangMem (MIT)** | Steal the hot-path vs. background-formation split and the episodic/semantic/procedural vocabulary. Do not take LangGraph into a Rust/TS core. | claude, codex, grok [31][32] |
| 11 | **Letta / MemGPT + sleep-time compute** | Steal the bounded-core idea and the sleep-time justification. Do not run a long-lived agent process — it contradicts Gate 4. | claude, codex, grok [2][13][33] |
| 12 | **Mem0 (Apache-2.0)** | Extraction/search baseline and hybrid-fusion reference only. Not SoT: generic user memory, no journal or budget, and the shipped OSS no longer matches the benchmarked algorithm. | claude, codex, grok [10][29] |
| 13 | **Claude Code / Codex / Cursor memory features** | Steal the cap sizes, progressive disclosure, and "team rules in git; generated memories are recall, not law." Anti-patterns: silent truncation, no citations, machine-local scope. None supplies a hosted cross-repo cited plane. | claude, codex, grok [36][37][38] |
| 14 | **promptfoo (MIT)** | Adopt for model/prompt/adversarial comparison in the eval harness. | codex [42] |
| 15 | **`fastembed-rs` (Apache-2.0)** | Optional, for local and E2E-tier embeddings and reranking; ONNX adds CPU/cache cost. | codex [43] |
| 16 | **HippoRAG / Apache AGE / a cross-encoder reranker** | Defer. Revisit only when a gold-set question needs multi-hop or an eval shows lexical+structural scoring underperforming. | claude, codex, grok |
| 17 | **Zep Cloud, SuperMemory, Cognee, MemOS, MIRIX** | Do not adopt. Not Postgres-native to our tenancy, lock-in, unreproduced claims, or research programs rather than products. | grok |

---

## 7. Open questions

**Blocking — settle before the miner is built**

1. **Distill coverage.** What fraction of cloud rows are `lens=learn` / trajectories versus raw `kind=prompt`?
   Neighborhood quality is bounded by this, and it decides whether the P0 mapper fixes suffice or the miner
   must temporarily read prompts (expensive, secret-heavy). Not measured by any lane. (grok)
2. **Has production Neon ever received `session_outcome` rows, and are embeddings backfilled out of band?**
   The client cannot emit the first and no inspected code writes the second. If rows exist, another writer
   exists and we need to know about it. (grok, codex)
3. **Canonical project identity.** Local `history.project` is a filesystem path; trajectories use strings like
   `"agent-workforce"`; Pair infers from `gitRemote`/`cwd`. Who owns `project_aliases` for `relayfile` vs.
   `relayfile-cloud` vs. `packages/relayfile`, and who approves changes? (claude, codex, grok)
4. **Which `orgId` does the proof mine** — AgentWorkforce or a dedicated workspace — and what RelayAuth policy
   permits a relayfile-scoped agent to read sibling-repo sessions? Must citation resolution re-check the
   requesting step's *current* access? (codex, grok)

**Design**

5. **Sibling watchlist completeness.** A missing sibling is a silent false-negative class that the gold set's
   negatives will not catch. Confirm the seed list in §5.1. (claude, grok)
6. **`project_dependencies` / aliases: hand-maintained or derived from manifests** (package.json, Cargo.toml,
   lockfiles) at ingest? Both lanes that proposed the table assumed the former without saying how it stays
   current. (claude, codex)
7. **False-negative rate of lexical/alias prefiltering vs. a semantic signal.** Exactly what the offline
   harness should answer before deciding how urgently to wire the dormant embedding column. If false
   *negatives* dominate rather than false positives, the profile-embedding second signal moves up. (claude)
8. **Which systems are authoritative for "shipped"** — commits, CI, deploys, package registries, contract
   registries, incident tools? Who adds those convergence producers? The `asserted`/`observed`/`corroborated`
   distinction is unimplementable without them. (codex)
9. **Promotion thresholds:** what separates a suggestion, an active warning, and a proposed source-controlled
   rule, and which transitions require human approval? (codex, grok)
10. **Budgets and owners:** initial wake-pack and Pair token, p95 latency, and dollar budgets; which target
    models and tokenizers; does miner and embedder spend count against the relayfile agent's daily cap? Who
    pays — the emitting project or the watching one? (claude, codex, grok)
11. **Does the reserved incident/mistake slot match what Gate 5 actually needs**, or does live traffic show a
    different allocation? (claude)
12. **Retention and deletion** for raw episodes, snippets, embeddings and derived claims — and how fast must
    deletion recompute dependents? (codex)
13. **Measured threshold for a real graph backend:** what depth, scale or latency number would justify one
    over Postgres edges? Name it now so the decision is empirical later. (codex, grok)
14. **E2E enterprise tier:** where does extraction run, and can an opaque derived memory preserve verifiable
    citations without exposing content to the vendor? Confirm the proof is not targeting an E2E org. (codex, grok)
15. **Local vs. cloud wake:** when the agent runs in a sandbox, does pack hit Neon or synced SQLite? Coverage
    already shows machines go mute. (grok)
16. **Firehose fan-out:** how many watching projects will subscribe simultaneously, and does the deterministic
    prefilter stay cheap as that count grows? (claude)
17. **Can the team curate the chronological gold set — including false premises and negative "nothing
    relevant" cases — before schema work begins?** (codex)

---

## 8. Sources

Union of the lanes' **verified** sources. Entries marked *(editor)* were fetched by the synthesizer to resolve
a conflict. Sources no lane verified — MemoryOS (arXiv:2506.06326), RCR-Router (arXiv:2508.04903), "Beyond
Memory Leaderboards" (arXiv:2607.16848) — are **excluded**; they appear nowhere in the rulings above.

### Research

1. CoALA — https://arxiv.org/abs/2309.02427 — working/episodic/semantic/procedural taxonomy. (codex)
2. MemGPT — https://arxiv.org/abs/2310.08560 — virtual context management, memory tiers. (codex, grok)
3. Generative Agents — https://arxiv.org/abs/2304.03442 — recency/relevance/importance retrieval, reflection. (codex, grok)
4. Reflexion — https://arxiv.org/abs/2303.11366 — feedback-derived textual lessons. (codex, grok)
5. LongMemEval — https://arxiv.org/abs/2410.10813 — five abilities incl. knowledge updates and abstention; index/retrieve/read decomposition. (codex, grok)
6. Lost in the Middle — https://arxiv.org/abs/2307.03172 — U-shaped attention; place load-bearing items at the pack edges. (grok)
7. Zep: A Temporal Knowledge Graph Architecture for Agent Memory — https://arxiv.org/abs/2501.13956 — bi-temporal graph memory; DMR 94.8% vs 93.4%, **and** the paper's own finding that a full-conversation baseline reaches 98.0% with gpt-4o-mini and that DMR is "inadequate for evaluating memory systems." (claude, grok; body re-verified by **editor**)
8. LongMemEval-V2 — https://arxiv.org/abs/2605.12493 — agent-trajectory memory benchmark, bounded-context and latency protocol. (codex)
9. MemoryAgentBench — https://arxiv.org/abs/2507.05257 — incremental evaluation, selective forgetting. (codex, grok)
10. Mem0 — https://arxiv.org/abs/2504.19413 — extraction/consolidation pipeline; Mem0g graph variant ≈2% over flat; vendor-authored LOCOMO evaluation. (claude, codex, grok)
11. A-MEM — https://arxiv.org/abs/2502.12110 — Zettelkasten-style linked, evolving notes. (codex, grok)
12. MINJA — https://arxiv.org/abs/2503.03704 — query-only memory-injection attack. (codex)
13. Sleep-time Compute — https://arxiv.org/abs/2504.13171 — off-hot-path precomputation, ~5× less test-time compute. (grok)
14. LightMem — https://arxiv.org/abs/2510.18866 — decoupled sleep-time long-term memory. (grok)
15. ExpeL — https://arxiv.org/abs/2308.10144 — insight distillation across experiences; closest analog of `ai-hist learn`. (grok)
16. Voyager — https://arxiv.org/abs/2305.16291 — skill library as procedural memory. (grok)
17. HippoRAG — https://arxiv.org/abs/2405.14831 — KG + Personalized PageRank multi-hop; accretion without invalidation. (grok)
18. GraphRAG — https://arxiv.org/abs/2404.16130 — batch/static corpus graph construction. (grok)
19. LoCoMo — https://arxiv.org/abs/2402.17753 — very long dialogue benchmark (~300 turns). (grok)
20. MemoryBank — https://arxiv.org/abs/2305.10250 — Ebbinghaus-style forgetting curve. (grok)
21. RAG — https://arxiv.org/abs/2005.11401 — provenance named as an open problem. (grok)
22. ReAct — https://arxiv.org/abs/2210.03629 — retrieve, don't stuff. (grok)
23. Survey of LLM-agent memory — https://arxiv.org/abs/2404.13501 (grok)
24. Hindsight (ACL 2026 system demonstration) — https://aclanthology.org/2026.acl-demo.27/ (codex)
25. Governed Shared Memory for Multi-Agent LLM Systems — https://arxiv.org/abs/2606.24535 — scoped retrieval, temporal supersession, provenance, policy-governed propagation; discloses an asymmetric scope-enforcement bug. Marked *unverified* by the claude lane; **fetched and verified by the editor**. (claude; **editor**)

### Implementations and vendor documentation

26. Graphiti — https://github.com/getzep/graphiti — Apache-2.0, temporal graph, episode provenance, hybrid retrieval. (codex, grok)
27. Graphiti docs — https://help.getzep.com/graphiti/getting-started/overview — bi-temporal model, hybrid search, Neo4j/FalkorDB/Neptune backends. (grok)
28. Hindsight — https://github.com/vectorize-io/hindsight — MIT, Postgres + pgvector, TS client, author-reported benchmarks. (codex)
29. Mem0 OSS — https://github.com/mem0ai/mem0 — Apache-2.0; April 2026 README describes single-pass ADD-only accumulation, reversing the paper's ADD/UPDATE/DELETE; platform scores flagged as proprietary optimizations absent from the OSS SDK. (codex, grok)
30. Mem0 pgvector backend — https://docs.mem0.ai/components/vectordbs/dbs/pgvector (grok)
31. LangMem — https://github.com/langchain-ai/langmem — MIT, hot-path tools and background manager. (codex, grok)
32. LangMem conceptual guide — https://langchain-ai.github.io/langmem/concepts/conceptual_guide/ — episodic/semantic/procedural; hot path vs. background. (grok)
33. Letta — https://github.com/letta-ai/letta — Apache-2.0 stateful-agent memory platform. (codex)
34. Letta MemGPT architecture docs — https://docs.letta.com/guides/agents/architectures/memgpt/ — core vs. archival memory. (grok)
35. pgvector — https://github.com/pgvector/pgvector — index/filter behavior, hybrid-search guidance. (codex)
36. Claude Code memory — https://code.claude.com/docs/en/memory — CLAUDE.md vs. auto memory, four memory types, 200-line/25KB cap, `MEMORY.md` index, per-topic on-demand files, machine-local scope. (claude, codex, grok)
37. Codex memories — https://learn.chatgpt.com/docs/customization/memories — generated memories are a recall layer, not authoritative team guidance; AGENTS.md is the team layer. (codex, grok)
38. Cursor project memories — https://docs.cursor.com/en/context/memories — sidecar-proposed memories with user approval. Verified by the codex lane; the grok lane could **not** confirm a team-memory product from Cursor's own settings page and verified only https://cursor.com/docs/rules.md. Treat the team-scope claim as the weaker half. (codex; grok partial)
39. Redis LongMemEval experiment — https://redis.github.io/redis-ai-research-public/longmemeval-agent-memory/ — raw hybrid excerpts + extracted facts 86.1% vs. extracted-only 71.2% in that setup; vendor study with disclosed limitations. (codex)
40. OpenAI, "Inside our in-house data agent" — https://openai.com/index/inside-our-in-house-data-agent/ — multi-source context, live validation, access control, eval precedent. (codex)
41. OpenAI, "Harness engineering" — https://openai.com/index/harness-engineering/ — "a map, not an encyclopedia," progressive disclosure, doc gardening. (codex)
42. promptfoo — https://github.com/promptfoo/promptfoo — MIT evaluation and adversarial testing. (codex)
43. fastembed-rs — https://github.com/Anush008/fastembed-rs — Apache-2.0 Rust-native embedding/reranking. (codex)

### Local repositories (all verified by the citing lane)

44. `flows/docs/RFC-0001-everything-is-a-relayflow.md` — Gates 4/5, decisions 8/10/15, the Gate 5 acceptance test. (claude, codex, grok)
45. `flows/docs/SURFACE.md` — `f.memory.recall/why/learn`. (claude, codex, grok)
46. `flows/kernel/DESIGN.md` — memory verbs explicitly not in v0. (grok)
47. `relayhistory-cloud/packages/relayhistory/src/db/schema.ts` — `convergence_events`, `patterns`, `pattern_hits`, `session_outcomes`; `embedding vector(1536)` + HNSW declared but unwired. (claude, codex, grok)
48. `relayhistory-cloud/.../lib/pair.ts` — scoring formula (`text 0.72 / file 0.2 / project 0.08`), kind weights, `PairEvidence` shape, and the NULL/empty `project_id` admission in the project filter (~200–207). (claude, codex, grok)
49. `relayhistory-cloud/.../lib/reflex/learn.ts` + `routes/internal.ts` — `mineMistakePatterns` (reverted-commits only, `status: sampleSize >= 2 ? "active" : "candidate"`), cron webhook. (claude, codex, grok)
50. `relayhistory-cloud/.../lib/ingest.ts` — accepts `session_outcome`; never writes `embedding`. (grok)
51. `relayhistory-cloud/docs/product-direction.md` — Neon + pgvector convergence store, Learn/Plan/Pair, E2E opaque tier, "don't rebuild capture." (codex, grok)
52. `relayhistory-cloud/docs/decisions/2026-06-21-normalized-agent-event-schema.md` — tenancy derived from auth. (grok)
53. `relayhistory-cloud/docs/decisions/2026-06-27-reflex-learnings-and-outcomes-layer.md` — `patterns` kinds, `session_outcomes`, `pattern_hits`. (grok)
54. `relayhistory/crates/ai-hist-core/src/convergence.rs` — `map_history_entry` sets `project_id: None`. (codex, grok)
55. `relayhistory/crates/ai-hist-core/src/outbox.rs` — cursors on `history.id` + `trajectories.rowid`; no `updated_ms` watermark; no `filesTouched` or `session_outcome` emission. (codex, grok)
56. `relayhistory/crates/ai-hist/src/learn.rs` — distill schema, strict-JSON discipline, acceptance fixtures. (claude, codex, grok)
57. `relayhistory/crates/ai-hist/src/lib.rs` — `pack_entries`: prompt FTS with `tokens × 4` character truncation, no trajectories. (codex, grok)
58. `relayhistory/sdk-ts/src/index.ts` and `src/mcp-server.ts` — MCP tools; `whyForTask` = `LIKE` with `limit 1` (sql.js has no FTS5). (grok)
59. `relayhistory/docs/agent-integration.md`, `docs/pair-hooks.md` — Pair contract, fail-open behavior, "vector retrieval is a future upgrade once embeddings are populated." (grok)
60. `relayfile/docs/knowledge-graph-spec.md`, `docs/knowledge-extraction-spec.md` — draft typed knowledge, cascade invalidation, TTL, path scoping, "graph as metadata, not a second store." (grok)
61. `relayfile-cloud/docs/migration-plan.md`, `relayfile/README.md`, `relayfile/package.json` — alias seeds: `relayfile`, `relayfile-cloud`, `relayfile-adapters`, `@relayfile/core`, `file.agentrelay.com`, RelayAuth. (codex)
