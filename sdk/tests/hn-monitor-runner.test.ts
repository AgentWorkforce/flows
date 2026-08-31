import { describe, expect, it, vi } from 'vitest';
import { HnMonitorRunner } from '../src/hn-monitor-runner.js';

function harness(fetcher: () => Promise<string>) {
  const calls: string[] = [];
  const controller = new AbortController();
  const client = {
    async connect() { calls.push('connect'); },
    close() { calls.push('client.close'); },
    async eventSubmit() { calls.push('submit'); return {}; },
  };
  const worker = {
    async attach() { calls.push('attach'); },
    async close() { calls.push('worker.close'); },
  };
  const runner = new HnMonitorRunner({
    socketPath: '/unused',
    spec: { name: 'hn-monitor' },
    workerId: 'hn-worker',
    pins: {},
    signal: controller.signal,
    fetcher,
    pollIntervalMs: 0,
    clientFactory: () => client,
    workerFactory: () => worker,
  });
  return { calls, client, controller, runner };
}

describe('HnMonitorRunner', () => {
  it('attaches before polling and submits events on each tick', async () => {
    let ticks = 0;
    const h = harness(async () => {
      h.calls.push('fetch');
      ticks += 1;
      if (ticks === 2) h.controller.abort();
      return '[1]';
    });
    await h.runner.run();
    expect(h.calls).toEqual([
      'connect', 'attach', 'fetch', 'submit', 'fetch', 'submit', 'worker.close', 'client.close',
    ]);
  });

  it('aborts cleanly within a sleeping tick and closes worker before client', async () => {
    const h = harness(async () => '[]');
    const running = h.runner.run();
    await vi.waitFor(() => expect(h.calls).toContain('attach'));
    h.controller.abort();
    await running;
    expect(h.calls.slice(-2)).toEqual(['worker.close', 'client.close']);
  });

  it('reports a fetch error and continues with the next tick', async () => {
    const errors: unknown[] = [];
    let ticks = 0;
    const h = harness(async () => {
      ticks += 1;
      if (ticks === 1) throw new Error('network unavailable');
      h.controller.abort();
      return '[2]';
    });
    const runner = new HnMonitorRunner({
      socketPath: '/unused', spec: {}, workerId: 'w', pins: {},
      signal: h.controller.signal, fetcher: async () => {
        ticks += 1;
        if (ticks === 1) throw new Error('network unavailable');
        h.controller.abort();
        return '[2]';
      },
      pollIntervalMs: 0, onPollError: (error) => errors.push(error),
      clientFactory: () => h.client,
      workerFactory: () => ({ async attach() {}, async close() {} }),
    });
    await runner.run();
    expect(errors).toHaveLength(1);
    expect(ticks).toBe(2);
    expect(h.calls).toContain('submit');
  });

  it('terminates when a journal submission fails', async () => {
    const journalError = new Error('journal write failed');
    const h = harness(async () => '[3]');
    h.client.eventSubmit = async () => { throw journalError; };
    await expect(h.runner.run()).rejects.toBe(journalError);
    expect(h.calls.slice(-2)).toEqual(['worker.close', 'client.close']);
  });
});
