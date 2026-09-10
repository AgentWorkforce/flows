import assert from 'node:assert/strict';
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { entry, fixture, packagePath, pass, fail } from './local-work-test-fixture.mjs';

const assertion = "require('node:assert/strict').equal(require('node:fs').readFileSync('src/value.txt','utf8'),'fixed');\n";
const commit = f => {
  f.git('add', '.');
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'acceptance input');
};
const pinned = (ref = 'HEAD') => ({ argv: ['node', 'src/check.cjs'], inputs: [{ path: 'src/check.cjs', ref }] });

test('edited in-scope acceptance argv refuses while implementation stays broken (#284)', t => {
  const f = fixture(t, entry('Fix value', 'src/', [['node', 'src/check.cjs']]));
  f.put('src/check.cjs', assertion);
  commit(f);
  pass(f.run('select'));
  f.put('src/check.cjs', 'process.exit(0);\n');
  const result = f.run('verify');
  fail(result, /ACCEPTANCE_IMMUTABILITY_VIOLATION: acceptance script is implementation-writable: src\/check.cjs/);
  assert.match(result.stderr, /DoD:/);
  assert.doesNotMatch(result.stdout, /PACKAGE_VERIFIED|CHECK /);
  assert.equal(readFileSync(join(f.root, 'src/value.txt'), 'utf8'), 'broken');
});

test('pinned acceptance executes Git bytes despite an edited checkout script', t => {
  const f = fixture(t, entry('Fix value', 'src/', [pinned()]));
  f.put('src/check.cjs', assertion);
  commit(f);
  pass(f.run('select'));
  const pkg = JSON.parse(readFileSync(join(f.root, packagePath)));
  assert.equal(pkg.verification.ref, pkg.head);
  assert.equal(pkg.verification.checks[0].inputs[0].ref, pkg.head);
  f.put('src/check.cjs', 'process.exit(0);\n');
  fail(f.run('verify'), /PACKAGE_CHECK_FAILED.*DoD:/);
  f.put('src/value.txt', 'fixed');
  pass(f.run('verify'));
});

for (const ref of [undefined, '', 'main', 'f'.repeat(40)]) {
  test(`missing or unavailable script pin refuses: ${String(ref)}`, t => {
    const check = pinned();
    check.inputs[0].ref = ref;
    const f = fixture(t, entry('Fix value', 'src/', [check]));
    f.put('src/check.cjs', 'process.exit(0);');
    commit(f);
    pass(f.run('select'));
    fail(f.run('verify'), /ACCEPTANCE_IMMUTABILITY_VIOLATION:.*(pinned Git ref|pinned Git input unavailable)/);
  });
}

test('all inputs are validated before any acceptance command executes', t => {
  const f = fixture(t, entry('Fix value', 'src/', [
    ['node', '-e', "require('node:fs').writeFileSync('src/ran.txt','ran')"], pinned(),
  ]));
  pass(f.run('select'));
  const result = f.run('verify');
  fail(result, /ACCEPTANCE_IMMUTABILITY_VIOLATION/);
  assert.doesNotMatch(result.stdout, /CHECK /);
});

test('external absolute acceptance reads the changed implementation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'external-acceptance-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'check.cjs');
  writeFileSync(path, assertion);
  const f = fixture(t, entry('Fix value', 'src/value.txt', [{ argv: ['node', path], inputs: [{ path }] }]));
  pass(f.run('select'));
  fail(f.run('verify'), /PACKAGE_CHECK_FAILED/);
  f.put('src/value.txt', 'fixed');
  pass(f.run('verify'));
});

for (const alias of [false, true]) {
  test(`an absolute acceptance path inside write scope refuses${alias ? ' through a symlink' : ''}`, t => {
    const f = fixture(t);
    f.put('src/check.cjs', 'process.exit(0);');
    const path = join(f.root, alias ? 'alias.cjs' : 'src/check.cjs');
    if (alias) symlinkSync('src/check.cjs', path);
    f.put('ops/BACKLOG.md', entry('Fix value', 'src/', [{ argv: ['node', path], inputs: [{ path }] }]));
    commit(f);
    pass(f.run('select'));
    fail(f.run('verify'), /ACCEPTANCE_IMMUTABILITY_VIOLATION: acceptance input is implementation-writable/);
  });
}

test('a symlink beneath writable scope cannot grant access to an external acceptance file', t => {
  const f = fixture(t);
  f.put('checks/check.cjs', 'process.exit(0);');
  symlinkSync('../checks', join(f.root, 'src/checks'));
  const path = join(f.root, 'checks/check.cjs');
  f.put('ops/BACKLOG.md', entry('Fix value', 'src/', [{ argv: ['node', path], inputs: [{ path }] }]));
  commit(f);
  pass(f.run('select'));
  fail(f.run('verify'), /ACCEPTANCE_IMMUTABILITY_VIOLATION: acceptance input is implementation-writable/);
});

test('pinned relative dependencies also come from Git', t => {
  const check = pinned();
  check.inputs.push({ path: 'src/assertion.cjs', ref: 'HEAD' });
  const f = fixture(t, entry('Fix value', 'src/', [check]));
  f.put('src/check.cjs', "require('./assertion.cjs');\n");
  f.put('src/assertion.cjs', assertion);
  commit(f);
  pass(f.run('select'));
  f.put('src/assertion.cjs', 'process.exit(0);');
  fail(f.run('verify'), /PACKAGE_CHECK_FAILED/);
  f.put('src/value.txt', 'fixed');
  pass(f.run('verify'));
});

test('an external input with an in-scope hard link is refused', t => {
  const f = fixture(t);
  f.put('checks/check.cjs', 'process.exit(0);');
  const path = join(f.root, 'checks/check.cjs');
  linkSync(path, join(f.root, 'src/check.cjs'));
  f.put('ops/BACKLOG.md', entry('Fix value', 'src/', [{ argv: ['node', path], inputs: [{ path }] }]));
  commit(f);
  pass(f.run('select'));
  fail(f.run('verify'), /ACCEPTANCE_IMMUTABILITY_VIOLATION: external input has writable hard-link aliases/);
});

test('package metadata cannot delete or repin the verification block', t => {
  const f = fixture(t);
  pass(f.run('select'));
  const pkg = JSON.parse(readFileSync(join(f.root, packagePath)));
  for (const verification of [undefined, { ...pkg.verification, ref: 'f'.repeat(40) }]) {
    f.put(packagePath, JSON.stringify({ ...pkg, verification }));
    fail(f.run('verify'), /PACKAGE_CHANGED: verification/);
  }
});

test('declaring a shell runtime cannot authorize arbitrary mutable acceptance argv', t => {
  const f = fixture(t, entry('Fix value', 'src/', [{
    argv: ['/bin/sh', '-c', 'node src/check.cjs'], inputs: [{ path: '/bin/sh' }],
  }]));
  f.put('src/check.cjs', 'process.exit(0);');
  commit(f);
  pass(f.run('select'));
  fail(f.run('verify'), /ACCEPTANCE_IMMUTABILITY_VIOLATION/);
});

test('an executable acceptance script is extracted from Git', t => {
  const f = fixture(t, entry('Fix value', 'src/', [{
    argv: ['checks/value.sh'], inputs: [{ path: 'checks/value.sh', ref: 'HEAD' }],
  }]), { 'checks/value.sh': '#!/bin/sh\n[ "$(cat src/value.txt)" = fixed ]\n' });
  pass(f.run('select'));
  fail(f.run('verify'), /PACKAGE_CHECK_FAILED/);
  f.put('src/value.txt', 'fixed');
  pass(f.run('verify'));
});

test('isolated report refuses an outside edit and names the DoD', t => {
  const f = fixture(t);
  pass(f.run('select'));
  f.put('outside.txt', 'changed');
  const result = f.run('report');
  fail(result, /OUT_OF_SCOPE: outside.txt; DoD:/);
  assert.doesNotMatch(result.stdout, /REPORT |PACKAGE_VERIFIED/);
});

test('a check that violates scope never emits PACKAGE_VERIFIED', t => {
  const f = fixture(t, entry('Fix value', 'src/value.txt', [
    ['node', '-e', "require('node:fs').writeFileSync('outside.txt','changed')"],
  ]));
  pass(f.run('select'));
  const result = f.run('verify');
  fail(result, /OUT_OF_SCOPE/);
  assert.doesNotMatch(result.stdout, /PACKAGE_VERIFIED/);
});
