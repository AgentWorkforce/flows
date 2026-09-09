import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { entry, fixture, packagePath, pass } from '../local-work-test-fixture.mjs';
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

  const g = fixture(t);
  pass(g.run('select'));
  g.put('.drive-gate/local-work-package.mjs', 'process.exit(0);\n');
  pass(spawnSync('sh', ['-c', 'shasum -a 256 .drive-gate/*.mjs .drive-gate/*.js > .drive-gate/SHA256SUMS'], {cwd:g.root, encoding:'utf8'}));
  const forged = g.scope();
  console.log('REWRITTEN_SNAPSHOT_AND_CHECKSUM_SCOPE_EXIT=' + forged.status);
  process.stdout.write(forged.stdout + forged.stderr);
  console.log('IMPLEMENTATION=' + readFileSync(join(g.root, 'src/value.txt'), 'utf8'));
} finally { for (const fn of cleanup) fn(); }
