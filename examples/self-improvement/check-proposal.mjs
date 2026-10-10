#!/usr/bin/env node
// check-proposal — the deterministic gates between the agents and the PR.
//
//   node check-proposal.mjs proposal --dir <improve> --spec <before spec json>
//   node check-proposal.mjs edit --dir <improve> --flow-path <path> --changed <file>
//                                --before <spec json> --after <spec json>
//
// `proposal` refuses a proposal.json that is malformed, names a step the flow
// does not have, or cites a run that was not collected. `edit` repeats every
// proposal check (the proposal is re-read after an agent with write access
// has run), then refuses an edit that touched any file but the flow, that
// lacks a prompt change or a structural change in the compiled spec, or whose
// compiled changes are not exactly the proposal's: each prompt by its exact
// new text, each structural change by step and field (spec-diff.mjs `coverage`).
// On success it writes <dir>/pr-body.md. Every refusal names what was wrong,
// on stderr, so the agent can be handed it verbatim.
//
// Tampering with these inputs between steps is caught by the flow's seals
// (seal.mjs), not here; this script trusts the files it is pointed at.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { FLOW, coverage, describeChange, diffSpecs } from "./spec-diff.mjs";

const SIGNALS = new Set(["failing", "slow", "costly", "weak"]);
/** The flow schema puts no pattern on step ids; refuse only what cannot be one. */
const STEP_ID = /^[^\p{Cc}]{1,200}$/u;
const FIELD = /^[a-z][a-z0-9_]{0,63}$/u;

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
  for (const e of p.prompt_edits ?? []) need(text(e.step, 200) && text(e.new_text, 20000) && text(e.rationale), "each prompt edit needs step, new_text (the complete new prompt), rationale");
  need(Array.isArray(p.structure_edits) && p.structure_edits.length > 0, "structure_edits must propose at least one structural change");
  for (const e of p.structure_edits ?? []) {
    need(typeof e.step === "string" && (e.step === FLOW || STEP_ID.test(e.step)) && FIELD.test(e.field ?? "") && text(e.change) && text(e.rationale),
      `each structure edit needs step (a step id, a new step's id, or "${FLOW}"), field (the compiled-spec key it changes, `
        + `e.g. max_iterations, verification, depends_on, added, removed), change, rationale`);
  }
  const h = p.hypothesis ?? {};
  for (const key of ["before", "after", "metric", "expected", "falsified_if"]) need(text(h[key]), `hypothesis.${key} must be non-empty`);
}

/** Every check a proposal must pass, against the flow as it was before any edit. */
function checkProposal(proposal, beforeSpec) {
  checkShape(proposal);
  const steps = new Set(beforeSpec.steps.map((s) => s.id));
  const added = new Set((proposal.structure_edits ?? []).filter((e) => e.field === "added").map((e) => e.step));
  need(steps.has(proposal.target_step), `target_step "${proposal.target_step}" is not a step of the flow`);
  for (const e of proposal.prompt_edits ?? []) {
    need(steps.has(e.step) || added.has(e.step), `prompt edit names step "${e.step}", which neither exists nor is added by a structure edit`);
  }
  for (const e of proposal.structure_edits ?? []) {
    if (e.step === FLOW) continue;
    if (e.field === "added") need(!steps.has(e.step), `structure edit adds step "${e.step}", which already exists`);
    else need(steps.has(e.step), `structure edit ${e.step}.${e.field} names a step the flow does not have (to create it, use field "added")`);
  }
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
    lines.push("| executions | failures | weak | p50 ms | p95 ms | mean $ (as reported) | leverage |", "|---|---|---|---|---|---|---|",
      `| ${row.executions} | ${row.failures} | ${row.weak} | ${row.p50_ms ?? "–"} | ${row.p95_ms ?? "–"} | `
        + `${row.mean_cost_usd === null ? "–" : row.mean_cost_usd.toFixed(4)} | ${row.leverage} |`, "");
  }
  for (const e of proposal.evidence) lines.push(`- \`${e.run_id}\`: ${e.observation}`);
  lines.push("", "## Prompt edits", "");
  for (const e of proposal.prompt_edits) lines.push(`- \`${e.step}\` — ${e.rationale}`, "", "  ```text", ...e.new_text.split("\n").map((l) => `  ${l}`), "  ```");
  lines.push("", "## Structure edits", "");
  for (const e of proposal.structure_edits) lines.push(`- \`${e.step}.${e.field}\`: ${e.change} — ${e.rationale}`);
  lines.push("", "## Compiled-spec diff (checked against the proposal)", "");
  for (const p of diff.prompt) lines.push(`- prompt: step \`${p.step}\` ${p.field}`);
  for (const s of diff.structure) lines.push(`- structure: ${describeChange(s)}`);
  lines.push("", "Not replayed, not deployed. A human reviews and merges; deploying the merged flow is a separate, manual step.");
  return lines.join("\n") + "\n";
}

function stageEdit() {
  const proposal = readJson(join(args.dir, "proposal.json"));
  const before = readJson(args.before);
  checkProposal(proposal, before);
  const changed = readFileSync(args.changed, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  need(changed.length === 1 && changed[0] === args["flow-path"],
    `the edit must change exactly ${args["flow-path"]}; it changed: ${changed.join(", ") || "(nothing)"}`);
  const after = readJson(args.after);
  const diff = diffSpecs(before, after);
  need(diff.prompt.length > 0, "the compiled flow has no prompt (instruction/prompt) change");
  need(diff.structure.length > 0, "the compiled flow has no structural change (steps, dependsOn, verification, retries, timeouts, budget…)");
  for (const problem of coverage(diff, proposal, after, before)) problems.push(problem);
  if (problems.length === 0) {
    writeFileSync(join(args.dir, "pr-body.md"), prBody(proposal, diff, readJson(join(args.dir, "digest.json"))));
    console.log(`prompt edits: ${diff.prompt.length}; structural edits: ${diff.structure.length}`);
  }
}

if (stage === "proposal") checkProposal(readJson(join(args.dir, "proposal.json")), readJson(args.spec));
else if (stage === "edit") stageEdit();
else problems.push("stage must be `proposal` or `edit`");

if (problems.length > 0) {
  console.error(problems.map((p) => `- ${p}`).join("\n"));
  process.exit(1);
}
