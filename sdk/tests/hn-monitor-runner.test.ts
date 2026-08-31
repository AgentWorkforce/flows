import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { HnMonitorRunner } from '../src/hn-monitor-runner.js';
import type { JournalClient } from '../src/journal-client.js';

const SPEC = { subscriptions: [{ event: 'hn.story_posted' }] };
const PINS = { workspace: [{ surface: 'repo', revision_id: 'rev-a' }] };

class FakeJournalClient extends EventEmitter {
  readonly calls: string[] = [];
  eventError: Error | undefined;

  async workerAttach(): Promise<{ worker_id: string }> {
    this.calls.push('attach');
    return { worker_id: 'hn-monitor' };
  }

  async eventSubmit(): Promise<{ matched: boolean; deduped: boolean }> {
    this.calls.push('submit');
    if (this.eventError !== undefined) throw this.eventError;
    return { matched: true, deduped: false };
  }
}

function runner(
  client: FakeJournalClient,
  options: Partial<ConstructorParameters<typeof HnMonitorRunner>[2]> = {},
): HnMonitorRunner {
  return new HnMonitorRunner(client as unknown as JournalClient, SPEC, {
    workerId: 'hn-monitor',
    pins: PINS,
    intervalMs: 1,
    ...options,
  });
}

describe('HnMonitorRunner', () => {
  it('submits an event on each tick', async () => {
    const client = new FakeJournalClient();
    const controller = new AbortController();
    let polls = 0;
    await runner(client, {
      signal: controller.signal,
      fetcher: async () => {
        polls += 1;
        if (polls === 2) controller.abort();
        return `[${polls}]`;
      },
    }).run();

    expect(client.calls.filter((call) => call === 'submit')).toHaveLength(2);
  });

  it('shuts down cleanly when aborted during the tick delay', async () => {
    const client = new FakeJournalClient();
    const controller = new AbortController();
    const monitor = runner(client, {
      signal: controller.signal,
      intervalMs: 10_000,
      fetcher: async () => '[1]',
    });

    const running = monitor.run();
    await vi.waitFor(() => expect(client.calls).toContain('submit'));
    controller.abort();
    await expect(running).resolves.toBeUndefined();
    expect(client.listenerCount('step.dispatch')).toBe(0);
  });

  it('attaches the worker before the first poll', async () => {
    const client = new FakeJournalClient();
    const controller = new AbortController();
    await runner(client, {
      signal: controller.signal,
      fetcher: async () => {
        client.calls.push('fetch');
        controller.abort();
        return '[]';
      },
    }).run();

    expect(client.calls.slice(0, 2)).toEqual(['attach', 'fetch']);
  });

  it('reports a fetch error and polls again', async () => {
    const client = new FakeJournalClient();
    const controller = new AbortController();
    const onPollError = vi.fn();
    let polls = 0;
    await runner(client, {
      signal: controller.signal,
      onPollError,
      fetcher: async () => {
        polls += 1;
        if (polls === 1) throw new Error('temporary HN failure');
        controller.abort();
        return '[2]';
      },
    }).run();

    expect(onPollError).toHaveBeenCalledOnce();
    expect(polls).toBe(2);
    expect(client.calls).toContain('submit');
  });

  it('terminates when the journal rejects an event', async () => {
    const client = new FakeJournalClient();
    const journalError = new Error('journal write failed');
    client.eventError = journalError;

    await expect(runner(client, { fetcher: async () => '[1]' }).run()).rejects.toBe(journalError);
    expect(client.listenerCount('step.dispatch')).toBe(0);
  });
});
