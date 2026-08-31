import type { JournalClient } from './journal-client.js';
import { pollHackerNewsOnce, type Fetcher } from './hn-poller.js';
import type { Pins } from './protocol.js';
import { AgentWorker } from './worker.js';

const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface HnMonitorRunnerOptions {
  spec: unknown;
  workerId: string;
  pins: Pins;
  pollIntervalMs?: number;
  storyLimit?: number;
  fetcher?: Fetcher;
  signal?: AbortSignal;
  onPollError?: (error: unknown) => void;
}

class FetchError {
  constructor(readonly cause: unknown) {}
}

/** Keeps an HN event producer and its agent worker alive until aborted. */
export class HnMonitorRunner {
  private readonly client: JournalClient;
  private readonly options: HnMonitorRunnerOptions;
  private readonly worker: AgentWorker;
  private readonly fetcher: Fetcher;
  private readonly pollIntervalMs: number;

  constructor(client: JournalClient, options: HnMonitorRunnerOptions) {
    this.client = client;
    this.options = options;
    this.worker = new AgentWorker(client, {
      workerId: options.workerId,
      pins: options.pins,
    });
    const fetcher = options.fetcher ?? fetchText;
    this.fetcher = async (url) => {
      try {
        return await fetcher(url);
      } catch (error) {
        throw new FetchError(error);
      }
    };
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async run(): Promise<void> {
    await this.worker.attach();
    try {
      while (!this.options.signal?.aborted) {
        try {
          await pollHackerNewsOnce(this.options.spec, this.client, {
            fetcher: this.fetcher,
            storyLimit: this.options.storyLimit,
          });
        } catch (error) {
          if (!(error instanceof FetchError)) throw error;
          this.options.onPollError?.(error.cause);
        }

        await waitForNextPoll(this.pollIntervalMs, this.options.signal);
      }
    } finally {
      this.worker.close();
    }
  }
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HN fetch failed: HTTP ${response.status}`);
  return response.text();
}

function waitForNextPoll(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, delayMs);
    signal?.addEventListener('abort', done, { once: true });

    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}
