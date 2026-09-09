import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, '.relayflow'), { recursive: true });
const fixtures = mkdtempSync(join(root, '.relayflow', 'launcher-tests-'));
const dataDirectories = new Set();
after(() => {
  for (const path of dataDirectories) rmSync(path, { recursive: true, force: true });
  rmSync(fixtures, { recursive: true, force: true });
});

function run(name, steps, env = {}, timeout = 15000) {
  const path = join(fixtures, `${name}.json`);
  writeFileSync(path, JSON.stringify({ version: '0.1.0', name, steps }));
  const result = spawnSync(process.execPath, ['scripts/run-local-workflow.mjs', path], {
    cwd: root, encoding: 'utf8', timeout, env: { ...process.env, ...env },
  });
  const dataDir = result.stdout.match(/^LOCAL_DATA_DIR=(.+)$/m)?.[1];
  if (dataDir) dataDirectories.add(dataDir);
  assert.equal(result.error, undefined, result.stderr);
  const records = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
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

function agentStep() {
  const cli = join(fixtures, 'completion-agent');
  const wrapper = join(root, 'testdata/preflight/wrapper-session.mjs');
  writeFileSync(cli, `#!/usr/bin/env node\nimport { receiveWrapperRequest } from ${JSON.stringify(wrapper)};\nif (await receiveWrapperRequest()) console.log('DONE');\n`, { mode: 0o755 });
  return {
    id: 'implement', type: 'agent', cli, instruction: 'Print DONE',
    surfaces: { streams: [{ stream: 'completion-proof' }] },
    verification: { type: 'output_contains', value: 'DONE' },
  };
}

test('an agent followed by work over 30 seconds reaches report and exports its journal', () => {
  // Exceed the real protocol timeout: both step.complete and a status read
  // queued behind it used to fail even though the agent had already succeeded.
  const result = run('slow-completion', [
    agentStep(),
    { id: 'verify', type: 'deterministic', dependsOn: ['implement'],
      command: 'sleep 32; printf VERIFIED', timeoutMs: 45000 },
    { id: 'report', type: 'deterministic', dependsOn: ['verify'], command: 'printf REPORTED' },
  ], {}, 55000);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /closed by caller|timed out|lease.*expired/);
  const journal = readFileSync(join(result.dataDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const completions = journal.filter(entry => entry.entry_type === 'step.completed');
  assert.deepEqual(completions.map(entry => entry.step_id), ['implement', 'verify', 'report']);
  assert(completions.every(entry => entry.payload.completionReason === 'success'));
  assert.equal(completions.at(-1).payload.output.stdout_tail, 'REPORTED');
  assert.equal(journal.at(-1).entry_type, 'run.completed');
  assert.equal(journal.at(-1).payload.completionReason, 'success');
  assert.equal(result.records.at(-1).completedSteps, 3);
});

test('a rejected worker completion preserves the protocol error and cannot report success', () => {
  const preload = join(fixtures, 'reject-completion.mjs');
  const clientPath = join(root, 'packages/sdk/dist/journal-client.js');
  // Submit a wrong idempotency key to the real daemon, producing a protocol
  // rejection while the launcher's control connection is waiting on the run.
  writeFileSync(preload, `import { JournalClient } from ${JSON.stringify(clientPath)};
const complete = JournalClient.prototype.stepComplete;
JournalClient.prototype.stepComplete = function(run, step, attempt, key, ...rest) {
  return complete.call(this, run, step, attempt, key + '-invalid', ...rest);
};
`);
  const result = run('rejected-completion', [agentStep()], {
    NODE_OPTIONS: `--import=${preload}`,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /completion does not match its active lease/);
  assert.doesNotMatch(result.stderr, /closed by caller/);
  assert(!result.records.some(record => record.ok === true));
});
