import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JournalClient } from '../src/journal-client.js';
import type { StepDispatchEvent } from '../src/protocol.js';
import { AgentWorker } from '../src/worker.js';
import { runAgentCli } from '../src/worker-cli.js';

vi.mock('../src/worker-cli.js', () => ({ runAgentCli: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

function setup() {
  vi.useFakeTimers();
  const client = Object.assign(new EventEmitter(), {
    workerAttach: vi.fn(async () => ({})),
    stepHeartbeat: vi.fn(async () => ({ lease_deadline_ms: Date.now() + 30_000 })),
    stepComplete: vi.fn(async () => ({})),
  });
  const worker = new AgentWorker(client as unknown as JournalClient, {
    workerId: 'lease-test', pins: { workspace: [], streams: [] },
  });
  const errors: unknown[] = [];
  worker.on('error', error => errors.push(error));
  const dispatch: StepDispatchEvent = {
    type: 'step.dispatch', run_id: 'run', step_id: 'agent', attempt: 1,
    step_type: 'agent', spec: { cli: 'claude', instruction: 'hello' },
    lease_id: 'lease', lease_deadline_ms: Date.now() + 30_000,
    idempotency_key: 'effect', pins: { workspace: [], streams: [] },
  };
  return { client, worker, errors, dispatch };
}

function runningCli(delay: number): AbortSignal[] {
  const signals: AbortSignal[] = [];
  vi.mocked(runAgentCli).mockImplementation(async (_cli, _instruction, _wake, _model, _limits, signal) => {
    signals.push(signal!);
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve({ exit_code: 0, stdout_tail: 'hello', stderr_tail: '' }), delay);
      signal!.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve({ exit_code: null, stdout_tail: '', stderr_tail: 'aborted' });
      }, { once: true });
    });
  });
  return signals;
}

describe('worker lease ownership', () => {
  it('renews the same attempt through a long subprocess and drains before completing once', async () => {
    const { client, worker, errors, dispatch } = setup();
    runningCli(35_000);
    await worker.attach();
    client.emit('step.dispatch', dispatch);
    const closing = worker.close();
    await vi.advanceTimersByTimeAsync(35_000);
    await closing;
    expect(errors).toEqual([]);
    expect(runAgentCli).toHaveBeenCalledTimes(1);
    expect(client.stepHeartbeat).toHaveBeenCalledTimes(4);
    expect(client.stepHeartbeat.mock.calls).toEqual(Array(4).fill(['run', 'agent', 1, 'lease']));
    expect(client.stepComplete).toHaveBeenCalledTimes(1);
    expect(client.stepComplete.mock.calls[0]).toEqual(expect.arrayContaining(['success']));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.stepHeartbeat).toHaveBeenCalledTimes(4);
  });

  it('aborts execution and never completes after a rejected heartbeat', async () => {
    const { client, worker, errors, dispatch } = setup();
    const failure = new Error('lease rejected');
    client.stepHeartbeat.mockResolvedValueOnce({ lease_deadline_ms: Date.now() + 30_000 })
      .mockRejectedValueOnce(failure);
    const signals = runningCli(60_000);
    await worker.attach();
    client.emit('step.dispatch', dispatch);
    await vi.advanceTimersByTimeAsync(10_001);
    await worker.close();
    expect(signals[0]?.aborted).toBe(true);
    expect(errors).toEqual([failure]);
    expect(client.stepComplete).not.toHaveBeenCalled();
  });

  it('expires locally when a renewal response never arrives, without stranding close', async () => {
    const { client, worker, errors, dispatch } = setup();
    client.stepHeartbeat.mockResolvedValueOnce({ lease_deadline_ms: Date.now() + 30_000 })
      .mockImplementationOnce(() => new Promise(() => {}));
    const signals = runningCli(60_000);
    await worker.attach();
    client.emit('step.dispatch', dispatch);
    await vi.advanceTimersByTimeAsync(30_001);
    await worker.close();
    expect(signals[0]?.aborted).toBe(true);
    expect(String(errors[0])).toContain('lease expired before renewal');
    expect(client.stepComplete).not.toHaveBeenCalled();
  });

  it('does not spawn a process for an already-expired dispatch', async () => {
    const { client, worker, errors, dispatch } = setup();
    dispatch.lease_deadline_ms = Date.now() - 1;
    await worker.attach();
    client.emit('step.dispatch', dispatch);
    await worker.close();
    expect(runAgentCli).not.toHaveBeenCalled();
    expect(client.stepComplete).not.toHaveBeenCalled();
    expect(String(errors[0])).toContain('already expired');
  });
});

it('refuses completion past the deadline even before the expiry timer runs', async () => {
  const { client, worker, errors, dispatch } = setup();
  vi.mocked(runAgentCli).mockImplementation(async () => {
    vi.setSystemTime(Date.now() + 30_001); // changes the clock WITHOUT running timers
    return { exit_code: 0, stdout_tail: 'late', stderr_tail: '' };
  });
  await worker.attach();
  client.emit('step.dispatch', dispatch);
  await worker.close();
  expect(runAgentCli).toHaveBeenCalledTimes(1);
  expect(client.stepComplete).not.toHaveBeenCalled();
  expect(String(errors[0])).toContain('lease expired before completion');
});

it('does not revive ownership when the initial heartbeat response is handled late', async () => {
  const { client, worker, errors, dispatch } = setup();
  client.stepHeartbeat.mockImplementationOnce(async () => {
    vi.setSystemTime(Date.now() + 30_001); // leave timer callbacks queued
    return { lease_deadline_ms: Date.now() + 30_000 };
  });
  await worker.attach();
  client.emit('step.dispatch', dispatch);
  await worker.close();
  expect(runAgentCli).not.toHaveBeenCalled();
  expect(client.stepComplete).not.toHaveBeenCalled();
  expect(String(errors[0])).toContain('lease expired before renewal');
});

it('aborts the CLI when a later heartbeat response would revive an expired lease', async () => {
  const { client, worker, errors, dispatch } = setup();
  client.stepHeartbeat.mockResolvedValueOnce({ lease_deadline_ms: Date.now() + 30_000 })
    .mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 20_001); // renewal starts at t=10s
      return { lease_deadline_ms: Date.now() + 30_000 };
    });
  const signals = runningCli(60_000);
  await worker.attach();
  client.emit('step.dispatch', dispatch);
  await vi.advanceTimersByTimeAsync(10_000);
  await worker.close();
  expect(client.stepHeartbeat).toHaveBeenCalledTimes(2);
  expect(signals[0]?.aborted).toBe(true);
  expect(client.stepComplete).not.toHaveBeenCalled();
  expect(String(errors[0])).toContain('lease expired before renewal');
});
