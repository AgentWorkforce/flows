import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { HnMonitorRunner } from '../src/hn-monitor-runner.js';

const spec = { name: 'hn-monitor' };

class FakeClient extends EventEmitter {
  readonly calls: string[] = [];
  readonly events: unknown[] = [];

  async connect(): Promise<void> {
    this.calls.push('connect');
  }

  async hello(): Promise<void> {
    this.calls.push('hello');
  }

  async workerAttach(): Promise<void> {
    this.calls.push('attach');
  }

  async eventSubmit(_spec: unknown, event: unknown): Promise<void> {
    this.calls.push('submit');
    this.events.push(event);
  }

  close(): void {
    this.calls.push('close');
  }
}

describe('HnMonitorRunner', () => {
  it('attaches the agent worker before the first poll', async () => {
    const client = new FakeClient();
    const runner = new HnMonitorRunner(spec, {
      client,
      intervalMs: 1,
      fetcher: async () => '[1]',
    });

    await runner.run({ maxPolls: 1 });

    expect(client.calls.indexOf('attach')).toBeLessThan(client.calls.indexOf('submit'));
  });

  it('submits fetched stories on every tick', async () => {
    const client = new FakeClient();
    const runner = new HnMonitorRunner(spec, {
      client,
      intervalMs: 1,
      fetcher: async () => '[7, 8]',
    });

    await runner.run({ maxPolls: 2 });

    expect(client.events).toHaveLength(4);
  });

  it('SIGTERM finishes the current poll and exits within one tick', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    let finishPoll: (() => void) | undefined;
    const runner = new HnMonitorRunner(spec, {
      client,
      intervalMs: 60_000,
      fetcher: () => new Promise<string>((resolve) => {
        finishPoll = () => resolve('[9]');
      }),
    });

    const running = runner.run();
    await vi.waitFor(() => expect(finishPoll).toBeTypeOf('function'));
    process.emit('SIGTERM');
    finishPoll?.();
    await running;

    expect(client.calls.at(-1)).toBe('close');
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
