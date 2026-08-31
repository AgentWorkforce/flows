import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { HnMonitorRunner } from '../src/hn-monitor-runner.js';
import type { JournalClient } from '../src/journal-client.js';

const pins = { workspace: {}, streams: {} };

class FakeClient extends EventEmitter {
  readonly calls: string[] = [];
  readonly submitted: unknown[] = [];
  submitError?: Error;

  async workerAttach(): Promise<void> {
    this.calls.push('attach');
  }

  async eventSubmit(_spec: unknown, event: unknown): Promise<unknown> {
    this.calls.push('submit');
    if (this.submitError) throw this.submitError;
    this.submitted.push(event);
    return { matched: true };
  }
}

function asJournalClient(client: FakeClient): JournalClient {
  return client as unknown as JournalClient;
}

describe('HnMonitorRunner', () => {
  it('attaches before polling and submits events on each tick', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    const controller = new AbortController();
    const runner = new HnMonitorRunner(asJournalClient(client), {
      spec: { name: 'hn-monitor' }, workerId: 'hn-1', pins,
      pollIntervalMs: 10, fetcher: async () => '[1]', signal: controller.signal,
    });

    const running = runner.run();
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await running;

    expect(client.calls.slice(0, 2)).toEqual(['attach', 'submit']);
    expect(client.submitted).toHaveLength(2);
    vi.useRealTimers();
  });

  it('aborts cleanly while waiting and detaches the worker', async () => {
    const client = new FakeClient();
    const controller = new AbortController();
    const runner = new HnMonitorRunner(asJournalClient(client), {
      spec: {}, workerId: 'hn-1', pins, pollIntervalMs: 60_000,
      fetcher: async () => '[]', signal: controller.signal,
    });

    const running = runner.run();
    await vi.waitFor(() => expect(client.calls).toContain('attach'));
    controller.abort();
    await running;

    expect(client.listenerCount('step.dispatch')).toBe(0);
  });

  it('reports a fetch failure and continues with the next tick', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    const controller = new AbortController();
    const fetchError = new Error('HN unavailable');
    const onPollError = vi.fn();
    let attempts = 0;
    const runner = new HnMonitorRunner(asJournalClient(client), {
      spec: {}, workerId: 'hn-1', pins, pollIntervalMs: 10,
      fetcher: async () => ++attempts === 1 ? Promise.reject(fetchError) : '[2]',
      signal: controller.signal, onPollError,
    });

    const running = runner.run();
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await running;

    expect(onPollError).toHaveBeenCalledWith(fetchError);
    expect(client.submitted).toHaveLength(1);
    vi.useRealTimers();
  });

  it('terminates when the journal rejects an event submission', async () => {
    const client = new FakeClient();
    const journalError = new Error('journal unavailable');
    client.submitError = journalError;
    const runner = new HnMonitorRunner(asJournalClient(client), {
      spec: {}, workerId: 'hn-1', pins, fetcher: async () => '[3]',
    });

    await expect(runner.run()).rejects.toBe(journalError);
    expect(client.listenerCount('step.dispatch')).toBe(0);
  });
});
