import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { HnMonitorRunner } from '../src/hn-monitor-runner.js';
import type { JournalClient } from '../src/journal-client.js';

class MockJournalClient extends EventEmitter {
  readonly calls: string[] = [];
  closed = false;
  submit: () => Promise<unknown> = async () => ({ matched: true, deduped: false });

  async connect(): Promise<void> {
    this.calls.push('connect');
  }

  async workerAttach(): Promise<{ worker_id: string }> {
    this.calls.push('attach');
    return { worker_id: 'hn-monitor' };
  }

  async eventSubmit(): Promise<unknown> {
    this.calls.push('submit');
    return this.submit();
  }

  close(): void {
    this.calls.push('close');
    this.closed = true;
  }
}

function runner(
  client: MockJournalClient,
  controller: AbortController,
  overrides: Partial<ConstructorParameters<typeof HnMonitorRunner>[0]> = {},
): HnMonitorRunner {
  return new HnMonitorRunner({
    socketPath: '/unused/test.sock',
    spec: { id: 'hn-monitor' },
    workerId: 'hn-monitor',
    pins: {},
    signal: controller.signal,
    pollIntervalMs: 0,
    fetcher: async () => '[101]',
    client: client as unknown as JournalClient,
    ...overrides,
  });
}

describe('HnMonitorRunner', () => {
  it('submits an event on each tick', async () => {
    const client = new MockJournalClient();
    const controller = new AbortController();
    let submissions = 0;
    client.submit = async () => {
      if (++submissions === 2) controller.abort();
      return { matched: true, deduped: false };
    };

    await runner(client, controller).run();

    expect(submissions).toBe(2);
  });

  it('aborts cleanly and closes the client within one tick', async () => {
    const client = new MockJournalClient();
    const controller = new AbortController();
    client.submit = async () => {
      controller.abort();
      return { matched: true, deduped: false };
    };

    await runner(client, controller).run();

    expect(client.closed).toBe(true);
    expect(client.calls).toEqual(['connect', 'attach', 'submit', 'close']);
  });

  it('attaches the agent worker before the first poll', async () => {
    const client = new MockJournalClient();
    const controller = new AbortController();
    client.submit = async () => {
      controller.abort();
      return { matched: true, deduped: false };
    };

    await runner(client, controller).run();

    expect(client.calls.indexOf('attach')).toBeLessThan(client.calls.indexOf('submit'));
  });

  it('reports a fetch error and continues to the next tick', async () => {
    const client = new MockJournalClient();
    const controller = new AbortController();
    const onPollError = vi.fn();
    let fetches = 0;
    client.submit = async () => {
      controller.abort();
      return { matched: true, deduped: false };
    };

    await runner(client, controller, {
      fetcher: async () => {
        if (++fetches === 1) throw new Error('temporary HN failure');
        return '[202]';
      },
      onPollError,
    }).run();

    expect(fetches).toBe(2);
    expect(onPollError).toHaveBeenCalledWith(new Error('temporary HN failure'));
    expect(client.calls).toContain('submit');
  });

  it('terminates when event submission to the journal fails', async () => {
    const client = new MockJournalClient();
    const controller = new AbortController();
    const journalError = new Error('journal write failed');
    const onPollError = vi.fn();
    client.submit = async () => { throw journalError; };

    await expect(runner(client, controller, { onPollError }).run()).rejects.toBe(journalError);

    expect(onPollError).not.toHaveBeenCalled();
    expect(client.closed).toBe(true);
  });
});
