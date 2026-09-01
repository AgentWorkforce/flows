import { describe, expect, it, vi } from 'vitest';
import { HnMonitorRunner } from '../src/hn-monitor-runner.js';

function harness(overrides: {
  fetcher?: () => Promise<string>;
  eventSubmit?: () => Promise<unknown>;
  interval?: number;
} = {}) {
  const calls: string[] = [];
  const controller = new AbortController();
  const client = {
    connect: vi.fn(async () => { calls.push('connect'); }),
    hello: vi.fn(async () => { calls.push('hello'); }),
    eventSubmit: vi.fn(async () => {
      calls.push('submit');
      return overrides.eventSubmit?.() ?? {};
    }),
    close: vi.fn(() => { calls.push('client.close'); }),
  };
  const worker = {
    attach: vi.fn(async () => { calls.push('attach'); }),
    close: vi.fn(async () => { calls.push('worker.close'); }),
  };
  const fetcher = vi.fn(async () => {
    calls.push('fetch');
    return overrides.fetcher?.() ?? '[1]';
  });
  const onPollError = vi.fn();
  const runner = new HnMonitorRunner(
    {
      spec: { name: 'hn-monitor' },
      workerId: 'hn-worker',
      pins: {},
      pollIntervalMs: overrides.interval ?? 1,
      fetcher,
      signal: controller.signal,
      onPollError,
    },
    { client, worker },
  );
  return { calls, client, controller, fetcher, onPollError, runner, worker };
}

describe('HnMonitorRunner', () => {
  it('submits an event on each polling tick', async () => {
    const test = harness();
    test.client.eventSubmit.mockImplementation(async () => {
      test.calls.push('submit');
      if (test.client.eventSubmit.mock.calls.length === 2) test.controller.abort();
      return {};
    });

    await test.runner.run();

    expect(test.fetcher).toHaveBeenCalledTimes(2);
    expect(test.client.eventSubmit).toHaveBeenCalledTimes(2);
  });

  it('attaches the worker before the first poll', async () => {
    const test = harness();
    test.client.eventSubmit.mockImplementation(async () => {
      test.calls.push('submit');
      test.controller.abort();
      return {};
    });

    await test.runner.run();

    expect(test.calls.indexOf('attach')).toBeLessThan(test.calls.indexOf('fetch'));
  });

  it('aborts during sleep and shuts down without waiting for the next tick', async () => {
    const test = harness({ interval: 60_000 });
    test.client.eventSubmit.mockImplementation(async () => {
      test.calls.push('submit');
      test.controller.abort();
      return {};
    });

    await test.runner.run();

    expect(test.worker.close).toHaveBeenCalledOnce();
    expect(test.client.close).toHaveBeenCalledOnce();
    expect(test.calls.indexOf('worker.close')).toBeLessThan(test.calls.indexOf('client.close'));
  });

  it('reports a fetch failure and continues on the next tick', async () => {
    let fetchCount = 0;
    const fetcher = async (): Promise<string> => {
      fetchCount += 1;
      if (fetchCount === 1) throw new Error('temporary network failure');
      return '[2]';
    };
    const test = harness({ fetcher });
    test.client.eventSubmit.mockImplementation(async () => {
      test.calls.push('submit');
      test.controller.abort();
      return {};
    });

    await test.runner.run();

    expect(test.onPollError).toHaveBeenCalledOnce();
    expect(test.fetcher).toHaveBeenCalledTimes(2);
    expect(test.client.eventSubmit).toHaveBeenCalledOnce();
  });

  it('terminates when the journal rejects an event submission', async () => {
    const journalError = new Error('journal write failed');
    const test = harness({ eventSubmit: async () => { throw journalError; } });

    await expect(test.runner.run()).rejects.toBe(journalError);

    expect(test.onPollError).not.toHaveBeenCalled();
    expect(test.fetcher).toHaveBeenCalledOnce();
    expect(test.worker.close).toHaveBeenCalledOnce();
    expect(test.client.close).toHaveBeenCalledOnce();
  });
});
