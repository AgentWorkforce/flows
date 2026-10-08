import { afterEach, expect, it, vi } from 'vitest';
import { classifyOutcome } from '../src/cli/run.js';
import { JournalRequestTimeoutError, type JournalClient } from '../src/journal-client.js';
import { probeSocket } from '../src/daemon-connection.js';
import { JournalReadInterruptedError } from '../src/journal-read-policy.js';
vi.mock('../src/daemon-connection.js', async original => ({
  ...await original<typeof import('../src/daemon-connection.js')>(), probeSocket: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());
it.each([true, false])('reports an unreadable declarative run as resumable (reachable=%s)', async reachable => {
  vi.mocked(probeSocket).mockResolvedValue({ reachable });
  const client = { runGet: async () => { throw new JournalRequestTimeoutError('run.get', 10, 3, 100, 100); } };
  const result = await classifyOutcome(client as unknown as JournalClient, 'run', {
    run_id: 'saved-run', status: 'parked', completion_reason: null, completed_steps: 30,
  }, { command: 'run', ok: true, diagnostics: [] } as never, '/socket', {});
  expect(result).toMatchObject({ exitCode: 1, report: {
    runId: 'saved-run', rootRunId: 'saved-run', status: 'running',
    diagnostics: [{ kind: reachable ? 'daemon_unresponsive' : 'daemon_unreachable',
      message: expect.stringContaining('flows resume saved-run') }],
  } });
  expect(probeSocket).toHaveBeenCalledWith('/socket');
});

it('reports an interrupted read session as resumable rather than a failed run', async () => {
  vi.mocked(probeSocket).mockResolvedValue({ reachable: true });
  const client = { runGet: async () => {
    throw new JournalReadInterruptedError('run.get', 3, 100, 100, { cause: new Error('journal client: connection closed') });
  } };
  const result = await classifyOutcome(client as unknown as JournalClient, 'run', {
    run_id: 'saved-run', status: 'parked', completion_reason: null, completed_steps: 30,
  }, { command: 'run', ok: true, diagnostics: [] } as never, '/socket', {});
  expect(result).toMatchObject({ exitCode: 1, report: {
    runId: 'saved-run', status: 'running',
    diagnostics: [{ kind: 'daemon_unresponsive', message: expect.stringContaining('flows resume saved-run') }],
  } });
});

it('reports a completed run with an unread result as finished but with an unconfirmed verdict', async () => {
  const { completedResultUnreadableReport } = await import('../src/cli/journal-timeout.js');
  const { AuthoredFlowExecutionError } = await import('../src/authored-flow-error.js');
  const error = new AuthoredFlowExecutionError('result_unreadable', 'run r completed, but its stored result (the flow\'s verdict) could not be read', undefined, 'r');
  error.rootRunId = 'r';
  const execution = completedResultUnreadableReport('resume', { command: 'resume', ok: true, diagnostics: [] } as never, '/socket', error);
  expect(execution.exitCode).toBe(1);
  expect(execution.report).toMatchObject({ ok: false, status: 'completed', runId: 'r',
    diagnostics: [{ severity: 'warning', kind: 'result_unreadable', message: expect.stringContaining('flows status r') }] });
  expect(execution.report).not.toHaveProperty('completionReason');
  expect(JSON.stringify(execution.report)).not.toContain('flows resume');
});

it('marks a step_failed run whose inspection was interrupted', async () => {
  vi.mocked(probeSocket).mockResolvedValue({ reachable: true });
  const client = { journalRead: async () => { throw new JournalRequestTimeoutError('journal.read', 10, 3, 300_000, 300_000); },
    runGet: async () => { throw new JournalRequestTimeoutError('run.get', 10, 3, 300_000, 300_000); } };
  const result = await classifyOutcome(client as unknown as JournalClient, 'run', {
    run_id: 'failed-run', status: 'failed', completion_reason: 'step_failed', completed_steps: 1,
  }, { command: 'run', ok: true, diagnostics: [] } as never, '/socket', {});
  expect(result.report).toMatchObject({ status: 'failed', completionReason: 'step_failed' });
  expect(result.report.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', kind: 'inspection_interrupted' }));
});
