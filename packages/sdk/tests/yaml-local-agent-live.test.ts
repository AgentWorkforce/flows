import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { JournalClient } from '../src/journal-client.js';

const roots: string[] = [];
const cli = process.env['FLOWS_TEST_CLI'] ?? resolve('dist/cli.js');
const wrapper = resolve('tests/fixtures/yaml-agent-cli.mjs');

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

function fixture(source: 'step' | 'named' | 'flow' | 'project' = 'step', instruction = 'hello', workspace = false) {
  const relayflowd = process.env['RELAYFLOWD_BIN'] ?? join(JSON.parse(execFileSync('sh', [
    resolve('../../ops/cargo.sh'), 'metadata', '--format-version=1', '--no-deps', '--locked', '--offline',
  ], { cwd: resolve('../../kernel'), encoding: 'utf8' })).target_directory, 'debug/relayflowd');
  const root = mkdtempSync(join(tmpdir(), 'flows-yaml-local-'));
  roots.push(root);
  mkdirSync(join(root, 'flows'));
  chmodSync(wrapper, 0o755);
  symlinkSync(wrapper, join(root, 'agent.mjs'));
  writeFileSync(join(root, 'flows.json'), JSON.stringify({
    models: ['yaml-test-model'], ...(source === 'project' ? { cli: './agent.mjs' } : {}),
  }));
  const step = {
    id: 'greet', type: 'agent', instruction,
    ...(source === 'step' ? { cli: '../agent.mjs' } : {}),
    ...(source === 'named' ? { agent: 'greeter' } : { model: 'yaml-test-model' }),
    ...(workspace ? { surfaces: { workspace: [{ surface: 'repo' }] } } : {}),
  };
  const spec = {
    version: '0.1.0', name: 'yaml-local-agent',
    ...(source === 'flow' ? { cli: '../agent.mjs' } : {}),
    ...(source === 'named' ? { agents: { greeter: { cli: '../agent.mjs', model: 'yaml-test-model' } } } : {}),
    steps: [step],
  };
  writeFileSync(join(root, 'flows/hello.flow.yaml'), stringify(spec));
  // Run from outside the flow directory to exercise checked relative CLI binding.
  return { root, invoke: (localAgent = true) => spawnSync(process.execPath, [
    cli, 'run', 'flows/hello.flow.yaml', '--json', '--no-observer-link',
    '--data-dir', join(root, 'data'), ...(localAgent ? ['--local-agent'] : []),
  ], { cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, RELAYFLOWD_BIN: relayflowd } }) };
}

describe('YAML --local-agent through the built CLI and real daemon', () => {
  it.each(['step', 'named', 'flow', 'project'] as const)('runs with the checked %s CLI and model and journals done', async source => {
    const f = fixture(source);
    const result = f.invoke();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ ok: true, status: 'completed', completionReason: 'success', completedSteps: 1 });
    expect(report.resolutions).toContainEqual(expect.objectContaining({ stepId: 'greet', source, model: 'yaml-test-model' }));
    const client = new JournalClient(report.socketPath);
    try {
      await client.connect();
      await client.hello('yaml-local-agent-test');
      const snapshot = await client.runGet(report.runId);
      expect(snapshot.steps['greet']).toMatchObject({ type: 'agent', state: 'done' });
      const entries = await client.journalRead(report.runId, 1);
      expect(entries.entries).toContainEqual(expect.objectContaining({
        entry_type: 'step.completed', step_id: 'greet', payload: expect.objectContaining({
          completionReason: 'success', output: { instruction: 'hello', model: 'yaml-test-model' },
        }),
      }));
    } finally { client.close(); }
  });

  it('still parks without --local-agent', () => {
    const result = fixture().invoke(false);
    expect(result.status, result.stderr + result.stdout).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'parked', parkedStep: { id: 'greet', type: 'agent' } });
    expect(result.stderr).toContain("flows run --local-agent 'flows/hello.flow.yaml'");
  });

  it('reports the agent process failure', () => {
    const result = fixture('step', 'fail').invoke();
    expect(result.status, result.stderr + result.stdout).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, status: 'failed' });
  });

  it('preserves declared workspace surfaces that the local worker cannot pin', () => {
    const result = fixture('step', 'hello', true).invoke();
    expect(result.status, result.stderr + result.stdout).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'parked', parkedStep: { id: 'greet', type: 'agent' } });
  });
});
