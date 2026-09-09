import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { entry, fixture, flow, pass, fail } from './local-work-test-fixture.mjs';

for (const kind of ['unstaged', 'staged', 'untracked']) {
  test(`report includes an allowed ${kind} change`, t => {
    const f = fixture(t, entry('Directory', 'src/'));
    pass(f.run('select'));
    const path = kind === 'untracked' ? 'src/new.txt' : 'src/value.txt';
    f.put(path, 'fixed');
    if (kind === 'staged') f.git('add', path);
    pass(f.run('scope'));
    const report = f.run('report');
    pass(report);
    assert.match(report.stdout, new RegExp(path));
    assert.doesNotMatch(report.stdout, /no working-tree changes/);
  });
}

for (const kind of ['dangling escape', 'existing internal']) {
  test(`directory scope checks a pre-existing ${kind} symlink`, t => {
    const f = fixture(t, entry('Directory', 'src/'));
    symlinkSync(kind === 'dangling escape' ? '../../../missing-target' : 'value.txt',
      join(f.root, 'src/link'));
    f.git('add', 'src/link');
    f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'existing link');
    pass(f.run('select'));
    const result = f.run('scope');
    if (kind === 'dangling escape') fail(result, /SYMLINK_UNRESOLVED/);
    else pass(result);
  });
}

test('selection skips untracked scope and accepts the next committed scope', t => {
  const f = fixture(t, entry('Untracked', 'new/value.txt') + entry());
  f.put('new/value.txt', 'untracked');
  const result = f.run('select');
  pass(result);
  assert.match(result.stdout, /SKIPPED \[stale_scope: new\/value.txt\] Untracked/);
  assert.match(result.stdout, /SELECTED Fix value/);
});

for (const path of ['outside.txt', 'src/value.txt']) {
  test(`reporting after SDK suite effects enforces scope for ${path}`, t => {
    const f = fixture(t);
    pass(f.run('select'));
    f.put('src/value.txt', 'fixed');
    pass(f.run('verify'));
    // Model a Git-visible effect produced by the SDK suite after package checks.
    f.put(path, 'suite effect');
    let previous = 'verify';
    let result;
    while (previous !== 'report') {
      const next = flow.steps.find(step => step.dependsOn?.includes(previous));
      assert(next, `no path from ${previous} to report`);
      result = f.step(next.id);
      if (result.status !== 0) break;
      previous = next.id;
    }
    if (path === 'outside.txt') fail(result, /OUT_OF_SCOPE/);
    else { pass(result); assert.equal(previous, 'report'); }
  });
}
