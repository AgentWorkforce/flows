import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { HnMonitorRunner } from '../src/hn-monitor-runner.js';

class FakeClient extends EventEmitter {
  readonly calls: string[] = [];
  readonly eventSubmit = vi.fn(async () => ({}));

  async connect(): Promise<void> { this.calls.push('connect'); }
  async hello(): Promise<void> { this.calls.push('hello'); }
  async workerAttach(): Promise<void> { this.calls.push('attach'); }
  close(): void { this.calls.push('close'); }
  async stepComplete(): Promise<void> {}
}

const spec = { name: 'hn-monitor' };
const pins = { workspace: [{ surface: 'repo', revision_id: 'test' }] };

describe('HnMonitorRunner', () => {
  it('submits an event on every tick', async () => {
    const client = new FakeClient();
    const abort = new AbortController();
    client.eventSubmit.mockImplementation(async () => {
      if (client.eventSubmit.mock.calls.length === 2) abort.abort();
      return {};
    });
    const runner = new HnMonitorRunner({
      socketPath: 'unused', spec, workerId: 'worker', pins, client,
      signal: abort.signal, pollIntervalMs: 1, fetcher: async () => '[1]',
    });

    await runner.run();

    expect(client.eventSubmit).toHaveBeenCalledTimes(2);
  });

  it('attaches before the first poll and abort closes cleanly', async () => {
    const client = new FakeClient();
    const abort = new AbortController();
    const fetcher = vi.fn(async () => {
      expect(client.calls).toContain('attach');
      abort.abort();
      return '[]';
    });
    const runner = new HnMonitorRunner({
      socketPath: 'unused', spec, workerId: 'worker', pins, client,
      signal: abort.signal, pollIntervalMs: 1, fetcher,
    });

    await runner.run();

    expect(fetcher).toHaveBeenCalledOnce();
    expect(client.calls).toEqual(['connect', 'hello', 'attach', 'close']);
    expect(client.listenerCount('step.dispatch')).toBe(0);
  });

  it('survives a fetch error and polls on the next tick', async () => {
    const client = new FakeClient();
    const abort = new AbortController();
    const fetchError = new Error('temporary HN failure');
    const onPollError = vi.fn();
    let fetches = 0;
    const runner = new HnMonitorRunner({
      socketPath: 'unused', spec, workerId: 'worker', pins, client,
      signal: abort.signal, pollIntervalMs: 1, onPollError,
      fetcher: async () => {
        fetches += 1;
        if (fetches === 1) throw fetchError;
        abort.abort();
        return '[]';
      },
    });

    await runner.run();

    expect(fetches).toBe(2);
    expect(onPollError).toHaveBeenCalledOnce();
    expect(onPollError).toHaveBeenCalledWith(expect.objectContaining({ cause: fetchError }));
  });

  it('terminates when the journal rejects an event submission', async () => {
    const client = new FakeClient();
    const journalError = new Error('journal write failed');
    client.eventSubmit.mockRejectedValue(journalError);
    const onPollError = vi.fn();
    const runner = new HnMonitorRunner({
      socketPath: 'unused', spec, workerId: 'worker', pins, client,
      pollIntervalMs: 1, onPollError, fetcher: async () => '[1]',
    });

    await expect(runner.run()).rejects.toBe(journalError);
    expect(onPollError).not.toHaveBeenCalled();
    expect(client.calls.at(-1)).toBe('close');
  });
});
