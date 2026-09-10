import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, packagePath, pass, fail } from './local-work-test-fixture.mjs';

test('preparation reads the committed gate instead of a working-tree replacement', t => {
  const f = fixture(t);
  const source = f.git('show', 'HEAD:ops/local-work-package.mjs').toString();
  f.put('ops/local-work-package.mjs', source.replace('const packagePath', 'process.exit(0);\nconst packagePath'));
  const selected = f.run('select');
  pass(selected);
  assert.match(selected.stdout, /SELECTED Fix value/);
  assert.equal(readFileSync(join(f.gateDirectory, 'local-work-package.mjs'), 'utf8'), source);
  assert.equal(JSON.parse(readFileSync(join(f.root, packagePath), 'utf8')).head,
    f.git('rev-parse', 'HEAD').toString().trim());
  fail(f.run('verify'), /OUT_OF_SCOPE/);
  f.put('ops/local-work-package.mjs', f.git('show', 'HEAD:ops/local-work-package.mjs'));
  f.put('src/value.txt', 'fixed');
  pass(f.run('verify'));
});

test('gate-snapshot builds committed picker source outside the checkout', t => {
  const f = fixture(t);
  const original = f.git('show', 'HEAD:packages/sdk/src/backlog-picker.ts');
  f.put('packages/sdk/src/backlog-picker.ts', 'this is not valid TypeScript');
  const selected = f.run('select');
  pass(selected);
  assert.match(selected.stdout, /SELECTED Fix value/);
  assert(!f.gateDirectory.startsWith(f.root));
  assert.deepEqual(readFileSync(join(f.gateDirectory, 'backlog-picker.ts')), original);
  assert(!existsSync(join(f.gateDirectory, 'SHA256SUMS')));
  fail(f.scope(), /OUT_OF_SCOPE/);
  f.put('packages/sdk/src/backlog-picker.ts', original);
  f.put('src/value.txt', 'fixed');
  pass(f.run('verify'));
});

test('a committed picker compile failure prevents package selection', t => {
  const f = fixture(t);
  f.put('packages/sdk/src/backlog-picker.ts', 'this is not valid TypeScript');
  f.git('add', 'packages/sdk/src/backlog-picker.ts');
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'broken picker source');
  fail(f.run('select'), /error TS/);
  assert(!existsSync(join(f.root, packagePath)));
});

test('an ignored compiled picker cannot become the input to selection', t => {
  const f = fixture(t);
  f.put('packages/sdk/dist/backlog-picker.js', 'process.exit(0);\n');
  const selected = f.run('select');
  pass(selected);
  assert.match(selected.stdout, /SELECTED Fix value/);
  fail(f.run('verify'), /PACKAGE_CHECK_FAILED/);
  f.put('src/value.txt', 'fixed');
  pass(f.run('verify'));
});

test('Git replacement objects cannot substitute gate source at the pinned ref', t => {
  const f = fixture(t);
  const original = f.git('rev-parse', 'HEAD:ops/local-work-package.mjs').toString().trim();
  f.put('.relayflow/replacement.mjs', 'process.exit(0);\n');
  const replacement = f.git('hash-object', '-w', '.relayflow/replacement.mjs').toString().trim();
  f.git('replace', original, replacement);
  const selected = f.run('select');
  pass(selected);
  assert.match(selected.stdout, /SELECTED Fix value/);
  fail(f.run('verify'), /PACKAGE_CHECK_FAILED/);
  f.put('src/value.txt', 'fixed');
  pass(f.run('verify'));
});
