import { describe, expect, it, vi } from 'vitest';
import { HnFetchError, HnMonitorRunner } from '../src/hn-monitor-runner.js';

function harness(overrides: {
  fetcher?: () => Promise<string>;
  eventSubmit?: () => Promise<unknown>;
  onPollError?: (error: HnFetchError) => void;
} = {}) {
  const controller = new AbortController();
  const calls: string[] = [];
  const client = {
    async connect() { calls.push('connect'); },
    async hello() { calls.push('hello'); return {}; },
    close() { calls.push('client.close'); },
    async eventSubmit() {
      calls.push('eventSubmit');
      return overrides.eventSubmit?.() ?? {};
    },
  };
  const worker = {
    async attach() { calls.push('worker.attach'); },
    async close() { calls.push('worker.close'); },
  };
  const runner = new HnMonitorRunner({
    socketPath: '/unused/relayflowd.sock',
    spec: { name: 'hn-monitor' },
    workerId: 'hn-monitor-test',
    pins: {},
    signal: controller.signal,
    pollIntervalMs: 0,
    storyLimit: 1,
    fetcher: overrides.fetcher ?? (async () => '[1]'),
    onPollError: overrides.onPollError,
    client,
    worker,
  });
  return { calls, client, controller, runner, worker };
}

describe('HnMonitorRunner', () => {
  it('submits an event on every tick', async () => {
    let submissions = 0;
    const h = harness({
      eventSubmit: async () => {
        submissions++;
        if (submissions === 2) h.controller.abort();
        return {};
      },
    });

    await h.runner.run();

    expect(submissions).toBe(2);
  });

  it('aborting triggers clean shutdown within the current tick', async () => {
    const h = harness({
      eventSubmit: async () => {
        h.controller.abort();
        return {};
      },
    });

    await h.runner.run();

    expect(h.calls.slice(-2)).toEqual(['worker.close', 'client.close']);
  });

  it('attaches the agent worker before the first poll', async () => {
    const h = harness({
      eventSubmit: async () => {
        h.controller.abort();
        return {};
      },
    });

    await h.runner.run();

    expect(h.calls.indexOf('worker.attach')).toBeLessThan(h.calls.indexOf('eventSubmit'));
  });

  it('reports a fetch error and continues with the next tick', async () => {
    const errors: HnFetchError[] = [];
    let fetches = 0;
    const h = harness({
      fetcher: async () => {
        fetches++;
        if (fetches === 1) throw new Error('network unavailable');
        return '[1]';
      },
      eventSubmit: async () => {
        h.controller.abort();
        return {};
      },
      onPollError: (error) => errors.push(error),
    });

    await h.runner.run();

    expect(fetches).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(HnFetchError);
    expect(errors[0]?.message).toContain('network unavailable');
  });

  it('terminates when the journal rejects an event submission', async () => {
    const journalError = new Error('journal write failed');
    const h = harness({ eventSubmit: async () => { throw journalError; } });

    await expect(h.runner.run()).rejects.toBe(journalError);
    expect(h.calls.slice(-2)).toEqual(['worker.close', 'client.close']);
  });
});
