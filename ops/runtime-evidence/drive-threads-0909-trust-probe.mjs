import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fixture, packagePath, pass, fail } from '../local-work-test-fixture.mjs';
const cleanup = [];
const t = { after: fn => cleanup.push(fn) };
try {
  const f = fixture(t);
  pass(f.run('select'));
  f.put('outside.txt', 'committed outside scope');
  f.git('add', 'outside.txt');
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'outside scope');
  const pkg = JSON.parse(readFileSync(join(f.root, packagePath), 'utf8'));
  pkg.head = f.git('rev-parse', 'HEAD').toString().trim();
  f.put(packagePath, JSON.stringify(pkg));
  const repinned = f.scope();
  console.log('COMMITTED_OUTSIDE_AND_REPINNED_PACKAGE_SCOPE_EXIT=' + repinned.status);
  process.stdout.write(repinned.stdout + repinned.stderr);
  fail(repinned, /HEAD_MOVED/);

  const g = fixture(t);
  pass(g.run('select'));
  for (const path of ['.drive-gate/local-work-package.mjs', '.drive-gate/local-work-verification.mjs',
    '.drive-gate/backlog-picker.js']) g.put(path, 'process.exit(0);\n');
  pass(spawnSync('sh', ['-c', 'shasum -a 256 .drive-gate/*.mjs .drive-gate/*.js > .drive-gate/SHA256SUMS'], {cwd:g.root, encoding:'utf8'}));
  const forged = g.run('verify');
  console.log('REWRITTEN_SNAPSHOT_AND_CHECKSUM_VERIFY_EXIT=' + forged.status);
  process.stdout.write(forged.stdout + forged.stderr);
  fail(forged, /PACKAGE_CHECK_FAILED/);
  console.log('IMPLEMENTATION=' + readFileSync(join(g.root, 'src/value.txt'), 'utf8'));
  g.put('src/value.txt', 'fixed');
  const repaired = g.run('verify');
  pass(repaired);
  console.log('REPAIRED_IMPLEMENTATION_VERIFY_EXIT=' + repaired.status);
} finally { for (const fn of cleanup) fn(); }
