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

it('reports a completed run whose result could not be read as completed, not resumable', async () => {
  const { completedResultUnreadableReport } = await import('../src/cli/journal-timeout.js');
  const { AuthoredFlowExecutionError } = await import('../src/authored-flow-error.js');
  const error = new AuthoredFlowExecutionError('result_unreadable', 'run r completed (success), but its stored result could not be read', 'success', 'r');
  error.rootRunId = 'r';
  const execution = completedResultUnreadableReport('resume', { command: 'resume', ok: true, diagnostics: [] } as never, '/socket', error);
  expect(execution.exitCode).toBe(0);
  expect(execution.report).toMatchObject({ ok: true, status: 'completed', completionReason: 'success', runId: 'r',
    diagnostics: [{ severity: 'warning', kind: 'result_unreadable' }] });
  expect(JSON.stringify(execution.report)).not.toContain('flows resume');
});
