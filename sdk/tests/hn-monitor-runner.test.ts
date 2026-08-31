import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { HnMonitorRunner } from '../src/hn-monitor-runner.js';
import type { Fetcher } from '../src/hn-poller.js';
import type { JournalClient } from '../src/journal-client.js';

class FakeClient extends EventEmitter {
  readonly calls: string[] = [];
  readonly submissions: unknown[] = [];
  submitError: Error | undefined;

  async connect(): Promise<void> { this.calls.push('connect'); }
  async hello(): Promise<{ protocol: 0; server: string }> {
    this.calls.push('hello');
    return { protocol: 0, server: 'test' };
  }
  async workerAttach(): Promise<{ worker_id: string }> {
    this.calls.push('attach');
    return { worker_id: 'hn-monitor' };
  }
  async eventSubmit(_spec: unknown, event: unknown): Promise<unknown> {
    this.calls.push('submit');
    if (this.submitError) throw this.submitError;
    this.submissions.push(event);
    return { matched: true, deduped: false };
  }
  close(): void { this.calls.push('client.close'); }
}

function runner(client: FakeClient, fetcher: Fetcher, signal: AbortSignal, onPollError = vi.fn()) {
  return new HnMonitorRunner({
    spec: { name: 'hn-monitor' },
    signal,
    fetcher,
    pollIntervalMs: 1,
    client: client as unknown as JournalClient,
    onPollError,
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition was not reached');
}

describe('HnMonitorRunner', () => {
  it('submits an event on every polling tick', async () => {
    const client = new FakeClient();
    const abort = new AbortController();
    const running = runner(client, async () => '[101]', abort.signal).run();

    await waitFor(() => client.submissions.length >= 2);
    abort.abort();
    await running;

    expect(client.submissions).toHaveLength(2);
  });

  it('attaches the agent worker before the first poll and shuts down on abort', async () => {
    const client = new FakeClient();
    const abort = new AbortController();
    const fetcher = vi.fn(async () => {
      abort.abort();
      return '[101]';
    });

    await runner(client, fetcher, abort.signal).run();

    expect(client.calls.indexOf('attach')).toBeLessThan(client.calls.indexOf('submit'));
    expect(client.calls.at(-1)).toBe('client.close');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports a fetch failure and continues with the next tick', async () => {
    const client = new FakeClient();
    const abort = new AbortController();
    const fetchError = new Error('HN unavailable');
    const onPollError = vi.fn();
    let polls = 0;
    const fetcher = vi.fn(async () => {
      polls += 1;
      if (polls === 1) throw fetchError;
      abort.abort();
      return '[202]';
    });

    await runner(client, fetcher, abort.signal, onPollError).run();

    expect(onPollError).toHaveBeenCalledWith(fetchError);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(client.submissions).toHaveLength(1);
  });

  it('terminates when the journal rejects an event submission', async () => {
    const client = new FakeClient();
    const journalError = new Error('journal write failed');
    client.submitError = journalError;
    const abort = new AbortController();
    const onPollError = vi.fn();

    await expect(runner(client, async () => '[303]', abort.signal, onPollError).run())
      .rejects.toBe(journalError);

    expect(onPollError).not.toHaveBeenCalled();
    expect(client.calls.at(-1)).toBe('client.close');
  });
});
