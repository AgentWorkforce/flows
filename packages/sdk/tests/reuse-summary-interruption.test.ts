import { expect, it } from 'vitest';
import { attachReuseSummary } from '../src/cli/reuse.js';
import { JournalFrameError, JournalReadInterruptedError, JournalRequestTimeoutError, type JournalClient } from '../src/journal-client.js';
import type { RunExecution } from '../src/cli/run.js';

const completed = (): RunExecution => ({ exitCode: 0, report: {
  command: 'run', ok: true, status: 'completed', completionReason: 'success', runId: 'run-1', diagnostics: [],
} as never });

it.each([
  ['timeout', new JournalRequestTimeoutError('journal.read', 10, 3, 300_000, 300_000)],
  ['interruption', new JournalReadInterruptedError('journal.read', 3, 300_000, 300_000)],
])('keeps the classified outcome when the reuse summary read hits a %s', async (_name, error) => {
  const client = { journalRead: async () => { throw error; } } as unknown as JournalClient;
  const execution = await attachReuseSummary(completed(), client, 'run-1', 'prior');
  expect(execution.exitCode).toBe(0);
  expect(execution.report).toMatchObject({ ok: true, status: 'completed', completionReason: 'success' });
  expect(execution.report.reuse).toBeUndefined();
  expect(execution.report.diagnostics).toEqual([expect.objectContaining({
    severity: 'warning', kind: 'reuse_summary_unavailable', message: expect.stringContaining('prior'),
  })]);
  expect(JSON.stringify(execution.report)).not.toContain('flows resume');
});

it('still attaches the summary when the read succeeds, and never lets the optional read discard the outcome', async () => {
  const ok = { journalRead: async (_run: string, from: number) => ({ entries: from === 1
    ? [{ seq: 1, entry_type: 'step.completed', step_id: 'a', payload: { reused_from: 'prior' } }] : [] }) } as unknown as JournalClient;
  expect((await attachReuseSummary(completed(), ok, 'run-1', 'prior')).report.reuse)
    .toEqual({ fromRunId: 'prior', reusedSteps: 1, executedSteps: 0 });
  for (const failure of [new Error('invalid journal sequence'), new JournalFrameError(),
    Object.assign(new Error('run canceled'), { name: 'AbortError' })]) {
    const broken = { journalRead: async () => { throw failure; } } as unknown as JournalClient;
    const execution = await attachReuseSummary(completed(), broken, 'run-1', 'prior');
    expect(execution.report).toMatchObject({ ok: true, status: 'completed' });
    expect(execution.report.diagnostics.at(-1)).toMatchObject({ kind: 'reuse_summary_unavailable', message: expect.stringContaining(failure.message) });
  }
});

it.each(['daemon_unresponsive', 'daemon_unreachable'])('does not start another read after classification reported %s', async kind => {
  let reads = 0;
  const client = { journalRead: async () => { reads += 1; return { entries: [] }; } } as unknown as JournalClient;
  const interrupted: RunExecution = { exitCode: 1, report: { command: 'run', ok: false, status: 'running', runId: 'run-1',
    diagnostics: [{ severity: 'failure', kind, message: 'read timed out' }] } as never };
  const execution = await attachReuseSummary(interrupted, client, 'run-1', 'prior');
  expect(reads).toBe(0);
  expect(execution).toBe(interrupted);
  expect(execution.report.reuse).toBeUndefined();
});
