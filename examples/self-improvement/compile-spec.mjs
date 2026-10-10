#!/usr/bin/env node
// compile-spec — compile a .flow.yaml to the kernel's canonical JSON.
//
//   node compile-spec.mjs <root> <flow.yaml> <out.json>
//
// The SDK's own compiler (`compileYamlToCanonicalJson`), so the before/after
// comparison is over what the kernel will execute. Not `flows build`: build
// defers command probes by throwing, and the named-gate probe reads that
// throw as a missing command, refusing any flow with a `regex_match` (or
// other named) gate — exactly the kind of edit this flow proposes.
//
// The flow file must really live inside <root> (the target checkout): a
// symlink, anywhere on its path, that resolves outside is refused before
// anything is read.

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { sep } from "node:path";
import { loadSdk } from "./sdk.mjs";

const [root, source, out] = process.argv.slice(2);
if (!root || !source || !out) {
  console.error("usage: compile-spec.mjs <root> <flow.yaml> <out.json>");
  process.exit(1);
}
const real = realpathSync(source);
if (!real.startsWith(realpathSync(root) + sep)) {
  console.error(`compile-spec: ${source} resolves to ${real}, outside ${root}; refusing to compile it`);
  process.exit(1);
}
const { compileYamlToCanonicalJson } = await loadSdk();
writeFileSync(out, compileYamlToCanonicalJson(readFileSync(real, "utf8")));
