import type { EventEmitter } from 'node:events';
import { AgentWorker } from './worker.js';
import { pollHackerNewsOnce, type EventSink, type Fetcher } from './hn-poller.js';
import { JournalClient } from './journal-client.js';
import type { Pins } from './protocol.js';

const DEFAULT_POLL_INTERVAL_MS = 60_000;

type RunnerClient = EventEmitter & EventSink & {
  connect(): Promise<void>;
  hello(client: string): Promise<unknown>;
  close(): void;
};

interface RunnerWorker {
  attach(): Promise<void>;
  close(): Promise<void> | void;
}

export interface HnMonitorRunnerOptions {
  socketPath: string;
  spec: unknown;
  workerId: string;
  pins: Pins;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  fetcher?: Fetcher;
  onPollError?: (error: HnMonitorPollError) => void;
  clientFactory?: (socketPath: string) => RunnerClient;
  workerFactory?: (client: RunnerClient, workerId: string, pins: Pins) => RunnerWorker;
}

/** A recoverable failure fetching or decoding one HN poll. */
export class HnMonitorPollError extends Error {
  constructor(cause: unknown) {
    super(`Hacker News poll failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'HnMonitorPollError';
  }
}

/** Connects the HN poller to an attached agent worker and the journal. */
export class HnMonitorRunner {
  private readonly client: RunnerClient;
  private readonly worker: RunnerWorker;
  private readonly intervalMs: number;
  private readonly options: HnMonitorRunnerOptions;

  constructor(options: HnMonitorRunnerOptions) {
    this.options = options;
    this.intervalMs = options.pollIntervalMs ?? pollIntervalFromEnvironment();
    this.client = options.clientFactory?.(options.socketPath) ?? new JournalClient(options.socketPath);
    this.worker = options.workerFactory?.(this.client, options.workerId, options.pins)
      ?? new AgentWorker(this.client as JournalClient, { workerId: options.workerId, pins: options.pins });
  }

  async run(): Promise<void> {
    await this.client.connect();
    try {
      await this.client.hello('hn-monitor-runner');
      await this.worker.attach();

      while (this.options.signal?.aborted !== true) {
        await this.pollOnce();
        await abortableDelay(this.intervalMs, this.options.signal);
      }
    } finally {
      await this.worker.close();
      this.client.close();
    }
  }

  private async pollOnce(): Promise<void> {
    let journalError: unknown;
    const sink: EventSink = {
      eventSubmit: async (spec, event) => {
        try {
          return await this.client.eventSubmit(spec, event);
        } catch (error) {
          journalError = error;
          throw error;
        }
      },
    };

    try {
      await pollHackerNewsOnce(this.options.spec, sink, { fetcher: this.options.fetcher });
    } catch (error) {
      if (journalError !== undefined) throw journalError;
      this.options.onPollError?.(new HnMonitorPollError(error));
    }
  }
}

function pollIntervalFromEnvironment(): number {
  const raw = process.env.POLL_INTERVAL_MS;
  if (raw === undefined) return DEFAULT_POLL_INTERVAL_MS;
  const interval = Number(raw);
  if (!Number.isFinite(interval) || interval < 0) {
    throw new Error(`POLL_INTERVAL_MS must be a non-negative number, received "${raw}"`);
  }
  return interval;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal?.aborted === true) done();
    else signal?.addEventListener('abort', done, { once: true });
  });
}
