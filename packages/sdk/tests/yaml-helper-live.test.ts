import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { JournalClient } from '../src/journal-client.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const connection = join(root, 'data/connection.json');
    if (existsSync(connection)) {
      const { pid } = JSON.parse(readFileSync(connection, 'utf8'));
      try { process.kill(pid, 'SIGTERM'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

it('runs compiled YAML helpers through the built CLI and kernel effect journal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yaml-helper-live-'));
  roots.push(root);
  const path = join(root, 'notify.yaml');
  writeFileSync(path, `version: 0.1.0
steps:
  - id: before
    type: deterministic
    command: "true"
  - id: notify
    dependsOn: [before]
    slack: {post: {channel: "#test", text: hi}}
  - id: after
    dependsOn: [notify]
    type: deterministic
    command: "true"
`);
  const metadata = spawnSync('sh', [resolve('../../ops/cargo.sh'), 'metadata', '--format-version=1', '--no-deps', '--locked', '--offline'],
    { cwd: resolve('../../kernel'), encoding: 'utf8' });
  expect(metadata.status, metadata.stderr).toBe(0);
  const binary = process.env.RELAYFLOWD_BIN ?? join(JSON.parse(metadata.stdout).target_directory, 'debug/relayflowd');
  const cli = process.env.FLOWS_TEST_CLI ?? resolve('dist/cli.js');
  const args = ['--json', '--no-observer-link', '--data-dir', join(root, 'data')];
  const invoke = (...command: string[]) => spawnSync(process.execPath, [cli, ...command, ...args], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, RELAYFLOWD_BIN: binary, RELAYFLOWS_SLACK_MOCK: '1' },
  });
  const result = invoke('run', path, '--local-agent');
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report).toMatchObject({ status: 'completed', completionReason: 'success', completedSteps: 3 });
  const client = new JournalClient(report.socketPath);
  try {
    await client.connect();
    await client.hello('yaml-helper-test');
    const entries = (await client.journalRead(report.runId, 1)).entries as Array<{ entry_type: string }>;
    expect(entries).toContainEqual(expect.objectContaining({ entry_type: 'step.completed', step_id: 'notify',
      payload: expect.objectContaining({ completionReason: 'success', output: expect.objectContaining({
        type: 'effect', provider: 'slack', verb: 'post',
        receipt: { channel: '#test', ts: 'mock-notify', ref: 'mock-ref-notify' },
      }) }) }));
    expect(entries.filter(entry => entry.entry_type === 'effect.recorded')).toHaveLength(1);
    const resumed = invoke('resume', report.runId);
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    const after = (await client.journalRead(report.runId, 1)).entries as Array<{ entry_type: string }>;
    expect(after.filter(entry => entry.entry_type === 'effect.recorded')).toHaveLength(1);
  } finally { client.close(); }
});
