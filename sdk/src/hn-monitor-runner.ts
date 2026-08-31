import type { Fetcher } from './hn-poller.js';
import { pollHackerNewsOnce } from './hn-poller.js';
import { JournalClient } from './journal-client.js';
import type { Pins } from './protocol.js';
import { AgentWorker } from './worker.js';

const DEFAULT_POLL_INTERVAL_MS = 60_000;

export interface HnMonitorRunnerOptions {
  socketPath: string;
  spec: unknown;
  workerId: string;
  pins: Pins;
  signal?: AbortSignal;
  fetcher?: Fetcher;
  pollIntervalMs?: number;
  onPollError?: (error: unknown) => void;
  client?: JournalClient;
}

/** Continuously submits Hacker News events and services their agent steps. */
export class HnMonitorRunner {
  private readonly client: JournalClient;
  private readonly fetcher: Fetcher | undefined;
  private readonly onPollError: (error: unknown) => void;
  private readonly options: HnMonitorRunnerOptions;
  private readonly pollIntervalMs: number;
  private readonly worker: AgentWorker;

  constructor(options: HnMonitorRunnerOptions) {
    this.options = options;
    this.client = options.client ?? new JournalClient(options.socketPath);
    this.worker = new AgentWorker(this.client, { workerId: options.workerId, pins: options.pins });
    this.fetcher = options.fetcher;
    this.onPollError = options.onPollError ?? (() => undefined);
    this.pollIntervalMs = options.pollIntervalMs ?? pollIntervalFromEnvironment();
  }

  async run(): Promise<void> {
    await this.client.connect();
    try {
      await this.worker.attach();
      while (!this.options.signal?.aborted) {
        await this.pollOnce();
        await delay(this.pollIntervalMs, this.options.signal);
      }
    } finally {
      await this.worker.close();
      this.client.close();
    }
  }

  private async pollOnce(): Promise<void> {
    let journalFailed = false;
    try {
      await pollHackerNewsOnce(this.options.spec, {
        eventSubmit: async (spec, event) => {
          try {
            return await this.client.eventSubmit(spec, event);
          } catch (error) {
            journalFailed = true;
            throw error;
          }
        },
      }, { fetcher: this.fetcher });
    } catch (error) {
      if (journalFailed) throw error;
      this.onPollError(error);
    }
  }
}

function pollIntervalFromEnvironment(): number {
  const configured = process.env.POLL_INTERVAL_MS;
  if (configured === undefined) return DEFAULT_POLL_INTERVAL_MS;
  const interval = Number(configured);
  if (!Number.isFinite(interval) || interval < 0) {
    throw new Error(`POLL_INTERVAL_MS must be a non-negative number, received ${configured}`);
  }
  return interval;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
  });
}
