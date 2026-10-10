#!/usr/bin/env node
// collect-runs — fetch the last N terminal runs of one flow from Cloud and
// write the evidence the analyst agent reads.
//
//   node collect-runs.mjs --flow <name> --spec <spec json> --runs <n> --scan <m>
//                         --out <dir> [--api-url <url>] [--fixture <file>]
//
// Reads only, through the SDK's own read API: `listCloudRuns` to find the
// flow's runs (the route has no flow filter, so the newest <m> runs are
// scanned and filtered by name here), then `getCloudRunSteps` per run. The
// credential is the SDK's: FLOWS_CLOUD_TOKEN, else the `agent-relay cloud
// login` store. It must be a workspace `workflow` token — a run-scoped
// sandbox token can only read its own run (docs/CLOUD.md, "Reading a run").
//
// Cloud's run list carries no flow identity beyond the declared name, so two
// flows that share a name (in two repositories, say) would pool their runs.
// --spec is the target's compiled spec: a run is kept only when at least half
// of the steps it executed are steps of that spec, and the runs dropped are
// counted in runs.json. That tolerates the target's own history (a step added
// or renamed since) while refusing a different flow wearing the same name.
//
// --fixture reads `{ runs: [{ run_id, name, status, ..., steps: CloudStep[] }] }`
// from disk instead, so the flow can be exercised with no Cloud at all.
//
// Writes <out>/runs.json (compact per-run, per-step rows) and
// <out>/digest.json (per-step leverage ranking). Exits nonzero, writing
// nothing, when fewer than one terminal run is found.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { TERMINAL_RUN_STATUSES, compactRun, digestRuns } from "./digest.mjs";
import { loadSdk } from "./sdk.mjs";

const { values: args } = parseArgs({
  options: {
    flow: { type: "string" },
    spec: { type: "string" },
    runs: { type: "string", default: "10" },
    scan: { type: "string", default: "200" },
    out: { type: "string" },
    "api-url": { type: "string" },
    fixture: { type: "string" },
  },
});

function fail(message) {
  console.error(`collect-runs: ${message}`);
  process.exit(1);
}

const want = Number(args.runs);
const scan = Number(args.scan);
if (!args.flow) fail("--flow is required");
if (!args.out) fail("--out is required");
if (!args.spec) fail("--spec is required");
if (!Number.isSafeInteger(want) || want < 1 || want > 50) fail("--runs must be an integer 1-50");
if (!Number.isSafeInteger(scan) || scan < want || scan > 1000) fail("--scan must be an integer between --runs and 1000");

const ids = new Set(JSON.parse(readFileSync(args.spec, "utf8")).steps.map((s) => s.id));
const candidate = (run) => run.name === args.flow && TERMINAL_RUN_STATUSES.has(run.status);
const ours = (steps) => {
  const ran = steps.filter((s) => !["pending", "skipped", "queued", "unknown"].includes(s.status));
  return ran.length > 0 && ran.filter((s) => ids.has(s.step_name)).length * 2 >= ran.length;
};

/**
 * Newest first until `want` runs of this flow are in hand. Foreign runs are
 * dropped before they count, so a busy namesake cannot crowd the target out.
 * Sequential on purpose: a burst of step reads is the one thing this flow
 * could do to Cloud that a person would notice.
 */
async function collect(listed, stepsOf) {
  const runs = [];
  let dropped = 0;
  for (const run of listed.filter(candidate)) {
    if (runs.length === want) break;
    const steps = await stepsOf(run);
    if (ours(steps)) runs.push({ ...run, steps });
    else dropped += 1;
  }
  return { runs, dropped };
}

async function fromCloud() {
  const sdk = await loadSdk();
  const options = args["api-url"] ? { apiUrl: args["api-url"] } : {};
  const { runs: listed } = await sdk.listCloudRuns(scan, options);
  return collect(listed, (run) => sdk.getCloudRunSteps(run.run_id, options));
}

function fromFixture() {
  const body = JSON.parse(readFileSync(args.fixture, "utf8"));
  if (!Array.isArray(body.runs)) fail(`${args.fixture} carries no runs array`);
  return collect(body.runs.slice(0, scan), async (run) => run.steps);
}

const { runs, dropped } = args.fixture ? await fromFixture() : await fromCloud();
if (runs.length === 0) fail(`no completed or failed runs of "${args.flow}" among the newest ${scan} match its steps`);

mkdirSync(args.out, { recursive: true });
writeFileSync(join(args.out, "runs.json"), JSON.stringify(
  { flow: args.flow, dropped_foreign: dropped, runs: runs.map(compactRun) }, null, 2));
const digest = { flow: args.flow, ...digestRuns(runs) };
writeFileSync(join(args.out, "digest.json"), JSON.stringify(digest, null, 2));
const top = digest.steps[0];
console.log(`collected ${runs.length} runs of ${args.flow} (${dropped} same-named foreign runs dropped); top step ${top?.step ?? "(none)"} `
  + `(${top?.primary_signal ?? "-"}, leverage ${top?.leverage ?? 0})`);
