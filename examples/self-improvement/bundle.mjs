#!/usr/bin/env node
// bundle — embed the helper scripts in self-improvement.flow.ts.
//
//   node bundle.mjs --write   regenerate the flow's HELPERS constant
//   node bundle.mjs --check   exit 1 if the constant is stale (the test runs this)
//
// Cloud runs a .flow.ts as one self-contained source: local imports and code
// sync are refused, and a scheduled fire replays the stored source
// (docs/CLOUD.md, "Schedules"), so sibling scripts never reach the sandbox.
// The flow therefore carries them as base64 JSON and writes them out itself.
// That also puts them out of the agents' reach: they are re-materialized from
// the flow's own source right before every check, so an agent that edits a
// copy on disk changes nothing the next check runs. The .mjs files beside
// this script are the source of truth; edit them, then --write.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const HELPER_FILES = ["sdk.mjs", "digest.mjs", "spec-diff.mjs", "seal.mjs", "collect-runs.mjs", "compile-spec.mjs", "check-proposal.mjs"];
const here = fileURLToPath(new URL(".", import.meta.url));
const flowPath = join(here, "self-improvement.flow.ts");
const LINE = /^const HELPERS = "[A-Za-z0-9+/=]*";$/mu;

export function encoded() {
  const files = Object.fromEntries(HELPER_FILES.map((name) => [name, readFileSync(join(here, name), "utf8")]));
  return Buffer.from(JSON.stringify(files)).toString("base64");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flow = readFileSync(flowPath, "utf8");
  if (!LINE.test(flow)) { console.error("bundle: no `const HELPERS = \"...\";` line in the flow"); process.exit(1); }
  const line = `const HELPERS = "${encoded()}";`;
  if (process.argv.includes("--write")) writeFileSync(flowPath, flow.replace(LINE, line));
  else if (flow.match(LINE)[0] !== line) {
    console.error("bundle: self-improvement.flow.ts embeds stale helpers; run `node examples/self-improvement/bundle.mjs --write`");
    process.exit(1);
  }
}
