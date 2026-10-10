#!/usr/bin/env node
// compile-spec — compile a .flow.yaml to the kernel's canonical JSON.
//
//   node compile-spec.mjs <flow.yaml> <out.json>
//
// The SDK's own compiler (`compileYamlToCanonicalJson`), so the before/after
// comparison is over what the kernel will execute. Not `flows build`: build
// defers command probes by throwing, and the named-gate probe reads that
// throw as a missing command, refusing any flow with a `regex_match` (or
// other named) gate — exactly the kind of edit this flow proposes.

import { readFileSync, writeFileSync } from "node:fs";
import { loadSdk } from "./sdk.mjs";

const [source, out] = process.argv.slice(2);
if (!source || !out) {
  console.error("usage: compile-spec.mjs <flow.yaml> <out.json>");
  process.exit(1);
}
const { compileYamlToCanonicalJson } = await loadSdk();
writeFileSync(out, compileYamlToCanonicalJson(readFileSync(source, "utf8")));
