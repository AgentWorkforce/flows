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
  vi.spyOn(LlmWorker.prototype, 'attach').mockImplementation(async function () {
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
