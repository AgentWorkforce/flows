import type { JournalClient } from './journal-client.js';
import {
  pollHackerNewsOnce,
  type EventSink,
  type Fetcher,
} from './hn-poller.js';
import type { Pins } from './protocol.js';
import { AgentWorker } from './worker.js';

const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface HnMonitorRunnerOptions {
  workerId: string;
  pins: Pins;
  intervalMs?: number;
  storyLimit?: number;
  fetcher?: Fetcher;
  signal?: AbortSignal;
  onPollError?: (error: unknown) => void;
}

/** Continuously feeds Hacker News events to an attached agent worker. */
export class HnMonitorRunner {
  private readonly client: JournalClient;
  private readonly spec: unknown;
  private readonly options: HnMonitorRunnerOptions;
  private readonly worker: AgentWorker;
  private readonly sink: EventSink;
  private readonly intervalMs: number;

  constructor(
    client: JournalClient,
    spec: unknown,
    options: HnMonitorRunnerOptions,
  ) {
    this.client = client;
    this.spec = spec;
    this.options = options;
    this.worker = new AgentWorker(client, {
      workerId: options.workerId,
      pins: options.pins,
    });
    this.sink = {
      eventSubmit: async (spec, event) => {
        try {
          return await this.client.eventSubmit(spec, event);
        } catch (cause) {
          throw new JournalSubmissionError(cause);
        }
      },
    };
    this.intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async run(): Promise<void> {
    await this.worker.attach();
    try {
      while (this.options.signal?.aborted !== true) {
        try {
          await pollHackerNewsOnce(this.spec, this.sink, {
            storyLimit: this.options.storyLimit,
            fetcher: this.options.fetcher,
          });
        } catch (error) {
          if (error instanceof JournalSubmissionError) throw error.cause;
          this.options.onPollError?.(error);
        }
        await delay(this.intervalMs, this.options.signal);
      }
    } finally {
      this.worker.close();
    }
  }
}

class JournalSubmissionError extends Error {
  constructor(readonly cause: unknown) {
    super('journal event submission failed');
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = (): void => {
      clearTimeout(timer);
      finish();
    };
    if (signal?.aborted === true) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
