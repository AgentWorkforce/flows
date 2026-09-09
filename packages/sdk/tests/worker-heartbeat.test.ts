import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JournalClient } from '../src/journal-client.js';
import type { StepDispatchEvent } from '../src/protocol.js';
import { AgentWorker } from '../src/worker.js';
import { runAgentCli, type WorkerCliResult } from '../src/worker-cli.js';

vi.mock('../src/worker-cli.js', () => ({ runAgentCli: vi.fn() }));
const result = { exit_code: 0, stdout_tail: 'DONE', stderr_tail: '' };
const dispatch: StepDispatchEvent = {
  run_id: 'run', step_id: 'agent', attempt: 1, step_type: 'agent',
  spec: { cli: 'claude', instruction: 'work' }, lease_id: 'lease',
  idempotency_key: 'idem', pins: { workspace: [], streams: [] },
  lease_deadline_ms: 30_000,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function setup() {
  const cli = deferred<WorkerCliResult>();
  vi.mocked(runAgentCli).mockReturnValue(cli.promise);
  let deadline = Date.now() + 30_000;
  const client = Object.assign(new EventEmitter(), {
    workerAttach: vi.fn(async () => ({})),
    stepHeartbeat: vi.fn(async (..._args: unknown[]) => {
      if (Date.now() >= deadline) throw new Error('lease expired');
      deadline = Date.now() + 30_000;
      return { lease_deadline_ms: deadline };
    }),
    stepComplete: vi.fn(async (..._args: unknown[]) => {
      if (Date.now() >= deadline) throw new Error('lease expired');
      return {};
    }),
  });
  const worker = new AgentWorker(client as unknown as JournalClient, {
    workerId: 'worker', pins: dispatch.pins,
  });
  const errors: unknown[] = [];
  worker.on('error', error => errors.push(error));
  await worker.attach();
  client.emit('step.dispatch', dispatch);
  return { cli, client, worker, errors };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe('AgentWorker lease heartbeat', () => {
  it.each([34_000, 600_000])('completes an agent step lasting %i simulated ms', async duration => {
    const { cli, client, worker, errors } = await setup();
    await vi.advanceTimersByTimeAsync(duration);
    cli.resolve(result);
    await worker.close();
    expect(errors).toEqual([]);
    expect(client.stepHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(Math.floor(duration / 10_000));
    expect(client.stepHeartbeat).toHaveBeenCalledWith('run', 'agent', 1, 'lease');
    expect(client.stepComplete).toHaveBeenCalledWith('run', 'agent', 1, 'idem', 'success', {
      output: result, started_pins: dispatch.pins, end_pins: dispatch.pins,
    });
    const renewals = client.stepHeartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.stepHeartbeat).toHaveBeenCalledTimes(renewals);
  });

  it.each([0, 1])('stops renewing after CLI exit %i without closing the worker', async exit_code => {
    const { cli, client, worker, errors } = await setup();
    await vi.advanceTimersByTimeAsync(10_000);
    cli.resolve({ ...result, exit_code });
    await vi.advanceTimersByTimeAsync(0);
    const renewals = client.stepHeartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.stepHeartbeat).toHaveBeenCalledTimes(renewals);
    expect(client.stepComplete.mock.calls[0]?.[4]).toBe(exit_code === 0 ? 'success' : 'worker_error');
    expect(errors).toEqual([]);
    await worker.close();
  });

  it('stops renewing when CLI execution throws', async () => {
    const { cli, client, worker, errors } = await setup();
    await vi.advanceTimersByTimeAsync(10_000);
    cli.reject(new Error('CLI broke'));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.stepHeartbeat).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([new Error('CLI broke')]);
    await worker.close();
  });

  it('stops renewing at close even while the CLI is still running', async () => {
    const { cli, client, worker } = await setup();
    await vi.advanceTimersByTimeAsync(10_000);
    const closing = worker.close();
    client.emit('step.dispatch', { ...dispatch, step_id: 'ignored' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.stepHeartbeat).toHaveBeenCalledTimes(1);
    expect(runAgentCli).toHaveBeenCalledTimes(1);
    cli.resolve(result);
    await closing;
  });

  it('surfaces a renewal failure and still submits the CLI result', async () => {
    const { cli, client, worker, errors } = await setup();
    client.stepHeartbeat.mockRejectedValue(new Error('renewal write failed'));
    await vi.advanceTimersByTimeAsync(20_000);
    cli.resolve(result);
    await worker.close();
    expect(client.stepHeartbeat).toHaveBeenCalledTimes(1);
    expect(client.stepComplete).toHaveBeenCalledWith('run', 'agent', 1, 'idem', 'worker_error', {
      output: result, started_pins: dispatch.pins, end_pins: dispatch.pins,
    });
    expect(errors).toEqual([new Error('renewal write failed')]);
  });

  it('does not overlap renewals or complete before a pending renewal settles', async () => {
    const { cli, client, worker, errors } = await setup();
    const renewal = deferred<{ lease_deadline_ms: number }>();
    client.stepHeartbeat.mockReturnValue(renewal.promise);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(client.stepHeartbeat).toHaveBeenCalledTimes(1);
    cli.resolve(result);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.stepComplete).not.toHaveBeenCalled();
    renewal.resolve({ lease_deadline_ms: 50_000 });
    await worker.close();
    expect(client.stepComplete).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.stepHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('retains renewal and completion errors together', async () => {
    const { cli, client, worker, errors } = await setup();
    client.stepHeartbeat.mockRejectedValue(new Error('renewal failed'));
    client.stepComplete.mockRejectedValue(new Error('completion failed'));
    await vi.advanceTimersByTimeAsync(10_000);
    cli.resolve(result);
    await worker.close();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(AggregateError);
    expect((errors[0] as AggregateError).errors).toEqual([
      new Error('renewal failed'), new Error('completion failed'),
    ]);
  });

  it('keeps another dispatch renewing when the first finishes', async () => {
    const { cli, client, worker } = await setup();
    const second = deferred<WorkerCliResult>();
    vi.mocked(runAgentCli).mockReturnValue(second.promise);
    client.emit('step.dispatch', { ...dispatch, step_id: 'second', lease_id: 'lease-2' });
    await vi.advanceTimersByTimeAsync(10_000);
    cli.resolve(result);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.stepHeartbeat.mock.calls.map(call => call[1])).toEqual(['agent', 'second', 'second']);
    second.resolve(result);
    await worker.close();
  });


  it('does not rearm an acknowledged heartbeat after close begins', async () => {
    const { cli, client, worker, errors } = await setup();
    const renewal = deferred<{ lease_deadline_ms: number }>();
    client.stepHeartbeat.mockReturnValue(renewal.promise);
    await vi.advanceTimersByTimeAsync(10_000);
    const closing = worker.close();
    renewal.resolve({ lease_deadline_ms: 40_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    cli.resolve(result);
    await closing;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.stepHeartbeat).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });

});
