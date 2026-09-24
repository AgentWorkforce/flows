import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      + 'completionReason: worker_error exit=1.\nStderr (captured excerpt):\nno such model',
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
/**
 * A `.flow.ts` used to be the one path that parked for want of a worker and
 * said nothing about how to fix it: `classifyOutcome` suppressed the hint
 * because the bare `flows run --local-agent <path>` it emitted would have been
 * unrunnable without the flow's `--input`. The remedy now comes from this
 * boundary, which holds the path, the input and the attachment state.
 */
function parkedForWantOfWorker(): AuthoredFlowExecutionError {
  const error = new AuthoredFlowExecutionError('agent_parked',
    'Run "child-run" parked at step "agent-1" (agent): no worker is attached for step type "agent".',
    undefined, 'child-run');
  error.parkCause = 'worker_unavailable';
  return error;
}

it('names a runnable new run, with the same --input, when an authored flow parks for want of a worker', async () => {
  vi.mocked(executeDurableAuthoredFlow).mockRejectedValueOnce(parkedForWantOfWorker());
  const result = await runDirectFlow('my flows/a.flow.ts', '{"plan":"v2"}', '/tmp/unused');
  expect(result.exitCode).toBe(3);
  expect(result.report.parkCause).toBe('worker_unavailable');
  const message = result.report.diagnostics.at(-1)!.message;
  // Quoted path, the original input repeated verbatim, and the data dir this
  // run used — everything a copy-paste needs, in one command.
  expect(message).toContain(
    `flows run --local-agent 'my flows/a.flow.ts' --input '{"plan":"v2"}' --data-dir /tmp/unused`);
});

it('does not tell someone who already passed --local-agent to pass it again', async () => {
  vi.mocked(executeDurableAuthoredFlow).mockRejectedValueOnce(parkedForWantOfWorker());
  const result = await runDirectFlow('flow.ts', '{}', '/tmp/unused', { localAgent: true });
  expect(result.exitCode).toBe(3);
  const message = result.report.diagnostics.at(-1)!.message;
  expect(message).toContain('already attached');
  expect(message).not.toContain('flows run --local-agent');
});

it('says nothing about workers when the kernel is waiting for a human to recover the step', async () => {
  const error = parkedForWantOfWorker();
  error.parkCause = 'needs_human';
  vi.mocked(executeDurableAuthoredFlow).mockRejectedValueOnce(error);
  const result = await runDirectFlow('flow.ts', '{}', '/tmp/unused');
  expect(result.exitCode).toBe(3);
  // Attaching a worker does not clear a manual-recovery wait, so recommending
  // one would send someone to fix the wrong thing.
  expect(result.report.diagnostics.at(-1)!.message).not.toContain('--local-agent');
});

it('repeats the --input argument as given, including a file path', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'flows-input-')), 'plan.json');
  writeFileSync(file, '{"plan":"v2"}');
  vi.mocked(executeDurableAuthoredFlow).mockRejectedValueOnce(parkedForWantOfWorker());
  // `--input` takes inline JSON *or* a file (direct-input.ts). Re-rendering the
  // argument verbatim keeps the second run reading the same file; re-rendering
  // the parsed value would inline a snapshot of it instead.
  const result = await runDirectFlow('flow.ts', file, '/tmp/unused');
  expect(result.report.diagnostics.at(-1)!.message).toContain(`--input '${file}'`);
});

it('reports the root separately from the child holding failure evidence', async () => {
  const error = new AuthoredFlowExecutionError('step_failed', 'child failed', undefined, 'child-run');
  error.rootRunId = 'root-run';
  vi.mocked(executeDurableAuthoredFlow).mockRejectedValueOnce(error);
  const result = await runDirectFlow('flow.ts', '{}', '/tmp/unused');
  expect(result.report).toMatchObject({ runId: 'child-run', rootRunId: 'root-run', status: 'failed' });
});
