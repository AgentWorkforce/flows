import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { entry, fixture, packagePath, pass, fail } from './local-work-test-fixture.mjs';

test('committing outside scope and repinning metadata cannot replace the submitted HEAD', t => {
  const f = fixture(t);
  pass(f.run('select'));
  f.put('outside.txt', 'committed outside scope');
  f.git('add', 'outside.txt');
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'outside scope');
  const pkg = JSON.parse(readFileSync(join(f.root, packagePath), 'utf8'));
  pkg.head = f.git('rev-parse', 'HEAD').toString().trim();
  f.put(packagePath, JSON.stringify(pkg));
  for (const operation of ['scope', 'verify', 'report']) fail(f.run(operation), /HEAD_MOVED/);
});

test('forged snapshot, checksum and compiled picker cannot replace the submitted judge', t => {
  const f = fixture(t);
  pass(f.run('select'));
  for (const path of ['.drive-gate/local-work-package.mjs', '.drive-gate/local-work-verification.mjs',
    '.drive-gate/backlog-picker.js', 'packages/sdk/dist/backlog-picker.js']) {
    f.put(path, 'process.exit(0);\n');
  }
  pass(spawnSync('sh', ['-c', 'shasum -a 256 .drive-gate/*.mjs .drive-gate/*.js > .drive-gate/SHA256SUMS'],
    { cwd: f.root, encoding: 'utf8' }));
  pass(f.scope());
  fail(f.run('verify'), /PACKAGE_CHECK_FAILED/);
  f.put('src/value.txt', 'fixed');
  pass(f.run('verify'));
  pass(f.run('report'));
});

test('raw template refuses selection before implementation without captured gate inputs', t => {
  const f = fixture(t);
  const env = { ...process.env };
  delete env.DRIVE_GATE_PICKER;
  delete env.DRIVE_GATE_BASELINE;
  fail(spawnSync(process.execPath, ['ops/local-work-package.mjs', 'select'],
    { cwd: f.root, encoding: 'utf8', env }), /LOCAL_DRIVE_NOT_PREPARED/);
});

for (const title of ['Same title', 'Regex [a].* (b) + $']) {
  test(`selection advances past rejected duplicate title: ${title}`, t => {
    const f = fixture(t, entry(title, 'missing/value.txt') + entry(title));
    const result = f.run('select');
    pass(result);
    assert(result.stdout.includes(`SKIPPED [stale_scope: missing/value.txt] ${title}`));
    const pkg = JSON.parse(readFileSync(join(f.root, packagePath), 'utf8'));
    assert.deepEqual(pkg.filesInScope, ['src/value.txt']);
  });
}
