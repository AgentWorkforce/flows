import { pollHackerNewsOnce, type EventSink, type PollOptions } from './hn-poller.js';
import { JournalClient } from './journal-client.js';
import type { Pins } from './protocol.js';
import { AgentWorker } from './worker.js';

const DEFAULT_POLL_INTERVAL_MS = 60_000;

interface RunnerClient {
  connect(): Promise<void>;
  hello(client: string): Promise<unknown>;
  eventSubmit(spec: unknown, event: { type: string; payload?: unknown; key?: string }): Promise<unknown>;
  close(): void;
}

interface RunnerWorker {
  attach(): Promise<void>;
  close(): void;
}

export interface HnMonitorRunnerOptions extends PollOptions {
  socketPath: string;
  spec: unknown;
  workerId: string;
  pins: Pins;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  onPollError?: (error: unknown) => void;
  clientFactory?: (socketPath: string) => RunnerClient;
  workerFactory?: (client: RunnerClient, workerId: string, pins: Pins) => RunnerWorker;
}

/** Runs the Hacker News poller continuously with an attached agent worker. */
export class HnMonitorRunner {
  private readonly client: RunnerClient;
  private readonly worker: RunnerWorker;
  private readonly pollIntervalMs: number;

  constructor(private readonly options: HnMonitorRunnerOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? pollIntervalFromEnv();
    const clientFactory = options.clientFactory ?? ((path) => new JournalClient(path));
    this.client = clientFactory(options.socketPath);
    const workerFactory = options.workerFactory ?? ((client, workerId, pins) =>
      new AgentWorker(client as JournalClient, { workerId, pins }));
    this.worker = workerFactory(this.client, options.workerId, options.pins);
  }

  async run(): Promise<void> {
    try {
      await this.client.connect();
      await this.client.hello('hn-monitor-runner');
      await this.worker.attach();

      while (!this.options.signal?.aborted) {
        try {
          await pollHackerNewsOnce(this.options.spec, this.failClosedSink(), this.pollOptions());
        } catch (error) {
          if (error instanceof JournalSubmissionError) throw error.cause;
          this.options.onPollError?.(error);
        }
        await delay(this.pollIntervalMs, this.options.signal);
      }
    } finally {
      this.worker.close();
      this.client.close();
    }
  }

  private failClosedSink(): EventSink {
    return {
      eventSubmit: async (spec, event) => {
        try {
          return await this.client.eventSubmit(spec, event);
        } catch (cause) {
          throw new JournalSubmissionError(cause);
        }
      },
    };
  }

  private pollOptions(): PollOptions {
    return {
      storyLimit: this.options.storyLimit,
      fetcher: this.options.fetcher,
      createdBy: this.options.createdBy,
    };
  }
}

class JournalSubmissionError extends Error {
  constructor(readonly cause: unknown) {
    super('journal event submission failed');
  }
}

function pollIntervalFromEnv(): number {
  const value = Number(process.env.POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_POLL_INTERVAL_MS;
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
