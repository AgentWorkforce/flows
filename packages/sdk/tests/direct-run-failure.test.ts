import { expect, it, vi } from 'vitest';
import { runDirectFlow } from '../src/cli/direct-run.js';
import { AuthoredFlowExecutionError, executeAuthoredFlow } from '../src/authored-flow-executor.js';
vi.mock('../src/journal-client.js', () => ({ JournalClient: class {
  async connect() {}
  async hello() {}
  async workerAttach() {}
  on() {}
  off() {}
  close() {}
} }));
vi.mock('../src/cli/run.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/cli/run.js')>(), connect: async () => undefined,
}));
vi.mock('../src/authored-flow-loader.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/authored-flow-loader.js')>(),
  loadAuthoredFlow: async () => ({ handle: {}, getDefinition: () => ({}) }),
}));
vi.mock('../src/authored-flow-executor.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/authored-flow-executor.js')>(), executeAuthoredFlow: vi.fn(),
}));
vi.mock('../src/local-agent.js', () => ({ attachLocalAgent: async () => ({
  failure: new Error('worker transport closed'), stream: 'test', close: async () => {},
}) }));
it.each([
  ['agent_cli_unresolved', 2], ['agent_parked', 3], ['step_failed', 1],
  ['llm_cli_unresolved', 2], ['llm_parked', 3],
] as const)('preserves authored %s classification despite a worker failure', async (code, exitCode) => {
  vi.mocked(executeAuthoredFlow).mockRejectedValueOnce(new AuthoredFlowExecutionError(code, 'authored cause', undefined, 'durable-run'));
  const result = await runDirectFlow('flow.ts', '{}', '/tmp/unused', { localAgent: true });
  expect(result.exitCode).toBe(exitCode);
  expect(JSON.stringify(result.report)).toContain('authored cause');
  expect(JSON.stringify(result.report)).not.toContain('worker transport closed');
  if (exitCode !== 2) expect(result.report.runId).toBe('durable-run');
});
it('uses the worker cause when the authored executor only saw a generic disconnect', async () => {
  vi.mocked(executeAuthoredFlow).mockRejectedValueOnce(new Error('connection closed'));
  const result = await runDirectFlow('flow.ts', '{}', '/tmp/unused', { localAgent: true });
  expect(result.exitCode).toBe(1);
  expect(JSON.stringify(result.report)).toContain('worker transport closed');
});
