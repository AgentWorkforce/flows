#!/usr/bin/env node
// collect-runs — fetch the last N terminal runs of one flow from Cloud and
// write the evidence the analyst agent reads.
//
//   node collect-runs.mjs --flow <name> --runs <n> --scan <m> --out <dir>
//                         [--api-url <url>] [--fixture <file>]
//
// Reads only, through the SDK's own read API: `listCloudRuns` to find the
// flow's runs (the route has no flow filter, so the newest <m> runs are
// scanned and filtered by name here), then `getCloudRunSteps` per run. The
// credential is the SDK's: FLOWS_CLOUD_TOKEN, else the `agent-relay cloud
// login` store. It must be a workspace `workflow` token — a run-scoped
// sandbox token can only read its own run (docs/CLOUD.md, "Reading a run").
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
if (!Number.isSafeInteger(want) || want < 1 || want > 50) fail("--runs must be an integer 1-50");
if (!Number.isSafeInteger(scan) || scan < want || scan > 1000) fail("--scan must be an integer between --runs and 1000");

async function fromCloud() {
  const sdk = await loadSdk();
  const options = args["api-url"] ? { apiUrl: args["api-url"] } : {};
  const { runs: listed } = await sdk.listCloudRuns(scan, options);
  const mine = listed
    .filter((run) => run.name === args.flow && TERMINAL_RUN_STATUSES.has(run.status))
    .slice(0, want);
  const runs = [];
  // Sequential on purpose: N is at most 50, and a burst of step reads is the
  // one thing this flow could do to Cloud that a person would notice.
  for (const run of mine) runs.push({ ...run, steps: await sdk.getCloudRunSteps(run.run_id, options) });
  return runs;
}

function fromFixture() {
  const body = JSON.parse(readFileSync(args.fixture, "utf8"));
  if (!Array.isArray(body.runs)) fail(`${args.fixture} carries no runs array`);
  return body.runs
    .filter((run) => run.name === args.flow && TERMINAL_RUN_STATUSES.has(run.status))
    .slice(0, want);
}

const runs = args.fixture ? fromFixture() : await fromCloud();
if (runs.length === 0) fail(`no completed or failed runs of "${args.flow}" among the newest ${scan}`);

mkdirSync(args.out, { recursive: true });
writeFileSync(join(args.out, "runs.json"), JSON.stringify({ flow: args.flow, runs: runs.map(compactRun) }, null, 2));
const digest = { flow: args.flow, ...digestRuns(runs) };
writeFileSync(join(args.out, "digest.json"), JSON.stringify(digest, null, 2));
const top = digest.steps[0];
console.log(`collected ${runs.length} runs of ${args.flow}; top step ${top?.step ?? "(none)"} `
  + `(${top?.primary_signal ?? "-"}, leverage ${top?.leverage ?? 0})`);
