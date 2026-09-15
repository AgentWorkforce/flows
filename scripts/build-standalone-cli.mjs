#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const target = args[0], outfile = args[1];
if (!/^bun-(linux-x64|darwin-arm64)$/.test(target ?? '') || !outfile) {
  throw new Error('usage: build-standalone-cli.mjs <bun-linux-x64|bun-darwin-arm64> <outfile>');
}
const stage = await mkdtemp(join(tmpdir(), 'flows-standalone-'));
function bun(args) {
  const result = spawnSync(process.env.FLOWS_BUILD_BUN ?? 'bun', args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('standalone CLI build failed');
}
try {
  const payload = join(stage, 'authored-node.mjs');
  bun(['build', 'packages/sdk/src/authored-node-entry.ts', '--target=node', '--outfile='+payload]);
  const entry = join(stage, 'standalone.ts');
  await writeFile(entry, `
import { installAuthoredNodeSource } from ${JSON.stringify(join(root, 'packages/sdk/src/authored-node-runner.ts'))};
import { runCli } from ${JSON.stringify(join(root, 'packages/sdk/src/cli.ts'))};
installAuthoredNodeSource(${JSON.stringify(await readFile(payload, 'utf8'))});
process.exitCode = await runCli(process.argv.slice(2));
`);
  bun(['build', entry, '--compile', '--target='+target, '--outfile='+resolve(outfile),
    '--env=disable', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig']);
} finally { await rm(stage, { recursive: true, force: true }); }
