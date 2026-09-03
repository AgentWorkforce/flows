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
