import { AgentWorker } from './worker.js';
import { HN_TOP_STORIES_URL, pollHackerNewsOnce, type EventSink, type Fetcher } from './hn-poller.js';
import { JournalClient } from './journal-client.js';
import type { Pins } from './protocol.js';

const DEFAULT_POLL_INTERVAL_MS = 60_000;

export interface HnMonitorClient extends EventSink {
  connect(): Promise<void>;
  close(): void;
}

export interface HnMonitorWorker {
  attach(): Promise<void>;
  close(): void | Promise<void>;
}

export interface HnMonitorRunnerOptions {
  spec: unknown;
  socketPath: string;
  workerId: string;
  pins: Pins;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  fetcher?: Fetcher;
  onPollError?: (error: unknown) => void;
  client?: HnMonitorClient;
  worker?: HnMonitorWorker;
}

/** Connects the HN poller and agent worker to one journal-protocol client. */
export class HnMonitorRunner {
  private readonly client: HnMonitorClient;
  private readonly fetcher: Fetcher;
  private readonly onPollError: (error: unknown) => void;
  private readonly options: HnMonitorRunnerOptions;
  private readonly pollIntervalMs: number;
  private readonly worker: HnMonitorWorker;

  constructor(options: HnMonitorRunnerOptions) {
    this.options = options;
    this.client = options.client ?? new JournalClient(options.socketPath);
    this.worker = options.worker ?? new AgentWorker(this.client as JournalClient, {
      workerId: options.workerId,
      pins: options.pins,
    });
    this.fetcher = options.fetcher ?? fetchTopStories;
    this.onPollError = options.onPollError ?? (() => undefined);
    this.pollIntervalMs = options.pollIntervalMs ?? pollIntervalFromEnvironment();
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs < 0) {
      throw new Error('hn monitor: poll interval must be a non-negative finite number');
    }
  }

  async run(): Promise<void> {
    await this.client.connect();
    try {
      await this.worker.attach();
      while (!this.options.signal?.aborted) {
        const body = await this.fetchOnce();
        if (body !== undefined) {
          await pollHackerNewsOnce(this.options.spec, this.client, {
            fetcher: async () => body,
          });
        }
        await abortableSleep(this.pollIntervalMs, this.options.signal);
      }
    } finally {
      await this.worker.close();
      this.client.close();
    }
  }

  private async fetchOnce(): Promise<string | undefined> {
    try {
      return await this.fetcher(HN_TOP_STORIES_URL);
    } catch (error) {
      this.onPollError(error);
      return undefined;
    }
  }
}

async function fetchTopStories(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HN fetch failed: HTTP ${response.status}`);
  return response.text();
}

function pollIntervalFromEnvironment(): number {
  const configured = process.env.POLL_INTERVAL_MS;
  return configured === undefined ? DEFAULT_POLL_INTERVAL_MS : Number(configured);
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
