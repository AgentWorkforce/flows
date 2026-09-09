import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(resolve('packages/sdk/package.json'));
const source = process.argv[2]
  ? execFileSync('git', ['show', `${process.argv[2]}:.github/workflows/review-swarm.yml`], { encoding: 'utf8' })
  : readFileSync('.github/workflows/review-swarm.yml', 'utf8');
const flow = require('js-yaml').load(source);
const command = flow.jobs.review.steps.find(step => step.name === "Self-test the gate's verdict logic").run;
mkdirSync('.relayflow', { recursive: true });
for (const [label, pr, script, expected] of [
  ['introducing PR without test', '248', null, 0],
  ['later PR without test', '249', null, 1],
  ['present passing test', '249', 'echo SELF_TEST_RAN; exit 0', 0],
  ['present failing test', '249', 'echo SELF_TEST_RAN; exit 7', 7],
]) {
  const cwd = mkdtempSync(resolve('.relayflow/bootstrap-probe-'));
  try {
    if (script !== null) {
      const directory = join(cwd, 'gate-files/.github/workflows/scripts');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'swarm-gate.test.sh'), script);
    }
    const result = spawnSync('bash', ['-e', '-c', command], {
      cwd, encoding: 'utf8', env: { ...process.env, REVIEW_PR_NUMBER: pr },
    });
    console.log(`${label}: exit=${result.status}, expected=${expected}`);
    process.stdout.write(result.stdout + result.stderr);
    assert.equal(result.status, expected);
    if (script !== null) assert.match(result.stdout, /SELF_TEST_RAN/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
