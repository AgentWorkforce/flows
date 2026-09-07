import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, '.relayflow'), { recursive: true });
const fixtures = mkdtempSync(join(root, '.relayflow', 'launcher-tests-'));

function run(name, steps, env = {}) {
  const path = join(fixtures, `${name}.json`);
  writeFileSync(path, JSON.stringify({ version: '0.1.0', name, steps }));
  const result = spawnSync(process.execPath, ['scripts/run-local-workflow.mjs', path], {
    cwd: root, encoding: 'utf8', timeout: 15000, env: { ...process.env, ...env },
  });
  assert.equal(result.error, undefined, result.stderr);
  const records = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const dataDir = result.stdout.match(/^LOCAL_DATA_DIR=(.+)$/m)?.[1];
  if (dataDir) assert(!existsSync(join(dataDir, 'relayflowd.sock')), 'owned daemon socket must be removed on exit');
  return { ...result, records, dataDir };
}

test('local launcher journals deterministic effects and reads more than one journal page', () => {
  const result = run('pagination', Array.from({ length: 51 }, (_, i) => ({
    id: `step-${i}`, type: 'deterministic', command: `printf step-${i}`,
    ...(i ? { dependsOn: [`step-${i - 1}`] } : {}),
  })));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.records.at(-1).completedSteps, 51);
  const journal = readFileSync(join(result.dataDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(journal.filter(entry => entry.entry_type === 'step.completed').length, 51);
  assert.equal(journal.at(-1).entry_type, 'run.completed');
});

test('a failed command fails the run and prevents dependent effects', () => {
  const marker = join(fixtures, 'must-not-exist');
  const result = run('failure', [
    { id: 'fail', type: 'deterministic', command: 'exit 7' },
    { id: 'blocked', type: 'deterministic', command: `touch '${marker}'`, dependsOn: ['fail'] },
  ]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.records.at(-1).ok, false);
  assert.equal(result.records.at(-1).status, 'failed');
  assert(!existsSync(marker));
  const completion = result.records.find(entry => entry.entry_type === 'step.completed');
  assert.equal(completion.payload.verification.detail, 'exit code was 7');
  assert.equal(completion.payload.verification.verdict, 'fail');
});

test('the SDK worker completes an agent step through the local journal protocol', () => {
  // A deterministic wrapper proves worker wiring, not model quality or auth.
  const cli = join(fixtures, 'local-agent');
  const wrapper = join(root, 'testdata/preflight/wrapper-session.mjs');
  writeFileSync(cli, `#!/usr/bin/env node\nimport { receiveWrapperRequest } from ${JSON.stringify(wrapper)};\nconst request = await receiveWrapperRequest();\nif (request) console.log(JSON.stringify({ answer: request.instruction }));\n`, { mode: 0o755 });
  const result = run('worker', [{
    id: 'agent', type: 'agent', cli, instruction: 'local-worker-proof',
    surfaces: { streams: [{ stream: 'local-proof' }] },
    verification: { type: 'json_schema', schema: {
      type: 'object', required: ['answer'], properties: { answer: { const: 'local-worker-proof' } },
    } },
  }]);
  assert.equal(result.status, 0, result.stderr);
  const completion = result.records.find(entry => entry.entry_type === 'step.completed');
  assert.equal(completion.payload.completionReason, 'success');
  assert.deepEqual(completion.payload.output, { answer: 'local-worker-proof' });
  assert.equal(result.records.at(-1).completedSteps, 1);
});

test('missing daemon is refused before a data directory or run is created', () => {
  const result = run('missing-daemon', [{ id: 'hello', type: 'deterministic', command: 'echo hello' }], {
    RELAYFLOWD_BIN: join(fixtures, 'absent-relayflowd'),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LOCAL_DAEMON_MISSING/);
  assert.equal(result.dataDir, undefined);
});
