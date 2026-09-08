import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fixture, flow } from './local-work-test-fixture.mjs';

const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
for (const scenario of ['outside edit', 'verifier edit', 'unchanged package']) {
  test(`drive-local journals failure and blocks reporting for ${scenario}`, t => {
    const f = fixture(t);
    const wrapper = resolve('testdata/preflight/wrapper-session.mjs');
    const cli = join(f.root, '.relayflow/agent.mjs');
    f.put('.relayflow/agent.mjs', `#!/usr/bin/env node
import { receiveWrapperRequest } from ${JSON.stringify(wrapper)};
import { writeFileSync } from 'node:fs';
const request = await receiveWrapperRequest();
if (request) {
  ${scenario === 'outside edit' ? `writeFileSync(${JSON.stringify(join(f.root, 'outside.txt'))}, 'changed');` : ''}
  ${scenario === 'verifier edit' ? `writeFileSync(${JSON.stringify(join(f.root, 'ops/local-work-package.mjs'))}, 'process.exit(0)');` : ''}
  console.log('DONE');
}
`);
    // A scripted worker controls the edit while using the real worker protocol,
    // stream pin, submitted flow commands, daemon and journal.
    chmodSync(cli, 0o755);
    const spec = structuredClone(flow);
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
    const failedStep = scenario === 'unchanged package' ? 'verify' : 'scope';
    const completion = journal.find(e => e.entry_type === 'step.completed' && e.step_id === failedStep);
    assert.equal(completion?.payload.verification.verdict, 'fail', JSON.stringify(journal));
    assert.equal(completion.payload.completionReason, 'retries_exhausted');
    assert.equal(completion.payload.verification.detail, 'exit code was 1');
    assert(!journal.some(e => e.entry_type === 'step.attempt.started' && e.step_id === 'report'));
    assert(!existsSync(join(dataDir, 'relayflowd.sock')));
  });
}
