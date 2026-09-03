// Pure brief builders for research.flow.ts. No I/O: a brief is a function of
// (question, paths), so the same inputs always produce the same task string
// and the flow body stays a deterministic script over agent steps.

import type { Lane } from "./research.flow.ts";

const PROTOCOL = `## Research protocol (identical for every lane)

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
2. **Landscape and best practices** — with inline citations \`[n]\`.
3. **Recommended approach** — concrete enough to start building from.
4. **Trade-offs and risks** — including what would make this wrong.
5. **What we can leverage** — existing libraries, services, prior art in
   the named repos; each with a one-line fit assessment.
6. **Open questions** — what a follow-up should settle.
7. **Sources** — numbered list, URL per entry, marked \`verified\` (fetched)
   or \`unverified\`.

Target 1,500–4,000 words. Cite specific files and paths when you read local
code. Never fabricate a citation, benchmark, or feature: an honest "not
found" is worth more than a plausible guess.

When the file is written, print one final line on stdout:

    RESEARCH_REPORT_WRITTEN`;

export function laneBrief(lane: Lane, question: string, reportPath: string): string {
  return `# Research lane: ${lane}

REPORT PATH (write your final report here, exactly): ${reportPath}

${PROTOCOL}

## The research question

${question.trim()}
`;
}

export function synthesisBrief(
  question: string,
  reports: Record<Lane, string>,
  synthesisPath: string,
): string {
  const reportList = (Object.keys(reports) as Lane[])
    .map((lane) => `- ${lane}: ${reports[lane]}`)
    .join("\n");
  return `# Research synthesis

Three independent research lanes, each run by a different model vendor with
two subagents, have answered the same question. Read all three reports in
full, then write ONE synthesis. You are the editor, not a fourth researcher:
do not run new searches except to resolve a direct factual conflict between
lanes.

SYNTHESIS PATH (write your synthesis here, exactly): ${synthesisPath}

Reports:
${reportList}

## The research question

${question.trim()}

## Required structure of the synthesis

1. **Recommendation** — at most 250 words. What we should build, in order.
2. **Where the lanes agree** — the consensus, each point tagged with the
   lanes that made it, e.g. \`(claude, codex, grok)\`.
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
`;
}
