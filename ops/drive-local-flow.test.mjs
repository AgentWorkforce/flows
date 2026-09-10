import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { socketPathFor } from '../packages/sdk/dist/daemon-connection.js';
import { entry, fixture, packagePath } from './local-work-test-fixture.mjs';

const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
for (const scenario of ['outside edit', 'verifier edit', 'unchanged package', 'HEAD repin', 'forged snapshot',
  'edited pinned acceptance', 'undeclared acceptance']) {
  test(`drive-local journals failure and blocks reporting for ${scenario}`, t => {
    const acceptance = scenario.includes('acceptance');
    const argv = ['node', 'src/check.cjs'];
    const check = scenario === 'undeclared acceptance' ? argv : {
      argv, inputs: [{ path: 'src/check.cjs', ref: 'HEAD' }],
    };
    const f = acceptance ? fixture(t, entry('Fix value', 'src/', [check]), {
      'src/check.cjs': "require('node:assert/strict').equal(require('node:fs').readFileSync('src/value.txt','utf8'),'fixed');",
    }) : fixture(t);
    const wrapper = resolve('testdata/preflight/wrapper-session.mjs');
    const cli = join(f.root, '.relayflow/agent.mjs');
    f.put('.relayflow/agent.mjs', `#!/usr/bin/env node
import { receiveWrapperRequest } from ${JSON.stringify(wrapper)};
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const request = await receiveWrapperRequest();
if (request) {
  ${scenario === 'outside edit' ? `writeFileSync(${JSON.stringify(join(f.root, 'outside.txt'))}, 'changed');` : ''}
  ${scenario === 'verifier edit' ? `writeFileSync(${JSON.stringify(join(f.root, 'ops/local-work-package.mjs'))}, 'process.exit(0)');` : ''}
  ${scenario === 'edited pinned acceptance' ? `writeFileSync(${JSON.stringify(join(f.root, 'src/check.cjs'))}, 'process.exit(0)');` : ''}
  ${scenario === 'HEAD repin' ? `
  const git = (...args) => execFileSync('git', args, {cwd: ${JSON.stringify(f.root)}, encoding: 'utf8'}).trim();
  writeFileSync(${JSON.stringify(join(f.root, 'outside.txt'))}, 'changed');
  git('add', 'outside.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'outside');
  const path = ${JSON.stringify(join(f.root, packagePath))};
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  pkg.head = git('rev-parse', 'HEAD');
  writeFileSync(path, JSON.stringify(pkg));` : ''}
  ${scenario === 'forged snapshot' ? `
  const directory = ${JSON.stringify(join(f.root, '.drive-gate'))};
  mkdirSync(directory, {recursive: true});
  writeFileSync(directory + '/local-work-package.mjs', 'process.exit(0);');
  const sums = execFileSync('shasum', ['-a', '256', '.drive-gate/local-work-package.mjs'], {cwd: ${JSON.stringify(f.root)}});
  writeFileSync(directory + '/SHA256SUMS', sums);` : ''}
  console.log('DONE');
}
`);
    // A scripted worker controls the edit while using the real worker protocol,
    // stream pin, submitted flow commands, daemon and journal.
    chmodSync(cli, 0o755);
    const spec = structuredClone(f.preparedFlow);
    for (const step of spec.steps) {
      if (step.type === 'agent') step.cli = cli;
      else step.command = `cd ${quote(f.root)}\n${step.command}`;
    }
    const path = join(f.root, '.relayflow/flow.json');
    writeFileSync(path, JSON.stringify(spec));
    const result = spawnSync(process.execPath, ['scripts/run-local-workflow.mjs', path], {
      encoding: 'utf8', timeout: 20000,
    });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    const dataDir = result.stdout.match(/^LOCAL_DATA_DIR=(.+)$/m)?.[1];
    assert(dataDir, result.stderr);
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const journal = readFileSync(join(dataDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const failedStep = scenario === 'undeclared acceptance' ? 'initial-scope' :
      ['unchanged package', 'forged snapshot', 'edited pinned acceptance'].includes(scenario) ? 'verify' : 'scope';
    const completion = journal.find(e => e.entry_type === 'step.completed' && e.step_id === failedStep);
    assert.equal(completion?.payload.verification.verdict, 'fail', JSON.stringify(journal));
    assert.equal(completion.payload.completionReason, 'retries_exhausted');
    assert.equal(completion.payload.verification.detail, 'exit code was 1');
    assert(!journal.some(e => e.entry_type === 'step.attempt.started' && e.step_id === 'report'));
    if (scenario === 'undeclared acceptance') {
      assert(!journal.some(e => e.entry_type === 'step.attempt.started' && e.step_id === 'implement'));
    }
    assert(!existsSync(socketPathFor(dataDir)));
  });
}
