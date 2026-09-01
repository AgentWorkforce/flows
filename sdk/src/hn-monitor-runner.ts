import { JournalClient } from './journal-client.js';
import { pollHackerNewsOnce, type EventSink, type Fetcher } from './hn-poller.js';
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

export interface HnMonitorRunnerOptions {
  socketPath: string;
  spec: unknown;
  workerId: string;
  pins: Pins;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  fetcher?: Fetcher;
  onPollError?: (error: unknown) => void;
  client?: RunnerClient;
  worker?: RunnerWorker;
}

class JournalSubmissionError extends Error {
  constructor(readonly cause: unknown) {
    super('HN event journal submission failed');
  }
}

/** Keeps an HN event source and an agent worker attached to one relayflowd. */
export class HnMonitorRunner {
  private readonly client: RunnerClient;
  private readonly worker: RunnerWorker;
  private readonly fetcher?: Fetcher;
  private readonly onPollError: (error: unknown) => void;
  private readonly pollIntervalMs: number;

  constructor(private readonly options: HnMonitorRunnerOptions) {
    this.client = options.client ?? new JournalClient(options.socketPath);
    this.worker = options.worker ?? new AgentWorker(
      this.client as JournalClient,
      { workerId: options.workerId, pins: options.pins },
    );
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
        await abortibleSleep(this.pollIntervalMs, this.options.signal);
      }
    } finally {
      this.worker.close();
      this.client.close();
    }
  }

  private async pollOnce(): Promise<void> {
    const sink: EventSink = {
      eventSubmit: async (spec, event) => {
        try {
          return await this.client.eventSubmit(spec, event);
        } catch (error) {
          throw new JournalSubmissionError(error);
        }
      },
    };

    try {
      await pollHackerNewsOnce(this.options.spec, sink, { fetcher: this.fetcher });
    } catch (error) {
      if (error instanceof JournalSubmissionError) throw error.cause;
      this.onPollError(error);
    }
  }
}

function pollIntervalFromEnvironment(): number {
  const configured = process.env.POLL_INTERVAL_MS;
  if (configured === undefined) return DEFAULT_POLL_INTERVAL_MS;
  const interval = Number(configured);
  if (!Number.isFinite(interval) || interval < 0) {
    throw new Error('POLL_INTERVAL_MS must be a non-negative number');
  }
  return interval;
}

function abortibleSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
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
