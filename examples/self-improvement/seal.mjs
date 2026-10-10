#!/usr/bin/env node
// seal — tamper evidence for files an agent could reach between two steps.
//
//   node seal.mjs seal <file>...      prints {"<file>": "<sha256>", ...}
//   node seal.mjs verify '<json>'     exits 1 naming every file that changed
//
// `permissions.accessPreset` is recorded, not enforced, so an agent can write
// anywhere the run can. The flow seals evidence once it is produced and puts
// the seal into the *command text* of every later check — journaled, out of
// any agent's reach — so a check never runs on inputs an agent rewrote.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const [verb, ...rest] = process.argv.slice(2);

if (verb === "seal" && rest.length > 0) {
  console.log(JSON.stringify(Object.fromEntries(rest.map((f) => [f, sha(f)]))));
} else if (verb === "verify" && rest.length === 1) {
  const changed = Object.entries(JSON.parse(rest[0])).filter(([file, want]) => {
    try { return sha(file) !== want; } catch { return true; }
  });
  if (changed.length > 0) {
    console.error(`seal: changed since sealed (refusing to judge tampered evidence): ${changed.map(([f]) => f).join(", ")}`);
    process.exit(1);
  }
} else {
  console.error("usage: seal.mjs seal <file>... | verify '<json>'");
  process.exit(1);
}
