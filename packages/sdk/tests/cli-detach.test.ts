import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCliArgs, runCli } from '../src/cli.js';
import { detachedArgv, emitDetachedHandle, startDetachedRun } from '../src/cli/detached-run.js';
import { DETACH_RECORD_ENV, readDetachedRecord, takeDetachedReceipt } from '../src/cli/detached-record.js';
import { localAgentRemedy } from '../src/cli/local-agent-remedy.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function record() {
  const root = mkdtempSync(join(tmpdir(), 'detach-record-'));
  roots.push(root);
  const path = join(root, 'record.json');
  const env = { [DETACH_RECORD_ENV]: path };
  const receipt = takeDetachedReceipt(env)!;
  expect(env).toEqual({});
  return { path, receipt };
}

describe('detached CLI contract', () => {
  it.each([
    ['check', '--detach', 'flow.yaml'], ['run', '--cloud', '--detach', 'flow.yaml'],
    ['run', '--detach', '--detach', 'flow.yaml'], ['status', '--detach', 'RUN'],
  ])('refuses mismatched flags: %j', (...args) => { expect(parseCliArgs(args)).toBeUndefined(); });

  it('accepts trailing detach and forwards every other argument unchanged', () => {
    const args = ['run', 'odd name.flow.ts', '--input', '{"text":"$`quoted`"}', '--local-agent',
      '--agent-capacity', '2', '--no-spawn', '--cloud-mirror', '--json', '--data-dir', './data', '--detach'];
    expect(parseCliArgs(args)).toMatchObject({ command: 'run', detach: true, localAgent: true, cloudMirror: true });
    expect(detachedArgv(args)).toEqual(args.slice(0, -1));
    expect(parseCliArgs(['resume', 'RUN', '--detach', '--allow-human-influenced']))
      .toMatchObject({ command: 'resume', detach: true, allowHumanInfluenced: true });
    expect(parseCliArgs(['run', 'flow@sha256:' + 'a'.repeat(64), '--bucket', 'file:///tmp/b', '--detach']))
      .toMatchObject({ command: 'run', detach: true });
    expect(parseCliArgs(['run', 'flow.yaml', '--reuse-from', 'RUN', '--detach']))
      .toMatchObject({ command: 'run', detach: true, reuseFromRunId: 'RUN' });
  });

  it('refuses the one-shot credential descriptor without consuming it or spawning', async () => {
    vi.stubEnv('FLOWS_LOCAL_AGENT_ENV_FD', '42');
    const result = await startDetachedRun(['run', '--detach', 'flow.yaml'], { command: 'run', dataDir: '/unused', noObserverLink: true });
    expect(result).toMatchObject({ execution: { exitCode: 2, report: {
      diagnostics: [{ kind: 'invalid_invocation', message: expect.stringContaining('detach_environment_fd_unsupported') }],
    } } });
    expect(process.env['FLOWS_LOCAL_AGENT_ENV_FD']).toBe('42');
  });

  it('discovers detach in help and in worker park remedies', async () => {
    const lines: string[] = [];
    await runCli(['--help'], { stdout: line => lines.push(line), stderr: () => {} });
    expect(lines[0]).toContain('[--detach]');
    for (const remedy of [
      { kind: 'spec-run', path: 'flow.yaml' }, { kind: 'spec-resume', runId: 'RUN' },
      { kind: 'authored-run', path: 'flow.ts', input: { kind: 'absent' } },
    ] as const) {
      expect(localAgentRemedy(remedy)).toContain('binds the worker to this terminal. Add --detach');
    }
    expect(localAgentRemedy({ kind: 'attached' })).not.toContain('--detach');
  });

  it('prints one JSON object without inventing an observer URL', () => {
    const lines: string[] = [];
    emitDetachedHandle({ detached: true, runId: 'RUN', pid: 123, logPath: '/log', recordPath: '/record',
      follow: 'flows status RUN', notice: 'May park' }, true, { stdout: line => lines.push(line), stderr: () => {} });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).not.toHaveProperty('observerUrl');
  });
});

describe('detached child receipts', () => {
  it('atomically retains the root id and late observer URL through completion', () => {
    const { receipt, path } = record();
    expect(readDetachedRecord(path)).toBeUndefined();
    receipt.started({ runId: 'ROOT' });
    expect(readDetachedRecord(path)).toMatchObject({ phase: 'started', runId: 'ROOT' });
    receipt.started({ runId: 'CHILD' });
    receipt.finished({ exitCode: 3, report: { command: 'run', ok: false, runId: 'CHILD', status: 'parked', resolutions: [], diagnostics: [] } });
    receipt.observerUrl('https://agentrelay.com/observer?key=ot_live_test');
    expect(readDetachedRecord(path)).toMatchObject({ phase: 'finished', runId: 'ROOT',
      observerUrl: 'https://agentrelay.com/observer?key=ot_live_test', execution: { exitCode: 3 } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('a resume refusal naming a run is not admission', () => {
    const { receipt, path } = record();
    receipt.finished({ exitCode: 2, report: { command: 'resume', ok: false, runId: 'OLD', resolutions: [], diagnostics: [] } });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ phase: 'refused', execution: { exitCode: 2 } });
    expect(readDetachedRecord(path)).not.toHaveProperty('runId');
  });
});
