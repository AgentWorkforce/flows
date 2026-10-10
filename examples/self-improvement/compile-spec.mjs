#!/usr/bin/env node
// compile-spec — compile a .flow.yaml to the kernel's canonical JSON.
//
//   node compile-spec.mjs <root> <flow.yaml> <out.json> [<authored-ids.json>]
//
// The SDK's own compiler (`compileYamlToCanonicalJson`), so the before/after
// comparison is over what the kernel will execute. Not `flows build`: build
// defers command probes by throwing, and the named-gate probe reads that
// throw as a missing command, refusing any flow with a `regex_match` (or
// other named) gate — exactly the kind of edit this flow proposes.
//
// With a fourth argument it also writes the step ids the YAML itself
// declares. The compiler adds steps of its own (a named gate lowers to one,
// named <step>.gate, <step>.gate.gate on a collision, ...); a compiled id that
// is not in this list is one the compiler made, which no shape or name can
// establish on its own because an authored step can imitate both.
//
// The flow file must really live inside <root> (the target checkout): a
// symlink, anywhere on its path, that resolves outside is refused before
// anything is read.

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { sep } from "node:path";
import { loadSdk, loadYaml } from "./sdk.mjs";

const [root, source, out, authoredOut] = process.argv.slice(2);
if (!root || !source || !out) {
  console.error("usage: compile-spec.mjs <root> <flow.yaml> <out.json> [<authored-ids.json>]");
  process.exit(1);
}
const real = realpathSync(source);
if (!real.startsWith(realpathSync(root) + sep)) {
  console.error(`compile-spec: ${source} resolves to ${real}, outside ${root}; refusing to compile it`);
  process.exit(1);
}
const yaml = readFileSync(real, "utf8");
const { compileYamlToCanonicalJson } = await loadSdk();
writeFileSync(out, compileYamlToCanonicalJson(yaml));
if (authoredOut) {
  // Only after a successful compile, so the YAML is known to be a valid flow.
  const steps = loadYaml().parse(yaml).steps;
  writeFileSync(authoredOut, JSON.stringify(steps.map((s) => s.id)));
}
