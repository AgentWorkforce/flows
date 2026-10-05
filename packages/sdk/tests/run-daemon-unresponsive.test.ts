import { afterEach, expect, it, vi } from 'vitest';
import { classifyOutcome } from '../src/cli/run.js';
import { JournalRequestTimeoutError, type JournalClient } from '../src/journal-client.js';
import { probeSocket } from '../src/daemon-connection.js';
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
