import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const script = resolve('ops/local-work-package.mjs');
const packageRelative = '.relayflow/drive-local/package.json';

// The picker accepts an entry only when it names a path in backticks and its
// body carries an engineering outcome. Both are required, so the fixture states
// them explicitly rather than relying on prose that happens to match.
const BACKLOG_ENTRY =
  '- **F8b** — replace `validateKernelRetry` in `packages/sdk/src/compile.ts`\n';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'local-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'work');
  mkdirSync(join(root, 'ops'));
  // The picker refuses an entry whose named paths do not exist at HEAD
  // (`stale_scope`), so the fixture must actually contain the file it scopes.
  mkdirSync(join(root, 'packages/sdk/src'), { recursive: true });
  writeFileSync(join(root, 'packages/sdk/src/compile.ts'),
    'export function validateKernelRetry() {}\n');
  writeFileSync(join(root, 'ops/BACKLOG.md'), BACKLOG_ENTRY);
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  const run = (operation, extra = []) =>
    spawnSync(process.execPath, [...extra, script, operation],
      { cwd: root, encoding: 'utf8', timeout: 20000 });
  return { root, git, run };
}

// The guarantee this file has always protected is that a killed writer leaves
// the destination wholly old or wholly new. It used to be asserted against the
// source file that `apply` rewrote. `apply` is gone -- the agent performs the
// edit now -- but writeAtomically survived and moved to the work package, so
// the assertion follows it rather than being deleted with the verb.
test('a killed package write leaves no partial package behind', t => {
  const { root, run } = fixture(t);
  const packagePath = join(root, packageRelative);

  const hook = join(root, 'interrupt.cjs');
  writeFileSync(hook, `const fs = require('node:fs');
const write = fs.writeFileSync;
fs.writeFileSync = (path, data, options) => {
  if (String(path).includes('package.json') && String(path).endsWith('.tmp')) {
    write(path, String(data).slice(0, 9), options);
    process.kill(process.pid, 'SIGKILL');
  }
  return write(path, data, options);
};
require('node:module').syncBuiltinESMExports();
`);

  const interrupted = run('select', ['--require', hook]);
  assert.equal(interrupted.signal, 'SIGKILL', interrupted.stderr);
  // Wholly old: there was no package before, so there must be none now. A
  // truncated `{"selecte` here is exactly the torn state rename() prevents.
  assert.equal(existsSync(packagePath), false,
    'a killed write must not publish a partial package');

  const selected = run('select');
  assert.equal(selected.status, 0, selected.stderr);
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  assert.equal(pkg.title, 'F8b', `unexpected title: ${pkg.title}`);
  assert.ok(pkg.filesInScope.includes('packages/sdk/src/compile.ts'),
    `scope did not name the file: ${JSON.stringify(pkg.filesInScope)}`);
});

// Replaces the old PACKAGE_ALREADY_APPLIED case. `select` has no "already
// applied" state, but it pins backlogSha256, so re-selecting an unchanged
// backlog is the same property: a repeated call is not a different answer.
test('re-selecting an unchanged backlog produces the same package', t => {
  const { root, run } = fixture(t);
  const packagePath = join(root, packageRelative);

  assert.equal(run('select').status, 0);
  const first = JSON.parse(readFileSync(packagePath, 'utf8'));
  assert.equal(run('select').status, 0);
  const second = JSON.parse(readFileSync(packagePath, 'utf8'));

  assert.equal(second.backlogSha256, first.backlogSha256);
  assert.equal(second.title, first.title);
  assert.deepEqual(second.filesInScope, first.filesInScope);
  assert.equal(second.head, first.head);
});

// `report` pins the HEAD its package was selected against. Reporting against a
// different commit would describe work this tick did not do. Nothing covered
// this before.
test('report refuses once HEAD has moved past the selected commit', t => {
  const { root, git, run } = fixture(t);

  assert.equal(run('select').status, 0);
  assert.equal(run('report').status, 0, 'report must accept the head it selected against');

  writeFileSync(join(root, 'ops/NOTES.md'), 'moved\n');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'advance');

  const moved = run('report');
  assert.notEqual(moved.status, 0, 'report must refuse a moved head');
  assert.match(`${moved.stdout}${moved.stderr}`, /HEAD_MOVED/);
});
