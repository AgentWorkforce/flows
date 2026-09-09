// Executed as gate-snapshot before selection and implementation. Source inputs
// come from a commit, never the checkout. The ref is the integrity claim; there
// is no checksum manifest. A same-user process can still alter these temp files.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

try {
  const [head, directory, compiler, ...extra] = process.argv.slice(2);
  assert(head && directory && compiler && !extra.length, 'LOCAL_DRIVE_NOT_PREPARED: run node scripts/run-drive-local.mjs');
  assert(/^[a-f0-9]{40}$/.test(head), 'INVALID_GATE_REF');
  const git = (...args) => execFileSync('git', ['--no-replace-objects', ...args]);
  assert.equal(git('rev-parse', 'HEAD').toString().trim(), head, 'HEAD_MOVED');
  assert.equal(readdirSync(directory).length, 0, 'GATE_DIRECTORY_NOT_EMPTY');
  for (const [source, destination] of [
    ['ops/local-work-package.mjs', 'local-work-package.mjs'],
    ['ops/local-work-verification.mjs', 'local-work-verification.mjs'],
    ['packages/sdk/src/backlog-picker.ts', 'backlog-picker.ts'],
  ]) {
    writeFileSync(join(directory, destination), git('show', `${head}:${source}`), { flag: 'wx', mode: 0o600 });
  }
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', outDir: 'dist', strict: true, types: [], skipLibCheck: true },
    files: ['backlog-picker.ts'],
  }), { flag: 'wx', mode: 0o600 });
  // The installed TypeScript compiler is part of the trusted local toolchain.
  // Its inputs are the extracted source and this explicit build configuration.
  execFileSync(process.execPath, [compiler, '--project', join(directory, 'tsconfig.json')], { stdio: 'inherit' });
  console.log(`GATE_FROM_GIT: ${head}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
