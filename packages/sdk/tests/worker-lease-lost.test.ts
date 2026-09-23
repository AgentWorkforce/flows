import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JournalClient, JournalProtocolError } from '../src/journal-client.js';
import type { StepDispatchEvent } from '../src/protocol.js';
import { AgentWorker } from '../src/worker.js';
import { LlmWorker } from '../src/llm-worker.js';
import { runAgentCli } from '../src/worker-cli.js';
import { isLeaseLost, onWorkerFailure, withWorkerLease } from '../src/worker-lease.js';

vi.mock('../src/worker-cli.js', () => ({ runAgentCli: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); });

function setup(type: 'agent' | 'llm') {
  vi.useFakeTimers();
  const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
  const client = Object.assign(new EventEmitter(), {
    workerAttach: vi.fn(async () => ({})),
    stepHeartbeat: vi.fn(async () => ({ lease_deadline_ms: Date.now() + 30_000 })),
    stepComplete: vi.fn(async () => ({})),
    close: vi.fn(),
  });
  const worker = type === 'agent'
    ? new AgentWorker(client as unknown as JournalClient, { workerId: 'test', pins: { workspace: [], streams: [] } })
    : new LlmWorker(client as unknown as JournalClient, 'test');
  const fatal = vi.fn((error: unknown) => client.close(error));
  worker.on('error', onWorkerFailure('test', fatal));
  const dispatch: StepDispatchEvent = {
    type: 'step.dispatch', run_id: 'run', step_id: 'step', attempt: 1,
    step_type: type, spec: { cli: 'claude', instruction: 'hello', prompt: 'hello' },
    lease_id: 'lease', lease_deadline_ms: Date.now() + 30_000,
    idempotency_key: 'effect', pins: { workspace: [], streams: [] },
  };
  vi.mocked(runAgentCli).mockResolvedValue({ exit_code: 0, stdout_tail: 'hello', stderr_tail: '' });
  return { client, worker, fatal, warning, dispatch };
}

describe.each(['agent', 'llm'] as const)('%s stale lease subscriber', type => {
  it('drops an expired dispatch and completes the kernel retry', async () => {
    const { client, worker, fatal, warning, dispatch } = setup(type);
    await worker.attach();
    client.emit('step.dispatch', { ...dispatch, lease_deadline_ms: Date.now() - 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(runAgentCli).not.toHaveBeenCalled();
    expect(client.stepComplete).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
    expect(fatal).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('run_id=run step_id=step attempt=1'),
      { code: 'FLOWS_WORKER_LEASE_LOST' });
    client.emit('step.dispatch', { ...dispatch, attempt: 2, lease_id: 'retry' });
    await worker.close();
    expect(client.stepComplete).toHaveBeenCalledTimes(1);
    expect(client.stepComplete.mock.calls[0]).toEqual(expect.arrayContaining(['run', 'step', 2, 'success']));
  });

  it.each([
    ['stepHeartbeat', 'lease_conflict', 'step.heartbeat'],
    ['stepComplete', 'lease_conflict', 'step.complete'],
    ['stepComplete', 'run_terminal', 'step.complete'],
  ] as const)('drops %s %s after journal success', async (method, code, verb) => {
    const { client, worker, fatal, warning, dispatch } = setup(type);
    const error = new JournalProtocolError(code, 'attempt has no active worker lease');
    error.verb = verb;
    // The kernel already owns the completed outcome when the straggler arrives.
    const journal = { completionReason: 'success' };
    client[method].mockRejectedValueOnce(error);
    await worker.attach();
    client.emit('step.dispatch', dispatch);
    await worker.close();
    expect(journal.completionReason).toBe('success');
    expect(client.close).not.toHaveBeenCalled();
    expect(fatal).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(error.message), expect.anything());
  });

  it('keeps a non-lease worker error fatal with its original identity', async () => {
    const { client, worker, fatal, warning, dispatch } = setup(type);
    const error = new Error('cli exploded');
    client.stepHeartbeat.mockRejectedValueOnce(error);
    await worker.attach();
    client.emit('step.dispatch', dispatch);
    await worker.close();
    expect(fatal).toHaveBeenCalledWith(error);
    expect(client.close).toHaveBeenCalledWith(error);
    expect(warning).not.toHaveBeenCalled();
  });
});

it('preserves the heartbeat rejection through abort and finally', async () => {
  const { client, dispatch } = setup('llm');
  const error = new JournalProtocolError('lease_conflict', 'lost');
  client.stepHeartbeat.mockResolvedValueOnce({ lease_deadline_ms: Date.now() + 30_000 })
    .mockRejectedValueOnce(error);
  const result = withWorkerLease(client as unknown as JournalClient, dispatch, signal =>
    new Promise(resolve => signal.addEventListener('abort', () => resolve('aborted'))));
  const assertion = expect(result).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(10_000);
  await assertion;
});

it.each(['step.heartbeat', 'step.complete', 'step.wait'])('tags %s refusals at the client wrapper', async verb => {
  const client = new JournalClient('/unused');
  const error = new JournalProtocolError('run_terminal', 'finished');
  vi.spyOn(client, 'request').mockRejectedValueOnce(error);
  const request = verb === 'step.heartbeat' ? client.stepHeartbeat('r', 's', 1, 'lease')
    : verb === 'step.complete' ? client.stepComplete('r', 's', 1, 'key', 'success')
      : client.stepWait('r', 's', 1, 'key', { wait_id: 'w', prompt: '?', requested_of: 'human' });
  await expect(request).rejects.toBe(error);
  expect(error.verb).toBe(verb);
  expect(isLeaseLost(error)).toBe(true);
});

it('does not classify messages, causes, or unrelated terminal refusals as lease loss', () => {
  for (const error of [
    new Error('Agent lease is already expired'),
    new Error('wrapped', { cause: new JournalProtocolError('lease_conflict', 'lost') }),
    new JournalProtocolError('run_terminal', 'finished'),
    Object.assign(new JournalProtocolError('run_terminal', 'finished'), { verb: 'run.resume' }),
    new JournalProtocolError('journal_error', 'disk full'),
  ]) expect(isLeaseLost(error)).toBe(false);
});
