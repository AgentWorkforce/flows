import { afterEach, expect, it, vi } from 'vitest';
import { runDirectFlow } from '../src/cli/direct-run.js';
import { JournalClient, JournalProtocolError } from '../src/journal-client.js';
import { LlmWorker } from '../src/llm-worker.js';
import { executeDurableAuthoredFlow } from '../src/authored-root.js';

vi.mock('../src/cli/run.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/cli/run.js')>(), connect: async () => undefined,
}));
vi.mock('../src/authored-flow-loader.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/authored-flow-loader.js')>(),
  loadAuthoredFlow: async () => ({ handle: {}, getDefinition: () => ({}) }),
}));
vi.mock('../src/authored-root.js', () => ({ executeDurableAuthoredFlow: vi.fn() }));
vi.mock('../src/local-agent.js', () => ({ attachLocalAgent: async () => ({
  stream: 'test', close: async () => {},
}) }));
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

it.each([false, true])('direct run handles LLM errors with leaseLost=%s', async leaseLost => {
  vi.spyOn(JournalClient.prototype, 'connect').mockResolvedValue();
  vi.spyOn(JournalClient.prototype, 'hello').mockResolvedValue({} as never);
  const close = vi.spyOn(JournalClient.prototype, 'close').mockReturnValue();
  vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
  const error = leaseLost ? new JournalProtocolError('lease_conflict', 'lost') : new Error('cli exploded');
  vi.spyOn(LlmWorker.prototype, 'attach').mockImplementation(async function (this: LlmWorker) {
    this.emit('error', error, { run_id: 'run', step_id: 'llm', attempt: 1 });
    expect(close).toHaveBeenCalledTimes(leaseLost ? 0 : 1);
  });
  vi.mocked(executeDurableAuthoredFlow).mockRejectedValueOnce(new Error('connection closed'));
  const result = await runDirectFlow('flow.ts', '{}', '/unused', { localAgent: true });
  expect(result.exitCode).toBe(1);
  expect(JSON.stringify(result.report)).toContain(leaseLost ? 'connection closed' : 'cli exploded');
});
