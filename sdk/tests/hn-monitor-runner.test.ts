import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { HnMonitorRunner } from '../src/hn-monitor-runner.js';

class MockClient extends EventEmitter {
  readonly calls: string[] = [];
  readonly events: Array<{ type: string; payload?: unknown }> = [];

  async connect(): Promise<void> { this.calls.push('connect'); }
  async hello(): Promise<unknown> { this.calls.push('hello'); return {}; }
  async eventSubmit(_spec: unknown, event: { type: string; payload?: unknown }): Promise<unknown> {
    this.calls.push('poll');
    this.events.push(event);
    return {};
  }
  close(): void { this.calls.push('client.close'); }
}

class MockWorker {
  constructor(private readonly calls: string[]) {}
  async attach(): Promise<void> { this.calls.push('worker.attach'); }
  close(): void { this.calls.push('worker.close'); }
}

function runner(client: MockClient, signals: EventEmitter): HnMonitorRunner {
  return new HnMonitorRunner({
    socketPath: '/unused',
    spec: { name: 'hn-monitor' },
    worker: { workerId: 'hn-monitor', pins: {} },
    client,
    agentWorker: new MockWorker(client.calls),
    signalSource: signals,
    pollIntervalMs: 100,
    pollOptions: { storyLimit: 1, fetcher: async () => '[41000001]' },
  });
}

describe('HnMonitorRunner', () => {
  it('submits an event on every polling tick', async () => {
    vi.useFakeTimers();
    const client = new MockClient();
    const signals = new EventEmitter();
    const running = runner(client, signals).run();

    await vi.advanceTimersByTimeAsync(0);
    expect(client.events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(client.events).toHaveLength(2);

    signals.emit('SIGTERM');
    await running;
    vi.useRealTimers();
  });

  it('SIGTERM finishes the current poll and exits cleanly within one tick', async () => {
    vi.useFakeTimers();
    const client = new MockClient();
    const signals = new EventEmitter();
    const running = runner(client, signals).run();
    await vi.advanceTimersByTimeAsync(0);

    signals.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(100);
    await running;

    expect(client.calls.slice(-2)).toEqual(['worker.close', 'client.close']);
    expect(client.events).toHaveLength(1);
    vi.useRealTimers();
  });

  it('attaches the worker before the first poll', async () => {
    vi.useFakeTimers();
    const client = new MockClient();
    const signals = new EventEmitter();
    const running = runner(client, signals).run();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.calls.indexOf('worker.attach')).toBeLessThan(client.calls.indexOf('poll'));

    signals.emit('SIGINT');
    await running;
    vi.useRealTimers();
  });
});
