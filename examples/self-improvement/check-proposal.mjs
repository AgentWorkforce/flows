#!/usr/bin/env node
// check-proposal — the deterministic gates between the agents and the PR.
//
//   node check-proposal.mjs proposal --dir <improve> --spec <before spec.canonical.json>
//   node check-proposal.mjs edit --dir <improve> --flow-path <path> --changed <file>
//                                --before <spec.canonical.json> --after <spec.canonical.json>
//
// `proposal` refuses a proposal.json that is malformed, targets a step the
// flow does not have, or cites a run that was not collected. `edit` refuses an
// edit that touched any file but the flow, or that does not change BOTH a
// prompt and the flow's structure in the compiled spec; on success it writes
// <dir>/pr-body.md. Every refusal names what was wrong, on stderr, so the
// editor agent can be handed it verbatim.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { diffSpecs } from "./spec-diff.mjs";

const SIGNALS = new Set(["failing", "slow", "costly", "weak"]);

const { positionals: [stage], values: args } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: "string" }, spec: { type: "string" }, "flow-path": { type: "string" },
    changed: { type: "string" }, before: { type: "string" }, after: { type: "string" },
  },
});

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const problems = [];
const need = (ok, message) => { if (!ok) problems.push(message); };
const text = (value, max = 4000) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

function checkShape(p) {
  need(text(p.target_step, 200), "target_step must be a step id");
  need(SIGNALS.has(p.signal), `signal must be one of ${[...SIGNALS].join(", ")}`);
  need(text(p.diagnosis), "diagnosis must be non-empty prose");
  need(Array.isArray(p.evidence) && p.evidence.length > 0, "evidence must cite at least one run");
  for (const e of p.evidence ?? []) need(text(e.run_id, 100) && text(e.observation), "each evidence entry needs run_id and observation");
  need(Array.isArray(p.prompt_edits) && p.prompt_edits.length > 0, "prompt_edits must propose at least one prompt change");
  for (const e of p.prompt_edits ?? []) need(text(e.step, 200) && text(e.change) && text(e.rationale), "each prompt edit needs step, change, rationale");
  need(Array.isArray(p.structure_edits) && p.structure_edits.length > 0, "structure_edits must propose at least one structural change");
  for (const e of p.structure_edits ?? []) need(text(e.change) && text(e.rationale), "each structure edit needs change, rationale");
  const h = p.hypothesis ?? {};
  for (const key of ["before", "after", "metric", "expected", "falsified_if"]) need(text(h[key]), `hypothesis.${key} must be non-empty`);
}

function stageProposal() {
  const proposal = readJson(join(args.dir, "proposal.json"));
  checkShape(proposal);
  const steps = new Set(readJson(args.spec).steps.map((s) => s.id));
  need(steps.has(proposal.target_step), `target_step "${proposal.target_step}" is not a step of the flow`);
  for (const e of proposal.prompt_edits ?? []) need(steps.has(e.step), `prompt edit names unknown step "${e.step}"`);
  const collected = new Set(readJson(join(args.dir, "runs.json")).runs.map((r) => r.run_id));
  for (const e of proposal.evidence ?? []) need(collected.has(e.run_id), `evidence cites run "${e.run_id}", which was not collected`);
}

function prBody(proposal, diff, digest) {
  const row = digest.steps.find((s) => s.step === proposal.target_step);
  const h = proposal.hypothesis;
  const lines = [
    `Automated proposal from the \`self-improvement\` flow, over the last ${digest.runs} terminal runs of \`${digest.flow}\`.`,
    "",
    `**Target step:** \`${proposal.target_step}\` — signal: **${proposal.signal}**`,
    "",
    proposal.diagnosis,
    "",
    "## Hypothesis",
    "",
    `- **Before:** ${h.before}`,
    `- **After:** ${h.after}`,
    `- **Metric:** ${h.metric}`,
    `- **Expected:** ${h.expected}`,
    `- **Falsified if:** ${h.falsified_if}`,
    "",
    "## Evidence",
    "",
  ];
  if (row) {
    lines.push("| executions | failures | weak | p50 ms | p95 ms | mean $ | leverage |", "|---|---|---|---|---|---|---|",
      `| ${row.executions} | ${row.failures} | ${row.weak} | ${row.p50_ms ?? "–"} | ${row.p95_ms ?? "–"} | `
        + `${row.mean_cost_usd === null ? "–" : row.mean_cost_usd.toFixed(4)} | ${row.leverage} |`, "");
  }
  for (const e of proposal.evidence) lines.push(`- \`${e.run_id}\`: ${e.observation}`);
  lines.push("", "## Prompt edits", "");
  for (const e of proposal.prompt_edits) lines.push(`- \`${e.step}\`: ${e.change} — ${e.rationale}`);
  lines.push("", "## Structure edits", "");
  for (const e of proposal.structure_edits) lines.push(`- ${e.change} — ${e.rationale}`);
  lines.push("", "## Compiled-spec diff (checked)", "");
  for (const p of diff.prompt) lines.push(`- prompt: step \`${p.step}\` ${p.field}`);
  for (const s of diff.structure) lines.push(`- structure: ${s}`);
  lines.push("", "Not replayed, not deployed. A human reviews and merges; deploying the merged flow is a separate, manual step.");
  return lines.join("\n") + "\n";
}

function stageEdit() {
  const proposal = readJson(join(args.dir, "proposal.json"));
  checkShape(proposal);
  const changed = readFileSync(args.changed, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  need(changed.length === 1 && changed[0] === args["flow-path"],
    `the edit must change exactly ${args["flow-path"]}; it changed: ${changed.join(", ") || "(nothing)"}`);
  const diff = diffSpecs(readJson(args.before), readJson(args.after));
  need(diff.prompt.length > 0, "the compiled flow has no prompt (instruction/prompt) change");
  need(diff.structure.length > 0, "the compiled flow has no structural change (steps, dependsOn, verification, retries, timeouts, budget…)");
  if (problems.length === 0) {
    writeFileSync(join(args.dir, "pr-body.md"), prBody(proposal, diff, readJson(join(args.dir, "digest.json"))));
    console.log(`prompt edits: ${diff.prompt.length}; structural edits: ${diff.structure.length}`);
  }
}

if (stage === "proposal") stageProposal();
else if (stage === "edit") stageEdit();
else problems.push("stage must be `proposal` or `edit`");

if (problems.length > 0) {
  console.error(problems.map((p) => `- ${p}`).join("\n"));
  process.exit(1);
}
