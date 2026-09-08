import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { entry, fixture, packagePath, pass, fail } from './local-work-test-fixture.mjs';

const check = ['node', '-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('src/value.txt','utf8'),'fixed')"];

test('skip cursor passes a later title mentioned in an earlier body', t => {
  const f = fixture(t, '- **First** Update `symbol`; Later is mentioned here.\n' +
    '- **Later** Update `anotherSymbol`.\n' + entry());
  const result = f.run('select');
  pass(result);
  assert.equal((result.stdout.match(/SKIPPED/g) ?? []).length, 2);
  assert.match(result.stdout, /SELECTED Fix value/);
  pass(f.scope());
});

test('selection skips missing checks and stale paths with reasons', t => {
  const f = fixture(t, entry('No checks', 'src/value.txt', []) + entry('Stale', 'src/missing.txt') + entry());
  const result = f.run('select');
  pass(result);
  assert.match(result.stdout, /SKIPPED \[missing_executable_checks\] No checks/);
  assert.match(result.stdout, /SKIPPED \[stale_scope: src\/missing.txt\] Stale/);
  assert.match(result.stdout, /SELECTED Fix value/);
  pass(f.scope());
});

test('a non-SDK package fails unchanged and passes only after its check holds', t => {
  const f = fixture(t);
  pass(f.run('select'));
  fail(f.run('verify'), /PACKAGE_CHECK_FAILED/);
  f.put('src/value.txt', 'fixed');
  pass(f.scope());
  pass(f.run('verify'));
});

test('multiple acceptance checks all execute and failures propagate', t => {
  const f = fixture(t, entry('Two checks', 'src/value.txt', [check, ['node', '-e', 'process.exit(7)']]));
  pass(f.run('select'));
  f.put('src/value.txt', 'fixed');
  fail(f.run('verify'), /PACKAGE_CHECK_FAILED.*7/);
});

for (const kind of ['unstaged', 'staged', 'untracked', 'staged reversal', 'rename', 'deleted']) {
  test(`scope refuses an outside ${kind} path`, t => {
    const f = fixture(t);
    pass(f.run('select'));
    if (kind === 'rename') f.git('mv', 'outside.txt', 'src/renamed.txt');
    else if (kind === 'deleted') rmSync(join(f.root, 'outside.txt'));
    else {
      f.put(kind === 'untracked' ? 'new.txt' : 'outside.txt', 'changed');
      if (kind === 'staged' || kind === 'staged reversal') f.git('add', 'outside.txt');
      if (kind === 'staged reversal') f.put('outside.txt', 'original');
    }
    fail(f.scope(), /OUT_OF_SCOPE/);
  });
}

for (const path of ['ops/local-work-package.mjs', 'ops/local-work-verification.mjs', 'ops/BACKLOG.md']) {
  test(`the submitted scope command refuses a changed ${path} before loading it`, t => {
    const f = fixture(t);
    pass(f.run('select'));
    f.put(path, 'process.exit(0);\n');
    fail(f.scope());
  });
}

test('editing ignored package metadata cannot widen scope or replace checks', t => {
  const f = fixture(t);
  pass(f.run('select'));
  const original = readFileSync(join(f.root, packagePath), 'utf8');
  for (const change of [{ filesInScope: ['.'] }, { verificationCommands: [['true']] }]) {
    f.put(packagePath, JSON.stringify({ ...JSON.parse(original), ...change }));
    fail(f.scope(), /PACKAGE_CHANGED/);
  }
});

test('scope allows directory children but rejects a sibling with the same prefix', t => {
  const f = fixture(t, entry('Directory', 'src/'));
  pass(f.run('select'));
  f.put('src/new.txt', 'new');
  pass(f.scope());
  f.put('src-other/new.txt', 'outside');
  fail(f.scope(), /OUT_OF_SCOPE/);
});

test('scope allows in-scope deletions and rejects symlink escapes', t => {
  const f = fixture(t);
  pass(f.run('select'));
  rmSync(join(f.root, 'src/value.txt'));
  pass(f.scope());
  symlinkSync('../outside.txt', join(f.root, 'src/value.txt'));
  fail(f.scope(), /SYMLINK_SCOPE/);
});

test('replacing a scoped file with a directory does not authorize its children', t => {
  const f = fixture(t);
  pass(f.run('select'));
  rmSync(join(f.root, 'src/value.txt'));
  f.put('src/value.txt/child.txt', 'outside the declared file');
  fail(f.scope(), /OUT_OF_SCOPE/);
});

test('a check that writes outside scope fails verification', t => {
  const f = fixture(t, entry('Bad check', 'src/value.txt',
    [['node', '-e', "require('node:fs').writeFileSync('outside.txt','changed')"]]));
  pass(f.run('select'));
  fail(f.run('verify'), /OUT_OF_SCOPE/);
});

test('interrupted package write preserves the original and retry replaces it atomically', t => {
  const f = fixture(t);
  pass(f.run('select'));
  const original = readFileSync(join(f.root, packagePath), 'utf8');
  const hook = join(f.root, '.relayflow/interrupt.cjs');
  writeFileSync(hook, `const fs = require('node:fs');
const write = fs.writeFileSync;
fs.writeFileSync = (path, data, options) => {
  if (String(path).includes('package.json') && String(path).endsWith('.tmp')) {
    write(path, data.slice(0, 9), options);
    process.kill(process.pid, 'SIGKILL');
  }
  return write(path, data, options);
};
require('node:module').syncBuiltinESMExports();\n`);
  const interrupted = f.run('select', ['--require', hook]);
  assert.equal(interrupted.signal, 'SIGKILL', interrupted.stderr);
  assert.equal(readFileSync(join(f.root, packagePath), 'utf8'), original);
  pass(f.run('select'));
  assert.equal(JSON.parse(readFileSync(join(f.root, packagePath))).title, 'Fix value');
  assert.equal(readFileSync(join(f.root, 'src/value.txt'), 'utf8'), 'broken');
});
