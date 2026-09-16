import { expect, it, vi } from 'vitest';
import { runDirectFlow } from '../src/cli/direct-run.js';
import { AuthoredFlowExecutionError } from '../src/authored-flow-executor.js';
import { executeDurableAuthoredFlow } from '../src/authored-root.js';
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
vi.mock('../src/authored-root.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/authored-root.js')>(), executeDurableAuthoredFlow: vi.fn(),
}));
vi.mock('../src/local-agent.js', () => ({ attachLocalAgent: async () => ({
  failure: new Error('worker transport closed'), stream: 'test', close: async () => {},
}) }));
it.each([
  ['agent_cli_unresolved', 2], ['agent_parked', 3], ['step_failed', 1],
  ['llm_cli_unresolved', 2], ['llm_parked', 3],
] as const)('preserves authored %s classification despite a worker failure', async (code, exitCode) => {
  vi.mocked(executeDurableAuthoredFlow).mockRejectedValueOnce(
    new AuthoredFlowExecutionError(code, 'authored cause', undefined, 'durable-run'),
  );
  const result = await runDirectFlow('flow.ts', '{}', '/tmp/unused', { localAgent: true });
  expect(result.exitCode).toBe(exitCode);
  expect(JSON.stringify(result.report)).toContain('authored cause');
  expect(JSON.stringify(result.report)).not.toContain('worker transport closed');
  if (exitCode !== 2) expect(result.report.runId).toBe('durable-run');
});
it('reports an authored step failure as step_failed with a known status, not protocol_error', async () => {
  vi.mocked(executeDurableAuthoredFlow).mockRejectedValueOnce(new AuthoredFlowExecutionError(
    'step_failed',
    'Run "child-run" failed with completionReason: step_failed. Step "agent-2" (agent) '
      + 'completionReason: worker_error exit=1.\nStderr (last 1,024 bytes):\nno such model',
    undefined,
    'child-run',
  ));
  const result = await runDirectFlow('flow.ts', '{}', '/tmp/unused', { localAgent: true });
  expect(result.exitCode).toBe(1);
  // A step that ran and failed is a run failure. Reporting it as a daemon
  // protocol failure blamed the wrong component, and left the report with no
  // status — which is what printed `RUN <id> unknown` about a known outcome.
  expect(result.report.status).toBe('failed');
  expect(result.report.completionReason).toBe('step_failed');
  const kinds = result.report.diagnostics.map(diagnostic => diagnostic.kind);
  expect(kinds).toContain('step_failed');
  expect(kinds).not.toContain('protocol_error');
  expect(JSON.stringify(result.report)).not.toContain('could not complete the run request');
  // The evidence carried up from classifyOutcome must survive the hand-off.
  expect(JSON.stringify(result.report)).toContain('no such model');
});
it('uses the worker cause when the authored executor only saw a generic disconnect', async () => {
  vi.mocked(executeDurableAuthoredFlow).mockRejectedValueOnce(new Error('connection closed'));
  const result = await runDirectFlow('flow.ts', '{}', '/tmp/unused', { localAgent: true });
  expect(result.exitCode).toBe(1);
  expect(JSON.stringify(result.report)).toContain('worker transport closed');
});
