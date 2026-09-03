# Research synthesis

Three independent research lanes, each run by a different model vendor with
two subagents, have answered the same question. Read all three reports in
full, then write ONE synthesis. You are the editor, not a fourth researcher:
do not run new searches except to resolve a direct factual conflict between
lanes.

SYNTHESIS PATH (write your synthesis here, exactly): /Users/khaliqgant/Projects/AgentWorkforce/flows/research/runs/2026-09-02-agent-memory/SYNTHESIS.md

Reports:
- claude: /Users/khaliqgant/Projects/AgentWorkforce/flows/research/runs/2026-09-02-agent-memory/claude/report.md
- codex: /Users/khaliqgant/Projects/AgentWorkforce/flows/research/runs/2026-09-02-agent-memory/codex/report.md
- grok: /Users/khaliqgant/Projects/AgentWorkforce/flows/research/runs/2026-09-02-agent-memory/grok/report.md

## The research question

# Agent memory for a cloud agent: best-in-class design and what to leverage

## The situation

We run coding agents (Claude Code, Codex, Grok, Cursor, agent-relay) across
many repositories. Their sessions are captured by `ai-hist` (the
`../relayhistory` repo: a Rust CLI over local SQLite with FTS5, an MCP server
exposing `search_history` / `get_context` / `search_trajectories` /
`why_for_task`, and distilled trajectories — decisions with reasoning and
alternatives, retrospectives with learnings and confidence). Sessions are
pushed to a hosted store (`../relayhistory-cloud`; read
`docs/product-direction.md` there first — its direction is a vendor-readable
Neon + pgvector convergence store with a Learn / Plan / Pair layer on top,
and an E2E opaque tier for enterprise).

Our execution engine is Relayflows (`docs/RFC-0001-everything-is-a-relayflow.md`
in this repo; read gate 5, "a relayflow has memory", and the `f.memory`
helper in `docs/SURFACE.md`). Gate 5 says: before a step, an agent receives
a context pack (`ai-hist pack` / `why_for_task`); after, its trajectory is
distilled back (`ai-hist learn`); `pair` serves cited warnings mid-session.
Memory tokens are charged to the consuming step. Agents are ephemeral: no
agent outlives its step, so memory is the only continuity an agent has.

## The concrete proof point

We want a **relayfile cloud agent** (relayfile is one of our repos and
services; the agent is scoped to it) that continuously sifts through ALL
sessions pushed to the cloud — across every repo and every tool — and
collects the items that matter to its own project: dependency changes,
API or contract changes in sibling services, decisions taken elsewhere that
touch relayfile, incidents, and repeated mistakes. It stores that in its
memory so that when it wakes for a task it knows exactly what is going on
in the neighborhood and how it impacts its repo, and can cite where it
learned it.

## The research questions

1. What is the best-in-class way to accomplish this today? Be concrete:
   ingestion, extraction of "what matters to project X" from raw sessions,
   memory representation (episodic / semantic / procedural; flat notes vs
   knowledge graph vs temporal graph), consolidation and forgetting, and
   retrieval at wake time under a token budget.
2. What are the emerging agent memory best practices from the last ~18
   months — in research (e.g. memory architectures for LLM agents,
   temporal knowledge graphs, reflection/consolidation, long-horizon
   evaluation) and in practice (Mem0, Letta/MemGPT, Zep/Graphiti, LangMem,
   Claude Code's memory, Codex and Cursor memory features, and whatever
   else is credible)? Which are consensus, which are contested, which are
   marketing?
3. What can we leverage — libraries, services, open-source components,
   evaluation harnesses, and prior art already in `../relayhistory` and
   `../relayhistory-cloud` — to build a best-in-class memory retrieval
   system, given our constraints: Postgres + pgvector on Neon as the default
   store, SQLite locally, Rust core with a TypeScript SDK, everything
   journaled and budgeted per step, and citations required in the output?

Ground the applied half in the local repositories named above; they are on
this machine at `../relayhistory` and `../relayhistory-cloud` relative to
this repo, and this repo is `AgentWorkforce/flows`.

## Required structure of the synthesis

1. **Recommendation** — at most 250 words. What we should build, in order.
2. **Where the lanes agree** — the consensus, each point tagged with the
   lanes that made it, e.g. `(claude, codex, grok)`.
3. **Where the lanes disagree** — each disagreement stated fairly, with the
   lane attribution, and your ruling with the reason.
4. **Single-source claims** — points only one lane made; keep the ones that
   matter and say which lane they came from.
5. **The plan** — a concrete, phased design for the system described in the
   question: data model, write path, retrieval, consolidation, evaluation,
   and how it maps onto the repositories named in the question.
6. **Leverage, ranked** — libraries, services, and prior art worth adopting,
   ranked, with the fit assessment and which lane(s) surfaced each.
7. **Open questions** — merged and deduplicated.
8. **Sources** — the union of the lanes' verified sources, numbered, URL per
   entry. Do not include a source no lane marked verified unless you fetched
   it yourself.

Preserve citations. Do not soften a disagreement into agreement. When the
file is written, print one final line on stdout:

    RESEARCH_SYNTHESIS_WRITTEN
