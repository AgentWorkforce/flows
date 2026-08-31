import { describe, expect, it, vi } from 'vitest';
import { HnMonitorRunner, type HnMonitorClient, type HnMonitorWorker } from '../src/hn-monitor-runner.js';

function harness(options: {
  fetcher?: () => Promise<string>;
  eventSubmit?: () => Promise<unknown>;
  onPollError?: (error: unknown) => void;
} = {}) {
  const calls: string[] = [];
  const client: HnMonitorClient = {
    async connect() { calls.push('connect'); },
    async eventSubmit() {
      calls.push('eventSubmit');
      return options.eventSubmit?.() ?? { matched: true, deduped: false };
    },
    close() { calls.push('client.close'); },
  };
  const worker: HnMonitorWorker = {
    async attach() { calls.push('worker.attach'); },
    async close() { calls.push('worker.close'); },
  };
  const controller = new AbortController();
  const runner = new HnMonitorRunner({
    spec: { name: 'hn-monitor' },
    socketPath: '/unused/test.sock',
    workerId: 'test-worker',
    pins: {},
    signal: controller.signal,
    pollIntervalMs: 1,
    fetcher: options.fetcher ?? (async () => '[101]'),
    onPollError: options.onPollError,
    client,
    worker,
  });
  return { calls, controller, runner };
}

describe('HnMonitorRunner', () => {
  it('attaches the worker before the first poll and submits on each tick', async () => {
    const { calls, controller, runner } = harness();
    const run = runner.run();
    await vi.waitFor(() => expect(calls.filter((call) => call === 'eventSubmit').length).toBeGreaterThanOrEqual(2));
    controller.abort();
    await run;
    expect(calls.indexOf('worker.attach')).toBeLessThan(calls.indexOf('eventSubmit'));
  });

  it('aborts cleanly within one tick and closes worker before client', async () => {
    const { calls, controller, runner } = harness();
    const run = runner.run();
    await vi.waitFor(() => expect(calls).toContain('eventSubmit'));
    controller.abort();
    await expect(run).resolves.toBeUndefined();
    expect(calls.slice(-2)).toEqual(['worker.close', 'client.close']);
  });

  it('survives a fetch throw, reports it, and polls again', async () => {
    let fetches = 0;
    const errors: unknown[] = [];
    const { calls, controller, runner } = harness({
      fetcher: async () => {
        fetches += 1;
        if (fetches === 1) throw new Error('HN unavailable');
        return '[202]';
      },
      onPollError: (error) => errors.push(error),
    });
    const run = runner.run();
    await vi.waitFor(() => expect(calls).toContain('eventSubmit'));
    controller.abort();
    await run;
    expect(fetches).toBeGreaterThanOrEqual(2);
    expect(errors).toEqual([new Error('HN unavailable')]);
  });

  it('terminates when the journal rejects event submission', async () => {
    const journalError = new Error('journal write failed');
    const onPollError = vi.fn();
    const { calls, runner } = harness({
      eventSubmit: async () => { throw journalError; },
      onPollError,
    });
    await expect(runner.run()).rejects.toBe(journalError);
    expect(onPollError).not.toHaveBeenCalled();
    expect(calls.slice(-2)).toEqual(['worker.close', 'client.close']);
  });
});
