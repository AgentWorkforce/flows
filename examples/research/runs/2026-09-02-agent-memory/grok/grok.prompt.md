# Research lane: grok

REPORT PATH (write your final report here, exactly): /Users/khaliqgant/Projects/AgentWorkforce/flows/research/runs/2026-09-02-agent-memory/grok/report.md

## Research protocol (identical for every lane)

You are the lead researcher on ONE lane of a three-lane research flow. Two
other lanes, run by different model vendors, are answering the same question
independently. A synthesis step will merge the three reports and attribute
disagreements to lanes, so be precise about what you verified and what you
inferred. Your report is judged on accuracy and specificity, not length.

### Step 1 — spawn exactly two subagents, in parallel

Use your subagent / task-delegation capability to launch BOTH of these at the
same time. Give each the full research question verbatim plus its brief.

**Subagent A — Landscape.** Survey what exists and what is emerging:
research papers, open-source frameworks, vendor products, and practitioner
write-ups from roughly the last 18 months, plus the canonical older work
they build on. For each source record: URL, one line on what it contributes,
and whether you actually fetched it. Separate (a) practices with broad
consensus, (b) contested or emerging practices, and (c) claims that are
mostly marketing. Prefer primary sources (papers, docs, code) over
summaries of them. Do not invent URLs; if you cannot fetch a source, say so.

**Subagent B — Applied.** Design for the concrete situation in the question.
If local repositories or paths are named, READ them (they are on this
machine) and ground the design in what is actually there: data shapes,
existing commands, storage, and constraints. Produce a concrete
architecture: components, data flow, storage, retrieval pipeline, write
path, consolidation/forgetting, and evaluation. Name specific libraries or
services we could adopt and assess fit honestly (maintenance, license,
lock-in, operational cost). List failure modes and how to detect them.

### Step 2 — verify and merge

When both return: spot-check the top claims and sources yourself (fetch at
least three of the most load-bearing sources). Drop anything you cannot
stand behind. Where the two subagents disagree, resolve it or record the
disagreement explicitly.

### Step 3 — write the report

Write the report as Markdown to the exact REPORT PATH given above. Create
the file with your file-writing tool; do not only print it. Required
sections, in this order:

1. **Executive summary** — at most 200 words; the recommendation first.
2. **Landscape and best practices** — with inline citations `[n]`.
3. **Recommended approach** — concrete enough to start building from.
4. **Trade-offs and risks** — including what would make this wrong.
5. **What we can leverage** — existing libraries, services, prior art in
   the named repos; each with a one-line fit assessment.
6. **Open questions** — what a follow-up should settle.
7. **Sources** — numbered list, URL per entry, marked `verified` (fetched)
   or `unverified`.

Target 1,500–4,000 words. Cite specific files and paths when you read local
code. Never fabricate a citation, benchmark, or feature: an honest "not
found" is worth more than a plausible guess.

When the file is written, print one final line on stdout:

    RESEARCH_REPORT_WRITTEN

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
