import { HnPollFetchError, pollHackerNewsOnce, type Fetcher } from './hn-poller.js';
import { JournalClient } from './journal-client.js';
import type { Pins } from './protocol.js';
import { AgentWorker, type AgentWorkerClient } from './worker.js';

const DEFAULT_POLL_INTERVAL_MS = 60_000;

export interface HnMonitorClient extends AgentWorkerClient {
  connect(): Promise<void>;
  hello(client: string): Promise<unknown>;
  eventSubmit(spec: unknown, event: { type: string; payload?: unknown; key?: string }): Promise<unknown>;
  close(): void;
}

export interface HnMonitorRunnerOptions {
  socketPath: string;
  spec: unknown;
  workerId: string;
  pins: Pins;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  fetcher?: Fetcher;
  onPollError?: (error: HnPollFetchError) => void;
  /** Test seam; production callers omit this and use the socket-backed client. */
  client?: HnMonitorClient;
}

export const POLL_INTERVAL_MS = pollIntervalFromEnvironment();

/** Continuously turns Hacker News polls into journal-protocol events. */
export class HnMonitorRunner {
  private readonly client: HnMonitorClient;
  private readonly fetcher: Fetcher | undefined;
  private readonly onPollError: (error: HnPollFetchError) => void;
  private readonly options: HnMonitorRunnerOptions;
  private readonly pollIntervalMs: number;
  private readonly worker: AgentWorker;

  constructor(options: HnMonitorRunnerOptions) {
    this.options = options;
    this.client = options.client ?? new JournalClient(options.socketPath);
    this.worker = new AgentWorker(this.client, { workerId: options.workerId, pins: options.pins });
    this.fetcher = options.fetcher;
    this.onPollError = options.onPollError ?? (() => {});
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs < 0) {
      throw new Error('hn monitor: pollIntervalMs must be a non-negative finite number');
    }
  }

  async run(): Promise<void> {
    try {
      await this.client.connect();
      await this.client.hello('hn-monitor-runner');
      await this.worker.attach();

      while (!this.options.signal?.aborted) {
        try {
          await pollHackerNewsOnce(this.options.spec, this.client, { fetcher: this.fetcher });
        } catch (error) {
          if (!(error instanceof HnPollFetchError)) throw error;
          this.onPollError(error);
        }
        if (!await sleep(this.pollIntervalMs, this.options.signal)) break;
      }
    } finally {
      await this.worker.close();
      this.client.close();
    }
  }
}

function pollIntervalFromEnvironment(): number {
  const configured = process.env.POLL_INTERVAL_MS;
  if (configured === undefined) return DEFAULT_POLL_INTERVAL_MS;
  const interval = Number(configured);
  if (!Number.isFinite(interval) || interval < 0) {
    throw new Error('POLL_INTERVAL_MS must be a non-negative finite number');
  }
  return interval;
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(true), milliseconds);
    const finish = (elapsed: boolean): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(elapsed);
    };
    const onAbort = (): void => finish(false);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
