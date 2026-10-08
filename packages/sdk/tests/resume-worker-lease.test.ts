import { AuthoredFlowExecutionError } from '../src/authored-flow-error.js';
import { afterEach, expect, it, vi } from 'vitest';
import { JournalClient, JournalProtocolError } from '../src/journal-client.js';
import { LlmWorker } from '../src/llm-worker.js';
import { resumeFlow } from '../src/cli/run.js';
import { readAuthoredRootMetadata, resumeDurableAuthoredFlow } from '../src/authored-root.js';

vi.mock('../src/daemon-lifecycle.js', () => ({
  ensureDaemon: async () => ({ kind: 'attached', socketPath: '/unused', connection: null }),
}));
vi.mock('../src/authored-root.js', () => ({
  readAuthoredRootMetadata: vi.fn(async () => ({ localAgentStream: 'stream' })),
  resumeDurableAuthoredFlow: vi.fn(async () => { throw new Error('connection closed'); }),
}));
vi.mock('../src/local-agent.js', () => ({
  attachLocalAgent: async () => ({ stream: 'stream', close: async () => {} }),
}));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it.each([false, true])('resume handles LLM errors with leaseLost=%s', async leaseLost => {
  vi.spyOn(JournalClient.prototype, 'connect').mockResolvedValue();
  vi.spyOn(JournalClient.prototype, 'hello').mockResolvedValue({} as never);
  const close = vi.spyOn(JournalClient.prototype, 'close').mockReturnValue();
  const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
  const error = leaseLost ? new JournalProtocolError('lease_conflict', 'lost') : new Error('cli exploded');
  vi.spyOn(LlmWorker.prototype, 'attach').mockImplementation(async function (this: LlmWorker) {
    expect(this.listenerCount('error')).toBe(1);
    this.emit('error', error, { run_id: 'run', step_id: 'llm', attempt: 1 });
    expect(close).toHaveBeenCalledTimes(leaseLost ? 0 : 1);
  });
  const result = await resumeFlow('run', '/unused', { localAgent: true });
  expect(readAuthoredRootMetadata).toHaveBeenCalled();
  expect(resumeDurableAuthoredFlow).toHaveBeenCalled();
  expect(result.exitCode).toBe(1);
  expect(JSON.stringify(result.report)).toContain(leaseLost ? 'connection closed' : 'cli exploded');
  expect(warning).toHaveBeenCalledTimes(leaseLost ? 1 : 0);
});

it('reports a read interruption without losing the resumable root', async () => {
  vi.spyOn(JournalClient.prototype, 'connect').mockResolvedValue();
  vi.spyOn(JournalClient.prototype, 'hello').mockResolvedValue({} as never);
  vi.spyOn(LlmWorker.prototype, 'attach').mockResolvedValue();
  const error = new AuthoredFlowExecutionError('daemon_unresponsive', 'read timed out under CPU load');
  error.rootRunId = 'saved-root';
  vi.mocked(resumeDurableAuthoredFlow).mockRejectedValueOnce(error);
  const result = await resumeFlow('saved-root', '/unused', { localAgent: true });
  expect(result).toMatchObject({ exitCode: 1, report: {
    command: 'resume', runId: 'saved-root', rootRunId: 'saved-root', status: 'running',
    diagnostics: [{ kind: 'daemon_unresponsive', message: expect.stringContaining('flows resume --data-dir /unused --local-agent saved-root') }],
  } });
});
