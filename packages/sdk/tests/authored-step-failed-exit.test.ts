import { expect, it, vi } from 'vitest';
import { runDirectFlow } from '../src/cli/direct-run.js';
import { executeDurableAuthoredFlow } from '../src/authored-root.js';

// Same transport/loader fixtures as direct-run-failure.test.ts: the classification
// under test is the CLI's, not the daemon's.
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
  ...await importOriginal<typeof import('../src/authored-root.js')>(),
  executeDurableAuthoredFlow: vi.fn(),
}));

function completed(completionReason: 'success' | 'needs_human' | 'step_failed') {
  return {
    rootRunId: 'root-run',
    name: 'software-factory',
    completionReason,
    journalSteps: [
      { id: 'run-1', runId: 'child-1', completionReason: 'success' as const },
      { id: 'complete-2', runId: 'child-2', completionReason: 'success' as const },
    ],
  };
}

it('exits 1 and reports a failed run for an authored done("step_failed")', async () => {
  vi.mocked(executeDurableAuthoredFlow).mockResolvedValueOnce(completed('step_failed') as never);

  const result = await runDirectFlow('flow.ts', '{}', '/tmp/unused');

  expect(result.exitCode).toBe(1);
  expect(result.report.status).toBe('failed');
  expect(result.report.ok).toBe(false);
  expect(result.report.completionReason).toBe('step_failed');
  expect(result.report.runId).toBe('root-run');
  expect(result.report.completedSteps).toBe(2);
  const kinds = result.report.diagnostics.map(diagnostic => diagnostic.kind);
  expect(kinds).toContain('step_failed');
  // The production failure this fixes: a flow that expressed its own verdict
  // came back as a daemon protocol error the CLI could not classify.
  expect(kinds).not.toContain('protocol_error');
  expect(JSON.stringify(result.report)).not.toContain('unsupported_completion');
  expect(JSON.stringify(result.report)).not.toContain('cannot lower');
  // Not the parked exit 3 the local kit documents as its manual-approval stop.
  expect(result.report.status).not.toBe('parked');
});

it('names the verdict without inventing a failing step', async () => {
  vi.mocked(executeDurableAuthoredFlow).mockResolvedValueOnce(completed('step_failed') as never);

  const result = await runDirectFlow('flow.ts', '{}', '/tmp/unused');

  const message = result.report.diagnostics.map(diagnostic => diagnostic.message).join('\n');
  expect(message).toContain('done("step_failed")');
  expect(message).toContain('No step failed');
  // `authoredStepFailure` carries a failing step's id, exit code and output
  // tails. Nothing failed here, so none of that may be fabricated.
  expect(result.report.diagnostics.some(diagnostic => 'stepId' in diagnostic)).toBe(false);
});

it('leaves done("success") on exit 0 and done("needs_human") on exit 3', async () => {
  vi.mocked(executeDurableAuthoredFlow).mockResolvedValueOnce(completed('success') as never);
  const success = await runDirectFlow('flow.ts', '{}', '/tmp/unused');
  expect(success.exitCode).toBe(0);
  expect(success.report.ok).toBe(true);
  expect(success.report.status).toBe('completed');
  expect(success.report.completionReason).toBe('success');
  expect(success.report.completedSteps).toBe(2);

  vi.mocked(executeDurableAuthoredFlow).mockResolvedValueOnce(completed('needs_human') as never);
  const parked = await runDirectFlow('flow.ts', '{}', '/tmp/unused');
  expect(parked.exitCode).toBe(3);
  expect(parked.report.ok).toBe(false);
  expect(parked.report.status).toBe('parked');
  expect(parked.report.runId).toBe('root-run');
  expect(parked.report.diagnostics.map(diagnostic => diagnostic.kind)).toContain('run_parked');
});
