import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { classifyOutcome, emptyReport, type RunDiagnostic, type RunReport } from '../src/cli/run.js';
import { socketPathFor } from '../src/daemon-connection.js';
import * as daemonLifecycle from '../src/daemon-lifecycle.js';
import { JournalClient } from '../src/journal-client.js';
import { PROTOCOL_VERSION, type RunOutcome } from '../src/protocol.js';

const failure: RunOutcome = {
  run_id: 'run-failed', status: 'failed', completion_reason: 'step_failed', completed_steps: 0,
};
const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function completion(seq: number, stderr = '', exitCode = 7, stepId = 'fail-command', disposition = 'step_done') {
  return {
    seq, entry_type: 'step.completed', step_id: stepId,
    payload: {
      completionReason: exitCode === 0 ? 'success' : 'verification_failed', disposition,
      output: exitCode === 0 ? { exit_code: exitCode, stderr_tail: stderr } : null,
      ...(exitCode !== 0 ? { trajectory_tail: { exit_code: exitCode, stderr_tail: stderr } } : {}),
    },
  };
}

function stub(pages: unknown[][], type: 'deterministic' | 'agent' | 'llm' = 'deterministic') {
  const runGet = vi.fn(async () => ({ steps: { 'fail-command': { type, state: 'done' } } }));
  const journalRead = vi.fn(async () => ({ entries: pages.shift() ?? [] }));
  return { client: { runGet, journalRead } as unknown as JournalClient, runGet, journalRead };
}

async function classify(client: JournalClient, outcome = failure) {
  return classifyOutcome(client, 'run', outcome, emptyReport('run'), '/tmp/diagnostic.sock', {});
}

async function diagnosticFor(stderr: string) {
  const { client } = stub([[completion(1, stderr)]]);
  return (await classify(client)).report.diagnostics.at(-1) as RunDiagnostic;
}

describe('deterministic failure diagnostic', () => {
  it.each([false, true])('surfaces command exit, stderr and replay hint through the CLI (json=%s)', async json => {
    const dir = mkdtempSync(join(tmpdir(), 'flows-failure-'));
    directories.push(dir);
    writeFileSync(join(dir, 'flows.json'), '{}');
    const command = 'printf "shakedown intentional failure" >&2; exit 7';
    const path = join(dir, 'runtime-error.yaml');
    writeFileSync(path, `version: "0.1.0"\nname: runtime-error\nsteps:\n  - id: fail-command\n    type: deterministic\n    command: '${command}'\n`);
    // Execute the repro and supply the kernel's completion shape at the
    // client boundary. This tests CLI formatting independently of transport.
    const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
    expect(result.status).toBe(7);
    vi.spyOn(daemonLifecycle, 'ensureDaemon').mockResolvedValue({
      kind: 'attached', socketPath: socketPathFor(dir), connection: null,
    });
    vi.spyOn(JournalClient.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(JournalClient.prototype, 'hello').mockResolvedValue({ protocol: PROTOCOL_VERSION, server: 'relayflowd-test' });
    vi.spyOn(JournalClient.prototype, 'runStart').mockResolvedValue(failure);
    vi.spyOn(JournalClient.prototype, 'runGet').mockResolvedValue({
      run_id: failure.run_id, status: 'failed', budget: { tokens_in: 0, tokens_out: 0, dollars: '0' },
      steps: { 'fail-command': { type: 'deterministic', state: 'done' } },
    });
    vi.spyOn(JournalClient.prototype, 'journalRead').mockImplementation(async (_runId, fromSeq) => ({
      entries: fromSeq === 1 ? [completion(1, result.stderr, result.status!)] : [],
    }));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(['run', '--no-spawn', '--data-dir', dir, ...(json ? ['--json'] : []), path], {
      stdout: line => stdout.push(line), stderr: line => stderr.push(line),
    });
    expect(code).toBe(1);
    if (json) {
      const report = JSON.parse(stdout.join('\n')) as RunReport;
      expect(report.diagnostics).toContainEqual(expect.objectContaining({
        kind: 'step_failed', stepId: 'fail-command', exitCode: 7,
        stderrTail: 'shakedown intentional failure',
        hint: 'flows replay run-failed --at fail-command',
      }));
    } else {
      const output = stderr.join('\n');
      expect(output).toContain('FAILED [step_failed]');
      expect(output).toContain('exit=7');
      expect(output).toContain('shakedown intentional failure');
      expect(output).toContain('flows replay run-failed --at fail-command');
    }
  });

  it('keeps the last 1,024 bytes, not the prefix', async () => {
    const diagnostic = await diagnosticFor('discarded-prefix' + 'x'.repeat(2_000) + 'last error');
    expect(diagnostic.stderrTail).toBe('x'.repeat(1_014) + 'last error');
    expect(Buffer.byteLength(diagnostic.stderrTail!)).toBe(1_024);
    expect(diagnostic.message).not.toContain('discarded-prefix');
  });

  it('truncates at UTF-8 boundaries without splitting multibyte characters', async () => {
    const diagnostic = await diagnosticFor('🙂'.repeat(400) + 'é');
    expect(diagnostic.stderrTail).toBe('🙂'.repeat(255) + 'é');
    expect(Buffer.byteLength(diagnostic.stderrTail!)).toBeLessThanOrEqual(1_024);
    expect(diagnostic.stderrTail).not.toContain('\ufffd');
  });

  it('replaces binary and terminal controls and remains byte bounded', async () => {
    const binary = Buffer.from([0, 0xff, 0x1b, 13, 8]).toString('utf8');
    const diagnostic = await diagnosticFor(binary.repeat(1_000) + '\u009b31m\u202eEND\n\t');
    expect(diagnostic.stderrTail).toMatch(/END\n\t$/);
    expect(diagnostic.stderrTail).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\p{Cf}]/u);
    expect(Buffer.byteLength(diagnostic.stderrTail!)).toBeLessThanOrEqual(1_024);
  });

  it('includes an empty stderr field for a silent nonzero exit', async () => {
    expect(await diagnosticFor('')).toMatchObject({ exitCode: 7, stderrTail: '' });
  });

  it('reads later pages and ignores failed attempts superseded by success', async () => {
    const { client, journalRead } = stub([
      [completion(1, 'old error', 8, 'fail-command', 'retry')],
      [completion(2, '', 0)],
      [completion(3, 'final error', 7)],
    ]);
    const report = (await classify(client)).report;
    expect(report.diagnostics.at(-1)).toMatchObject({ exitCode: 7, stderrTail: 'final error' });
    expect(journalRead.mock.calls).toEqual([
      ['run-failed', 1, 100], ['run-failed', 2, 100], ['run-failed', 3, 100], ['run-failed', 4, 100],
    ]);
  });

  it('does not report recovered attempts or successful command output', async () => {
    const { client } = stub([[completion(1, 'old error'), completion(2, 'success stderr', 0)]]);
    expect((await classify(client)).report.diagnostics.at(-1)).not.toHaveProperty('exitCode');
  });

  it.each(['agent', 'llm'] as const)('leaves %s failure diagnostics unchanged', async type => {
    const { client, journalRead } = stub([[completion(1, 'worker stderr')]], type);
    expect((await classify(client)).report.diagnostics.at(-1)).toEqual({
      severity: 'failure', kind: 'step_failed',
      message: 'Run "run-failed" failed with completionReason: step_failed.',
    });
    expect(journalRead).not.toHaveBeenCalled();
  });

  it('does not inspect the journal or change diagnostics on success', async () => {
    const { client, runGet, journalRead } = stub([]);
    const execution = await classify(client, { ...failure, status: 'completed', completion_reason: 'success', completed_steps: 1 });
    expect(execution.exitCode).toBe(0);
    expect(execution.report.diagnostics).toEqual([]);
    expect(runGet).not.toHaveBeenCalled();
    expect(journalRead).not.toHaveBeenCalled();
  });

  it('preserves step_failed and explains failed journal inspection', async () => {
    const { client, journalRead } = stub([]);
    journalRead.mockRejectedValueOnce(new Error('journal unavailable'));
    const execution = await classify(client);
    expect(execution.exitCode).toBe(1);
    expect(execution.report.diagnostics.at(-1)).toMatchObject({
      kind: 'step_failed', message: expect.stringContaining('Could not inspect command failure: journal unavailable'),
    });
  });

  it('stops on non-advancing journal pages', async () => {
    const { client } = stub([[completion(1)], [completion(1)]]);
    expect((await classify(client)).report.diagnostics.at(-1)).toMatchObject({
      kind: 'step_failed', message: expect.stringContaining('invalid journal sequence'),
    });
  });
});
