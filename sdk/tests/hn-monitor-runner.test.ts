import { beforeEach, describe, expect, it, vi } from 'vitest';

const { calls, clients, workers, MockJournalClient, MockAgentWorker } = vi.hoisted(() => {
  const hoistedCalls: string[] = [];
  const hoistedClients: Array<{
    eventSubmit: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const hoistedWorkers: Array<{
    attach: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];

  class HoistedJournalClient {
    eventSubmit = vi.fn(async () => ({ matched: 1 }));
    connect = vi.fn(async () => { hoistedCalls.push('connect'); });
    close = vi.fn(() => { hoistedCalls.push('client.close'); });

    constructor(readonly socketPath: string) {
      hoistedClients.push(this);
    }
  }

  class HoistedAgentWorker {
    attach = vi.fn(async () => { hoistedCalls.push('worker.attach'); });
    close = vi.fn(() => { hoistedCalls.push('worker.close'); });

    constructor(..._args: unknown[]) {
      hoistedWorkers.push(this);
    }
  }

  return {
    calls: hoistedCalls,
    clients: hoistedClients,
    workers: hoistedWorkers,
    MockJournalClient: HoistedJournalClient,
    MockAgentWorker: HoistedAgentWorker,
  };
});

vi.mock('../src/journal-client.js', () => ({ JournalClient: MockJournalClient }));
vi.mock('../src/worker.js', () => ({ AgentWorker: MockAgentWorker }));

import { HnMonitorRunner } from '../src/hn-monitor-runner.js';

const pins = { workspace_revisions: {}, stream_offsets: {} };

function makeRunner(overrides: Partial<ConstructorParameters<typeof HnMonitorRunner>[0]> = {}) {
  return new HnMonitorRunner({
    socketPath: '/tmp/relayflow.sock',
    spec: { name: 'hn-monitor' },
    workerId: 'hn-monitor',
    pins,
    pollIntervalMs: 0,
    fetcher: async () => '[101]',
    ...overrides,
  });
}

describe('HnMonitorRunner', () => {
  beforeEach(() => {
    calls.length = 0;
    clients.length = 0;
    workers.length = 0;
  });

  it('attaches the worker before polling and submits on every tick', async () => {
    const controller = new AbortController();
    let polls = 0;
    const runner = makeRunner({
      signal: controller.signal,
      fetcher: async () => {
        calls.push('poll');
        if (++polls === 2) controller.abort();
        return `[${polls}]`;
      },
    });

    await runner.run();

    expect(calls.slice(0, 2)).toEqual(['connect', 'worker.attach']);
    expect(clients[0].eventSubmit).toHaveBeenCalledTimes(2);
    expect(clients[0].eventSubmit.mock.calls.map((call) => call[1].payload)).toEqual([
      { id: 1, type: 'story' },
      { id: 2, type: 'story' },
    ]);
  });

  it('aborts within one tick, drains the poll, and cleans up', async () => {
    const controller = new AbortController();
    const runner = makeRunner({
      pollIntervalMs: 60_000,
      signal: controller.signal,
      fetcher: async () => {
        controller.abort();
        return '[1]';
      },
    });

    await runner.run();

    expect(clients[0].eventSubmit).toHaveBeenCalledOnce();
    expect(calls.slice(-2)).toEqual(['worker.close', 'client.close']);
    expect(workers[0].close).toHaveBeenCalledOnce();
  });

  it('reports a fetch error and continues to the next tick', async () => {
    const controller = new AbortController();
    const fetchError = new Error('network down');
    const onPollError = vi.fn();
    let polls = 0;
    const runner = makeRunner({
      signal: controller.signal,
      onPollError,
      fetcher: async () => {
        if (++polls === 1) throw fetchError;
        controller.abort();
        return '[2]';
      },
    });

    await runner.run();

    expect(onPollError).toHaveBeenCalledWith(fetchError);
    expect(polls).toBe(2);
    expect(clients[0].eventSubmit).toHaveBeenCalledOnce();
  });

  it('terminates on a journal error', async () => {
    const journalError = new Error('journal unavailable');
    const runner = makeRunner();
    clients[0].eventSubmit.mockRejectedValueOnce(journalError);

    await expect(runner.run()).rejects.toBe(journalError);

    expect(workers[0].close).toHaveBeenCalledOnce();
    expect(clients[0].close).toHaveBeenCalledOnce();
  });
});
