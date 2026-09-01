import { describe, expect, it, vi } from 'vitest';
import { HnMonitorRunner, HnPollFetchError } from '../src/hn-monitor-runner.js';

function harness(overrides: Record<string, unknown> = {}) {
  const order: string[] = [];
  const client = {
    connect: vi.fn(async () => { order.push('connect'); }),
    close: vi.fn(() => { order.push('client.close'); }),
    eventSubmit: vi.fn(async () => { order.push('submit'); }),
  };
  const worker = {
    attach: vi.fn(async () => { order.push('attach'); }),
    close: vi.fn(() => { order.push('worker.close'); }),
  };
  const controller = new AbortController();
  const runner = new HnMonitorRunner({ name: 'hn-monitor' }, {
    socketPath: '/unused.sock',
    workerId: 'hn-test',
    pins: {},
    signal: controller.signal,
    pollIntervalMs: 0,
    storyLimit: 1,
    fetcher: async () => '[1]',
    client,
    worker,
    ...overrides,
  });
  return { client, controller, order, runner, worker };
}

describe('HnMonitorRunner', () => {
  it('attaches before its first poll and submits on every tick', async () => {
    const h = harness();
    h.client.eventSubmit.mockImplementation(async () => {
      h.order.push('submit');
      if (h.client.eventSubmit.mock.calls.length === 2) h.controller.abort();
    });

    await h.runner.run();

    expect(h.client.eventSubmit).toHaveBeenCalledTimes(2);
    expect(h.order.indexOf('attach')).toBeLessThan(h.order.indexOf('submit'));
  });

  it('abort triggers clean shutdown without waiting for the next tick', async () => {
    const h = harness({ pollIntervalMs: 60_000 });
    h.client.eventSubmit.mockImplementation(async () => { h.controller.abort(); });

    await h.runner.run();

    expect(h.worker.close).toHaveBeenCalledOnce();
    expect(h.client.close).toHaveBeenCalledOnce();
    expect(h.order.indexOf('worker.close')).toBeLessThan(h.order.indexOf('client.close'));
  });

  it('survives a fetch throw, reports its typed error, and polls next tick', async () => {
    const onPollError = vi.fn();
    let fetches = 0;
    const h = harness({
      onPollError,
      fetcher: async () => {
        fetches += 1;
        if (fetches === 1) throw new Error('network down');
        h.controller.abort();
        return '[2]';
      },
    });

    await h.runner.run();

    expect(fetches).toBe(2);
    expect(onPollError).toHaveBeenCalledWith(expect.any(HnPollFetchError));
    expect(h.client.eventSubmit).toHaveBeenCalledOnce();
  });

  it('terminates and closes when the journal rejects an event', async () => {
    const journalError = new Error('journal write failed');
    const h = harness();
    h.client.eventSubmit.mockRejectedValue(journalError);

    await expect(h.runner.run()).rejects.toBe(journalError);

    expect(h.client.eventSubmit).toHaveBeenCalledOnce();
    expect(h.worker.close).toHaveBeenCalledOnce();
    expect(h.client.close).toHaveBeenCalledOnce();
  });
});
