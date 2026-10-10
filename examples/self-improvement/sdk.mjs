// sdk — load the @relayflows/sdk the running `flows` CLI ships with, so the
// helpers and the runtime are one version.
//
// RELAYFLOWS_SDK (a path to the SDK's dist/index.js) wins; then a plain import
// (a project that depends on @relayflows/sdk); then the copy inside the
// installed `relayflows` package that owns `flows` on PATH.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Absolute path of the SDK's ESM entry. */
function sdkEntry() {
  if (process.env.RELAYFLOWS_SDK) return process.env.RELAYFLOWS_SDK;
  try {
    return fileURLToPath(import.meta.resolve("@relayflows/sdk"));
  } catch { /* not a project dependency; fall through to the CLI's copy */ }
  let bin;
  try {
    bin = execFileSync("sh", ["-c", "command -v flows"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("cannot find @relayflows/sdk: install the CLI (npm i -g relayflows) or set RELAYFLOWS_SDK");
  }
  // The SDK exports only an `import` condition, so `require.resolve` cannot
  // find it: look for it nested under the CLI's package, then hoisted beside it.
  const cli = join(dirname(realpathSync(bin)), "..");
  const dir = [join(cli, "node_modules", "@relayflows", "sdk"), join(cli, "..", "@relayflows", "sdk")].find((d) => existsSync(join(d, "package.json")));
  if (dir === undefined) throw new Error(`cannot find @relayflows/sdk beside the flows CLI at ${cli}; set RELAYFLOWS_SDK`);
  const entry = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).exports?.["."]?.import;
  if (typeof entry !== "string") throw new Error(`@relayflows/sdk at ${dir} declares no ESM entry; set RELAYFLOWS_SDK`);
  return join(dir, entry);
}

export async function loadSdk() {
  return import(pathToFileURL(sdkEntry()).href);
}

/** The YAML parser the SDK's own compiler uses (`yaml`, an SDK dependency). */
export function loadYaml() {
  return createRequire(sdkEntry())("yaml");
}
