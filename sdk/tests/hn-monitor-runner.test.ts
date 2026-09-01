import { describe, expect, it, vi } from 'vitest';
import { HnMonitorRunner, type HnMonitorRunnerOptions } from '../src/hn-monitor-runner.js';

function harness(overrides: Partial<HnMonitorRunnerOptions> = {}) {
  const calls: string[] = [];
  const controller = new AbortController();
  const client = {
    connect: vi.fn(async () => { calls.push('connect'); }),
    close: vi.fn(() => { calls.push('client.close'); }),
    eventSubmit: vi.fn(async () => { calls.push('submit'); return {}; }),
  };
  const worker = {
    attach: vi.fn(async () => { calls.push('attach'); }),
    close: vi.fn(() => { calls.push('worker.close'); }),
  };
  const options: HnMonitorRunnerOptions = {
    socketPath: '/unused.sock',
    spec: { name: 'hn-monitor' },
    workerId: 'hn-worker',
    pins: {},
    signal: controller.signal,
    pollIntervalMs: 1,
    fetcher: async () => '[1]',
    client,
    worker,
    ...overrides,
  };
  return { runner: new HnMonitorRunner(options), controller, client, worker, calls };
}

describe('HnMonitorRunner', () => {
  it('submits an event on each tick', async () => {
    const h = harness();
    h.client.eventSubmit.mockImplementation(async () => {
      h.calls.push('submit');
      if (h.client.eventSubmit.mock.calls.length === 2) h.controller.abort();
      return {};
    });

    await h.runner.run();

    expect(h.client.eventSubmit).toHaveBeenCalledTimes(2);
  });

  it('aborts cleanly and closes the worker and client within one tick', async () => {
    const h = harness({ pollIntervalMs: 10_000 });
    h.client.eventSubmit.mockImplementation(async () => {
      h.controller.abort();
      return {};
    });

    await h.runner.run();

    expect(h.worker.close).toHaveBeenCalledOnce();
    expect(h.client.close).toHaveBeenCalledOnce();
  });

  it('attaches the worker before the first poll', async () => {
    const h = harness();
    h.client.eventSubmit.mockImplementation(async () => {
      h.calls.push('submit');
      h.controller.abort();
      return {};
    });

    await h.runner.run();

    expect(h.calls.indexOf('attach')).toBeLessThan(h.calls.indexOf('submit'));
  });

  it('reports a fetch error and continues with the next tick', async () => {
    const onPollError = vi.fn();
    let fetches = 0;
    const h = harness({
      onPollError,
      fetcher: async () => {
        fetches += 1;
        if (fetches === 1) throw new Error('temporary fetch failure');
        h.controller.abort();
        return '[2]';
      },
    });

    await h.runner.run();

    expect(onPollError).toHaveBeenCalledOnce();
    expect(fetches).toBe(2);
    expect(h.client.eventSubmit).toHaveBeenCalledOnce();
  });

  it('terminates when a journal submission throws', async () => {
    const journalError = new Error('journal write failed');
    const h = harness();
    h.client.eventSubmit.mockRejectedValue(journalError);

    await expect(h.runner.run()).rejects.toBe(journalError);
    expect(h.worker.close).toHaveBeenCalledOnce();
    expect(h.client.close).toHaveBeenCalledOnce();
  });
});
