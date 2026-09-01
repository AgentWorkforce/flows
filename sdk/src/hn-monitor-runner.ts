import { JournalClient } from './journal-client.js';
import {
  pollHackerNewsOnce,
  type EventSink,
  type Fetcher,
  type PollOptions,
} from './hn-poller.js';
import type { Pins } from './protocol.js';
import { AgentWorker } from './worker.js';

const DEFAULT_POLL_INTERVAL_MS = 60_000;

interface RunnerClient extends EventSink {
  connect(): Promise<void>;
  close(): void;
}

interface RunnerWorker {
  attach(): Promise<void>;
  close(): void;
}

export interface HnMonitorRunnerOptions extends PollOptions {
  socketPath: string;
  workerId: string;
  pins: Pins;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  onPollError?: (error: HnPollFetchError) => void;
  client?: RunnerClient;
  worker?: RunnerWorker;
}

/** A transient network failure; journal/protocol failures are never wrapped. */
export class HnPollFetchError extends Error {
  constructor(cause: unknown) {
    super(`HN poll fetch failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'HnPollFetchError';
  }
}

/** Continuously submits HN events to relayflowd until its signal is aborted. */
export class HnMonitorRunner {
  private readonly client: RunnerClient;
  private readonly fetcher: Fetcher;
  private readonly intervalMs: number;
  private readonly options: HnMonitorRunnerOptions;
  private readonly spec: unknown;
  private readonly worker: RunnerWorker;

  constructor(spec: unknown, options: HnMonitorRunnerOptions) {
    this.options = options;
    this.intervalMs = pollInterval(options.pollIntervalMs);
    this.client = options.client ?? new JournalClient(options.socketPath);
    this.worker = options.worker
      ?? new AgentWorker(this.client as JournalClient, { workerId: options.workerId, pins: options.pins });
    this.fetcher = typedFetcher(options.fetcher ?? fetchText);
    this.spec = spec;
  }

  async run(): Promise<void> {
    await this.client.connect();
    try {
      await this.worker.attach();
      while (!this.options.signal?.aborted) {
        try {
          await pollHackerNewsOnce(this.spec, this.client, {
            storyLimit: this.options.storyLimit,
            createdBy: this.options.createdBy,
            fetcher: this.fetcher,
          });
        } catch (error) {
          if (!(error instanceof HnPollFetchError)) throw error;
          this.options.onPollError?.(error);
        }
        await waitForNextTick(this.intervalMs, this.options.signal);
      }
    } finally {
      this.worker.close();
      this.client.close();
    }
  }
}

function pollInterval(explicit: number | undefined): number {
  const raw = explicit ?? Number(process.env.POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw < 0) throw new Error('POLL_INTERVAL_MS must be a non-negative number');
  return raw;
}

function typedFetcher(fetcher: Fetcher): Fetcher {
  return async (url) => {
    try {
      return await fetcher(url);
    } catch (error) {
      throw new HnPollFetchError(error);
    }
  };
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
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
