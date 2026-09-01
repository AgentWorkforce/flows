import { JournalClient } from './journal-client.js';
import { pollHackerNewsOnce, type Fetcher } from './hn-poller.js';
import type { Pins } from './protocol.js';
import { AgentWorker } from './worker.js';

const DEFAULT_POLL_INTERVAL_MS = 60_000;

const defaultFetcher: Fetcher = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HN fetch failed: HTTP ${response.status}`);
  return response.text();
};

export interface HnMonitorRunnerOptions {
  socketPath: string;
  spec: unknown;
  workerId: string;
  pins: Pins;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  fetcher?: Fetcher;
  storyLimit?: number;
  onPollError?: (error: unknown) => void;
}

class FetchError {
  constructor(readonly cause: unknown) {}
}

/** Continuously submits Hacker News events and serves their agent steps. */
export class HnMonitorRunner {
  private readonly client: JournalClient;
  private readonly worker: AgentWorker;
  private readonly pollIntervalMs: number;

  constructor(private readonly options: HnMonitorRunnerOptions) {
    this.client = new JournalClient(options.socketPath);
    this.worker = new AgentWorker(this.client, {
      workerId: options.workerId,
      pins: options.pins,
    });
    this.pollIntervalMs = options.pollIntervalMs ?? pollIntervalFromEnv();
  }

  async run(): Promise<void> {
    try {
      await this.client.connect();
      await this.worker.attach();
      while (!this.options.signal?.aborted) {
        await this.pollOnce();
        await delay(this.pollIntervalMs, this.options.signal);
      }
    } finally {
      this.worker.close();
      this.client.close();
    }
  }

  private async pollOnce(): Promise<void> {
    const fetcher = wrapFetcher(this.options.fetcher ?? defaultFetcher);
    try {
      await pollHackerNewsOnce(this.options.spec, this.client, {
        fetcher,
        storyLimit: this.options.storyLimit,
      });
    } catch (error) {
      if (!(error instanceof FetchError)) throw error;
      this.options.onPollError?.(error.cause);
    }
  }
}

function wrapFetcher(fetcher: Fetcher): Fetcher {
  return async (url) => {
    try {
      return await fetcher(url);
    } catch (error) {
      throw new FetchError(error);
    }
  };
}

function pollIntervalFromEnv(): number {
  const value = process.env.POLL_INTERVAL_MS;
  if (value === undefined) return DEFAULT_POLL_INTERVAL_MS;
  const interval = Number(value);
  if (!Number.isFinite(interval) || interval < 0) {
    throw new Error('POLL_INTERVAL_MS must be a non-negative number');
  }
  return interval;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
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
