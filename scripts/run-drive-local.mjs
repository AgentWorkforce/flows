#!/usr/bin/env node
// Prepare the local drive's trusted commands before submitting its journaled run.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareLocalDrive } from '../ops/local-work-gate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
try {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/run-drive-local.mjs');
  const built = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc'], {
    cwd: join(root, 'packages/sdk'), stdio: 'inherit',
  });
  if (built.error || built.status !== 0) throw new Error('LOCAL_DRIVE_SDK_BUILD_FAILED');
  const { load } = createRequire(join(root, 'packages/sdk/package.json'))('js-yaml');
  const authored = load(readFileSync('workflows/drive-local.yaml', 'utf8'));
  const prepared = prepareLocalDrive(authored, { root });
  mkdirSync('.relayflow', { recursive: true });
  const directory = mkdtempSync(resolve('.relayflow/drive-submission-'));
  const path = join(directory, 'flow.json');
  writeFileSync(path, JSON.stringify(prepared.flow), { mode: 0o600 });
  // Once runStart journals the spec, rewriting this input file cannot change
  // commands already owned by the daemon.
  const run = spawnSync(process.execPath, ['scripts/run-local-workflow.mjs', path], { stdio: 'inherit' });
  if (run.error) throw run.error;
  process.exitCode = run.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
