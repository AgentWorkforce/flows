import { join, resolve } from 'node:path';
import { pollHackerNewsOnce, type EventSink, type Fetcher } from './hn-poller.js';
import { JournalClient } from './journal-client.js';
import type { Pins } from './protocol.js';
import { AgentWorker } from './worker.js';

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_WORKER_ID = 'hn-monitor-runner';

export interface HnMonitorRunnerOptions {
  spec: unknown;
  signal?: AbortSignal;
  socketPath?: string;
  workerId?: string;
  pins?: Pins;
  pollIntervalMs?: number;
  fetcher?: Fetcher;
  storyLimit?: number;
  onPollError?: (error: unknown) => void;
  /** Test seam; production runners construct their own socket client. */
  client?: JournalClient;
}

/** Continuously turns Hacker News polls into journaled relayflow events. */
export class HnMonitorRunner {
  private readonly spec: unknown;
  private readonly signal: AbortSignal | undefined;
  private readonly pollIntervalMs: number;
  private readonly fetcher: Fetcher | undefined;
  private readonly storyLimit: number | undefined;
  private readonly onPollError: (error: unknown) => void;
  private readonly client: JournalClient;
  private readonly worker: AgentWorker;

  constructor(options: HnMonitorRunnerOptions) {
    this.spec = options.spec;
    this.signal = options.signal;
    this.pollIntervalMs = pollInterval(options.pollIntervalMs);
    this.fetcher = options.fetcher;
    this.storyLimit = options.storyLimit;
    this.onPollError = options.onPollError ?? (() => undefined);
    this.client = options.client ?? new JournalClient(options.socketPath ?? defaultSocketPath());
    this.worker = new AgentWorker(this.client, {
      workerId: options.workerId ?? DEFAULT_WORKER_ID,
      pins: options.pins ?? { workspace: [], streams: [] },
    });
  }

  async run(): Promise<void> {
    await this.client.connect();
    try {
      await this.client.hello(DEFAULT_WORKER_ID);
      await this.worker.attach();

      while (!this.signal?.aborted) {
        await this.pollOnce();
        if (!this.signal?.aborted) await delay(this.pollIntervalMs, this.signal);
      }
    } finally {
      await this.worker.close();
      this.client.close();
    }
  }

  private async pollOnce(): Promise<void> {
    let journalFailure: unknown;
    const sink: EventSink = {
      eventSubmit: async (spec, event) => {
        try {
          return await this.client.eventSubmit(spec, event);
        } catch (error) {
          journalFailure = error;
          throw error;
        }
      },
    };

    try {
      await pollHackerNewsOnce(this.spec, sink, {
        fetcher: this.fetcher,
        storyLimit: this.storyLimit,
      });
    } catch (error) {
      if (error === journalFailure) throw error;
      this.onPollError(error);
    }
  }
}

function defaultSocketPath(): string {
  const dataDirectory = resolve(process.env.RELAYFLOW_DATA_DIR ?? '.relayflowd');
  return join(dataDirectory, 'relayflowd.sock');
}

function pollInterval(configured: number | undefined): number {
  const value = configured ?? Number(process.env.POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('POLL_INTERVAL_MS must be a non-negative number');
  }
  return value;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay) => {
    if (signal?.aborted) return resolveDelay();
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolveDelay();
    }
  });
}

export const POLL_INTERVAL_MS = DEFAULT_POLL_INTERVAL_MS;
