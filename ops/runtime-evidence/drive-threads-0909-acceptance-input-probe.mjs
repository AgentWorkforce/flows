// Open design blocker: argv is pinned, but arbitrary script dependencies are not.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { entry, fixture, pass, fail } from '../local-work-test-fixture.mjs';

const cleanup = [];
try {
  const f = fixture({ after: fn => cleanup.push(fn) }, entry('Directory', 'src/', [['node', 'src/check.mjs']]));
  f.put('src/check.mjs', "import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; assert.equal(readFileSync('src/value.txt','utf8'),'fixed');\n");
  f.git('add', 'src/check.mjs');
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'acceptance');
  pass(f.run('select'));
  const before = f.run('verify');
  fail(before, /PACKAGE_CHECK_FAILED/);
  console.log('ORIGINAL_CHECK_WITH_BROKEN_IMPLEMENTATION_EXIT=' + before.status);
  f.put('src/check.mjs', 'process.exit(0);\n');
  const forged = f.run('verify');
  pass(forged);
  console.log('EDITED_ACCEPTANCE_SCRIPT_EXIT=' + forged.status);
  process.stdout.write(forged.stdout + forged.stderr);
  console.log('IMPLEMENTATION=' + readFileSync(join(f.root, 'src/value.txt'), 'utf8'));
} finally { for (const fn of cleanup) fn(); }
