import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { HnMonitorPollError, HnMonitorRunner } from '../src/hn-monitor-runner.js';

class FakeClient extends EventEmitter {
  readonly calls: string[] = [];
  readonly eventSubmit = vi.fn(async (): Promise<unknown> => ({ matched: true }));

  async connect(): Promise<void> { this.calls.push('connect'); }
  async hello(): Promise<unknown> { this.calls.push('hello'); return {}; }
  close(): void { this.calls.push('client.close'); }
}

function runnerWith(
  client: FakeClient,
  controller: AbortController,
  overrides: Partial<ConstructorParameters<typeof HnMonitorRunner>[0]> = {},
): { runner: HnMonitorRunner; workerCalls: string[] } {
  const workerCalls: string[] = [];
  const runner = new HnMonitorRunner({
    socketPath: '/unused.sock',
    spec: { name: 'hn-monitor' },
    workerId: 'hn-monitor-test',
    pins: {},
    signal: controller.signal,
    pollIntervalMs: 0,
    fetcher: async () => '[1]',
    clientFactory: () => client,
    workerFactory: () => ({
      async attach() { workerCalls.push('attach'); client.calls.push('worker.attach'); },
      async close() { workerCalls.push('close'); client.calls.push('worker.close'); },
    }),
    ...overrides,
  });
  return { runner, workerCalls };
}

describe('HnMonitorRunner', () => {
  it('submits an event on every tick', async () => {
    const client = new FakeClient();
    const controller = new AbortController();
    client.eventSubmit.mockImplementation(async () => {
      if (client.eventSubmit.mock.calls.length === 3) controller.abort();
      return { matched: true };
    });

    await runnerWith(client, controller).runner.run();

    expect(client.eventSubmit).toHaveBeenCalledTimes(3);
  });

  it('attaches before the first poll and shuts down cleanly on abort', async () => {
    const client = new FakeClient();
    const controller = new AbortController();
    client.eventSubmit.mockImplementation(async () => {
      client.calls.push('event.submit');
      controller.abort();
      return { matched: true };
    });

    const { runner, workerCalls } = runnerWith(client, controller);
    await runner.run();

    expect(client.calls).toEqual([
      'connect', 'hello', 'worker.attach', 'event.submit', 'worker.close', 'client.close',
    ]);
    expect(workerCalls).toEqual(['attach', 'close']);
  });

  it('reports a typed fetch error and continues to the next tick', async () => {
    const client = new FakeClient();
    const controller = new AbortController();
    const errors: HnMonitorPollError[] = [];
    let fetches = 0;

    const { runner } = runnerWith(client, controller, {
      fetcher: async () => {
        fetches += 1;
        if (fetches === 1) throw new Error('network down');
        controller.abort();
        return '[2]';
      },
      onPollError: (error) => errors.push(error),
    });
    await runner.run();

    expect(fetches).toBe(2);
    expect(client.eventSubmit).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(HnMonitorPollError);
  });

  it('terminates when the journal rejects an event', async () => {
    const client = new FakeClient();
    const controller = new AbortController();
    const journalError = new Error('journal write failed');
    client.eventSubmit.mockRejectedValue(journalError);

    const { runner, workerCalls } = runnerWith(client, controller);
    await expect(runner.run()).rejects.toBe(journalError);

    expect(client.eventSubmit).toHaveBeenCalledTimes(1);
    expect(workerCalls).toEqual(['attach', 'close']);
    expect(client.calls.at(-1)).toBe('client.close');
  });
});
