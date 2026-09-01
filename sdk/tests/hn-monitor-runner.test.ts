import { describe, expect, it, vi } from 'vitest';
import { HnMonitorRunner, type HnMonitorRunnerOptions } from '../src/hn-monitor-runner.js';

interface Harness {
  client: ReturnType<typeof mockClient>;
  worker: ReturnType<typeof mockWorker>;
  options: HnMonitorRunnerOptions;
}

function mockClient() {
  return {
    connect: vi.fn(async () => undefined),
    hello: vi.fn(async () => ({})),
    eventSubmit: vi.fn(async () => ({})),
    close: vi.fn(),
  };
}

function mockWorker() {
  return {
    attach: vi.fn(async () => undefined),
    close: vi.fn(),
  };
}

function harness(overrides: Partial<HnMonitorRunnerOptions> = {}): Harness {
  const client = mockClient();
  const worker = mockWorker();
  return {
    client,
    worker,
    options: {
      socketPath: '/tmp/relayflowd.sock',
      spec: { name: 'hn-monitor' },
      workerId: 'hn-monitor',
      pins: {},
      pollIntervalMs: 1,
      fetcher: async () => '[1]',
      clientFactory: () => client,
      workerFactory: () => worker,
      ...overrides,
    },
  };
}

describe('HnMonitorRunner', () => {
  it('submits an event on every polling tick', async () => {
    const abort = new AbortController();
    const h = harness({ signal: abort.signal });
    h.client.eventSubmit.mockImplementation(async () => {
      if (h.client.eventSubmit.mock.calls.length === 2) abort.abort();
      return {};
    });

    await new HnMonitorRunner(h.options).run();

    expect(h.client.eventSubmit).toHaveBeenCalledTimes(2);
  });

  it('drains an in-flight poll and shuts down cleanly when aborted', async () => {
    const abort = new AbortController();
    let finishFetch!: (value: string) => void;
    const fetcher = vi.fn(() => new Promise<string>((resolve) => { finishFetch = resolve; }));
    const h = harness({ signal: abort.signal, fetcher });
    const running = new HnMonitorRunner(h.options).run();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());

    abort.abort();
    expect(h.client.close).not.toHaveBeenCalled();
    finishFetch('[2]');
    await running;

    expect(h.client.eventSubmit).toHaveBeenCalledOnce();
    expect(h.worker.close).toHaveBeenCalledOnce();
    expect(h.client.close).toHaveBeenCalledOnce();
  });

  it('attaches the worker before the first poll', async () => {
    const order: string[] = [];
    const abort = new AbortController();
    const h = harness({
      signal: abort.signal,
      fetcher: async () => {
        order.push('poll');
        abort.abort();
        return '[]';
      },
    });
    h.worker.attach.mockImplementation(async () => { order.push('attach'); });

    await new HnMonitorRunner(h.options).run();

    expect(order).toEqual(['attach', 'poll']);
  });

  it('reports a fetch error and continues with the next tick', async () => {
    const abort = new AbortController();
    const onPollError = vi.fn();
    let fetches = 0;
    const h = harness({
      signal: abort.signal,
      onPollError,
      fetcher: async () => {
        fetches += 1;
        if (fetches === 1) throw new Error('fetch unavailable');
        abort.abort();
        return '[3]';
      },
    });

    await new HnMonitorRunner(h.options).run();

    expect(onPollError).toHaveBeenCalledWith(expect.objectContaining({ message: 'fetch unavailable' }));
    expect(fetches).toBe(2);
    expect(h.client.eventSubmit).toHaveBeenCalledOnce();
  });

  it('terminates when a journal submission fails', async () => {
    const journalError = new Error('journal write failed');
    const onPollError = vi.fn();
    const h = harness({ onPollError });
    h.client.eventSubmit.mockRejectedValue(journalError);

    await expect(new HnMonitorRunner(h.options).run()).rejects.toBe(journalError);

    expect(onPollError).not.toHaveBeenCalled();
    expect(h.worker.close).toHaveBeenCalledOnce();
    expect(h.client.close).toHaveBeenCalledOnce();
  });
});
