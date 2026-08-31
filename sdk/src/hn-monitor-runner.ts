import { JournalClient } from './journal-client.js';
import { pollHackerNewsOnce, type EventSink, type Fetcher } from './hn-poller.js';
import type { Pins } from './protocol.js';
import { AgentWorker } from './worker.js';

const DEFAULT_POLL_INTERVAL_MS = 60_000;

interface RunnerClient extends EventSink {
  connect(): Promise<void>;
  close(): void;
}

interface RunnerWorker {
  attach(): Promise<void>;
  close(): Promise<void>;
}

export interface HnMonitorRunnerOptions {
  socketPath: string;
  spec: unknown;
  workerId: string;
  pins: Pins;
  signal?: AbortSignal;
  fetcher?: Fetcher;
  pollIntervalMs?: number;
  onPollError?: (error: unknown) => void;
  clientFactory?: (socketPath: string) => RunnerClient;
  workerFactory?: (client: RunnerClient) => RunnerWorker;
}

/** Continuously connects the HN adapter to the journal and its agent worker. */
export class HnMonitorRunner {
  private readonly client: RunnerClient;
  private readonly fetcher?: Fetcher;
  private readonly onPollError: (error: unknown) => void;
  private readonly pollIntervalMs: number;
  private readonly signal?: AbortSignal;
  private readonly spec: unknown;
  private readonly worker: RunnerWorker;

  constructor(options: HnMonitorRunnerOptions) {
    this.client = (options.clientFactory ?? ((path) => new JournalClient(path)))(options.socketPath);
    this.fetcher = options.fetcher;
    this.onPollError = options.onPollError ?? (() => undefined);
    this.pollIntervalMs = options.pollIntervalMs ?? pollIntervalFromEnvironment();
    this.signal = options.signal;
    this.spec = options.spec;
    this.worker = (options.workerFactory ?? ((client) => new AgentWorker(
      client as JournalClient,
      { workerId: options.workerId, pins: options.pins },
    )))(this.client);
  }

  async run(): Promise<void> {
    await this.client.connect();
    try {
      await this.worker.attach();
      while (!this.signal?.aborted) {
        await this.pollOnce();
        if (this.signal?.aborted) break;
        await abortableSleep(this.pollIntervalMs, this.signal);
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
      await pollHackerNewsOnce(this.spec, sink, { fetcher: this.fetcher });
    } catch (error) {
      if (journalError !== undefined) throw journalError;
      this.onPollError(error);
    }
  }
}

function pollIntervalFromEnvironment(): number {
  const configured = process.env.POLL_INTERVAL_MS;
  if (configured === undefined) return DEFAULT_POLL_INTERVAL_MS;
  const interval = Number(configured);
  if (!Number.isFinite(interval) || interval < 0) {
    throw new Error('POLL_INTERVAL_MS must be a non-negative number');
  }
  return interval;
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}

export const HN_MONITOR_DEFAULT_POLL_INTERVAL_MS = DEFAULT_POLL_INTERVAL_MS;
