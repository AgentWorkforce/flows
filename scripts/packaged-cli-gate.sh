#!/usr/bin/env bash
# Requires Node >=22.18 (native TS loading) and registry access for npm installs.
# An optional already-packed surface tarball avoids rebuilding it in the surface gate.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pack_dir="$(mktemp -d /tmp/relayflows-cli-pack.XXXXXX)"
consumer_dir="$(mktemp -d /tmp/relayflows-cli-consumer.XXXXXX)"
trap 'rm -rf "$pack_dir" "$consumer_dir"' EXIT
unset NODE_PATH NODE_OPTIONS
node -v
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 18) || (major === 23 && minor < 6)) throw new Error("packaged CLI gate requires native TypeScript loading (Node >=22.18)")'

ancestor="$(dirname "$consumer_dir")"
while :; do
  if [[ -e "$ancestor/node_modules" ]]; then
    echo "packaged CLI gate: ancestor $ancestor/node_modules would contaminate the install" >&2
    exit 1
  fi
  [[ "$ancestor" == / ]] && break
  ancestor="$(dirname "$ancestor")"
done

if [[ $# -gt 0 ]]; then
  cp "$1" "$pack_dir/surface.tgz"
else
  npm ci --prefix "$repo_root/packages/surface" --ignore-scripts --no-audit --no-fund
  npm run build --prefix "$repo_root/packages/surface"
  (cd "$repo_root/packages/surface" && npm pack --ignore-scripts --pack-destination "$pack_dir" --silent)
  mv "$pack_dir"/relayflows-surface-*.tgz "$pack_dir/surface.tgz"
fi
npm ci --prefix "$repo_root/packages/sdk" --ignore-scripts --no-audit --no-fund
npm install --prefix "$repo_root/packages/sdk" "$pack_dir/surface.tgz" --no-save --package-lock=false --ignore-scripts --no-audit --no-fund
npm run build --prefix "$repo_root/packages/sdk"
(cd "$repo_root/packages/sdk" && npm pack --ignore-scripts --pack-destination "$pack_dir" --silent)
(cd "$repo_root/packages/relayflows" && npm pack --ignore-scripts --pack-destination "$pack_dir" --silent)
mv "$pack_dir"/relayflows-sdk-*.tgz "$pack_dir/sdk.tgz"
mv "$pack_dir"/relayflows-[0-9]*.tgz "$pack_dir/cli.tgz"

cd "$consumer_dir"
node --input-type=module - "$pack_dir" <<'NODE'
import { writeFileSync } from 'node:fs';
const pack = process.argv[2];
writeFileSync('package.json', JSON.stringify({
  name: 'packaged-cli-consumer', private: true, type: 'module',
  dependencies: {
    relayflows: `file:${pack}/cli.tgz`,
    '@relayflows/sdk': `file:${pack}/sdk.tgz`,
    '@relayflows/surface': `file:${pack}/surface.tgz`,
  },
  // Force every copy to come from this checkout even when its version is published.
  overrides: { '@relayflows/sdk': '$@relayflows/sdk', '@relayflows/surface': '$@relayflows/surface' },
}));
NODE
# Nested dependencies prevent a transitive hoist (e.g. cheerio's undici) from
# accidentally satisfying an undeclared SDK import.
npm install --omit=dev --omit=optional --install-strategy=nested --ignore-scripts --no-audit --no-fund
node --experimental-import-meta-resolve --input-type=module - "$repo_root" <<'NODE'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = process.argv[2];
const wrapper = pathToFileURL(resolve('node_modules/relayflows/bin/flows.js'));
const sdkPath = fileURLToPath(import.meta.resolve('@relayflows/sdk/cli', wrapper.href));
const sdk = createRequire(sdkPath);
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
for (const [installed, local] of [
  [sdkPath, 'packages/sdk/dist/cli.js'],
  [sdk.resolve('@relayflows/surface'), 'packages/surface/dist/index.js'],
  [createRequire(resolve('package.json')).resolve('@relayflows/surface'), 'packages/surface/dist/index.js'],
]) assert.equal(hash(installed), hash(resolve(repo, local)), `wrong packed artifact: ${installed}`);
console.log('PACKED_PROVENANCE_OK sdk and surface');
NODE
mkdir -p testdata examples/pr-review-pipeline
cp "$repo_root/testdata/hello-authored.flow.ts" testdata/
cp "$repo_root/examples/pr-review-pipeline/pr-review-pipeline.flow.ts" examples/pr-review-pipeline/
# Execute the published wrapper explicitly: SDK and wrapper both expose a flows bin.
for flow in testdata/hello-authored.flow.ts examples/pr-review-pipeline/pr-review-pipeline.flow.ts; do
  node node_modules/relayflows/bin/flows.js check "$flow" | tee check.txt
  # A helper-body refusal returns before loading TypeScript. Only CHECK PASSED
  # proves we exercised the activity checker and its runtime compiler import.
  grep -q 'CHECK PASSED' check.txt
  node node_modules/relayflows/bin/flows.js check --json "$flow" > check.json
  node --input-type=module -e 'import {readFileSync} from "node:fs"; import assert from "node:assert/strict"; assert.equal(JSON.parse(readFileSync("check.json", "utf8")).ok, true); console.log("PACKED_CHECK_JSON_OK")'
done
node --experimental-import-meta-resolve --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const wrapper = pathToFileURL(resolve('node_modules/relayflows/bin/flows.js'));
const sdk = createRequire(import.meta.resolve('@relayflows/sdk/cli', wrapper.href));
const compiler = sdk.resolve('typescript/package.json');
assert.ok(compiler.startsWith(`${process.cwd()}/node_modules/`) && existsSync(compiler));
console.log('PACKAGED_CLI_OK');
NODE
