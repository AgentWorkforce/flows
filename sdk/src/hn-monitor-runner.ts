import type { Pins } from './protocol.js';
import { JournalClient } from './journal-client.js';
import { AgentWorker } from './worker.js';
import {
  pollHackerNewsOnce,
  type EventSink,
  type Fetcher,
} from './hn-poller.js';

const DEFAULT_POLL_INTERVAL_MS = 60_000;

interface RunnerClient extends EventSink {
  connect(): Promise<void>;
  hello(client: string): Promise<unknown>;
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
  pollIntervalMs?: number;
  storyLimit?: number;
  fetcher?: Fetcher;
  onPollError?: (error: HnFetchError) => void;
  client?: RunnerClient;
  worker?: RunnerWorker;
}

export class HnFetchError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(`HN fetch failed: ${errorMessage(cause)}`);
    this.name = 'HnFetchError';
    this.cause = cause;
  }
}

/** Continuously submits Hacker News events and hosts their agent worker. */
export class HnMonitorRunner {
  private readonly client: RunnerClient;
  private readonly worker: RunnerWorker;
  private readonly fetcher: Fetcher;
  private readonly pollIntervalMs: number;
  private readonly options: HnMonitorRunnerOptions;

  constructor(options: HnMonitorRunnerOptions) {
    this.options = options;
    const client = options.client ?? new JournalClient(options.socketPath);
    this.client = client;
    this.worker = options.worker ?? new AgentWorker(client as JournalClient, {
      workerId: options.workerId,
      pins: options.pins,
    });
    this.fetcher = wrapFetcher(options.fetcher ?? fetchText);
    this.pollIntervalMs = options.pollIntervalMs ?? intervalFromEnvironment();
  }

  async run(): Promise<void> {
    await this.client.connect();
    try {
      await this.client.hello('hn-monitor-runner');
      await this.worker.attach();
      while (!this.options.signal?.aborted) {
        try {
          await pollHackerNewsOnce(this.options.spec, this.client, {
            fetcher: this.fetcher,
            storyLimit: this.options.storyLimit,
          });
        } catch (error) {
          if (!(error instanceof HnFetchError)) throw error;
          this.options.onPollError?.(error);
        }
        await waitForNextTick(this.pollIntervalMs, this.options.signal);
      }
    } finally {
      await this.worker.close();
      this.client.close();
    }
  }
}

function wrapFetcher(fetcher: Fetcher): Fetcher {
  return async (url) => {
    try {
      return await fetcher(url);
    } catch (error) {
      throw new HnFetchError(error);
    }
  };
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function intervalFromEnvironment(): number {
  const configured = process.env.POLL_INTERVAL_MS;
  if (configured === undefined) return DEFAULT_POLL_INTERVAL_MS;
  const interval = Number(configured);
  if (!Number.isFinite(interval) || interval < 0) {
    throw new Error('POLL_INTERVAL_MS must be a non-negative number');
  }
  return interval;
}

function waitForNextTick(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });

    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
