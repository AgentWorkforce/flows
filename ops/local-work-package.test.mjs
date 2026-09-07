import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const script = resolve('ops/local-work-package.mjs');

test('interrupted package write preserves the original and retry applies once', t => {
  const root = mkdtempSync(join(tmpdir(), 'local-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'work');
  mkdirSync(join(root, 'packages/sdk/src'), { recursive: true });
  mkdirSync(join(root, 'ops'));
  const target = join(root, 'packages/sdk/src/compile.ts');
  const original = 'function validateKernelRetry() {}\nvalidateKernelRetry();\n';
  writeFileSync(target, original);
  writeFileSync(join(root, 'ops/BACKLOG.md'), '- **F8b** — rename `validateKernelRetry`\n');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  const run = (operation, extra = []) => spawnSync(process.execPath, [...extra, script, operation],
    { cwd: root, encoding: 'utf8', timeout: 5000 });
  const selected = run('select');
  assert.equal(selected.status, 0, selected.stderr);
  // Intercept the real fs write in a separate process, write a partial prefix,
  // then SIGKILL before rename. Never change the package implementation.
  const hook = join(root, 'interrupt.cjs');
  writeFileSync(hook, `const fs = require('node:fs');
const write = fs.writeFileSync;
fs.writeFileSync = (path, data, options) => {
  if (String(path).includes('compile.ts') && String(path).endsWith('.tmp')) {
    write(path, data.slice(0, 9), options);
    process.kill(process.pid, 'SIGKILL');
  }
  return write(path, data, options);
};
require('node:module').syncBuiltinESMExports();
`);
  const interrupted = run('apply', ['--require', hook]);
  assert.equal(interrupted.signal, 'SIGKILL', interrupted.stderr);
  assert.equal(readFileSync(target, 'utf8'), original);
  const applied = run('apply');
  assert.equal(applied.status, 0, applied.stderr);
  const expected = original.replaceAll('validateKernelRetry', 'validateAuthoringRetryDefaults');
  assert.equal(readFileSync(target, 'utf8'), expected);
  const retry = run('apply');
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /PACKAGE_ALREADY_APPLIED/);
  assert.equal(readFileSync(target, 'utf8'), expected);
});
