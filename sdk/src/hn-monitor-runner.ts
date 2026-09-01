import { join, resolve } from 'node:path';
import { HnFetchError, pollHackerNewsOnce, type Fetcher } from './hn-poller.js';
import { JournalClient } from './journal-client.js';
import type { Pins } from './protocol.js';
import { AgentWorker } from './worker.js';

const DEFAULT_POLL_INTERVAL_MS = 60_000;

interface RunnerClient {
  connect(): Promise<void>;
  hello(name: string): Promise<unknown>;
  eventSubmit(spec: unknown, event: { type: string; payload?: unknown; key?: string }): Promise<unknown>;
  close(): void;
}

interface RunnerWorker {
  attach(): Promise<void>;
  close(): Promise<void> | void;
}

export interface HnMonitorRunnerOptions {
  spec: unknown;
  workerId: string;
  pins: Pins;
  socketPath?: string;
  pollIntervalMs?: number;
  fetcher?: Fetcher;
  signal?: AbortSignal;
  onPollError?: (error: HnFetchError) => void;
}

export interface HnMonitorRunnerDependencies {
  client?: RunnerClient;
  worker?: RunnerWorker;
}

/** Continuously polls Hacker News and submits events through the journal. */
export class HnMonitorRunner {
  private readonly client: RunnerClient;
  private readonly fetcher?: Fetcher;
  private readonly onPollError: (error: HnFetchError) => void;
  private readonly pollIntervalMs: number;
  private readonly signal?: AbortSignal;
  private readonly spec: unknown;
  private readonly worker: RunnerWorker;

  constructor(options: HnMonitorRunnerOptions, dependencies: HnMonitorRunnerDependencies = {}) {
    const socketPath = options.socketPath ?? defaultSocketPath();
    const client = dependencies.client ?? new JournalClient(socketPath);
    this.client = client;
    this.fetcher = options.fetcher;
    this.onPollError = options.onPollError ?? (() => undefined);
    this.pollIntervalMs = (
      options.pollIntervalMs ?? Number.parseInt(process.env.POLL_INTERVAL_MS ?? '', 10)
    ) || DEFAULT_POLL_INTERVAL_MS;
    this.signal = options.signal;
    this.spec = options.spec;
    this.worker = dependencies.worker
      ?? new AgentWorker(client as JournalClient, { workerId: options.workerId, pins: options.pins });
  }

  async run(): Promise<void> {
    await this.client.connect();
    try {
      await this.client.hello('hn-monitor-runner');
      await this.worker.attach();
      while (!this.signal?.aborted) {
        try {
          await pollHackerNewsOnce(this.spec, this.client, { fetcher: this.fetcher });
        } catch (error) {
          if (!(error instanceof HnFetchError)) throw error;
          this.onPollError(error);
        }
        await abortableDelay(this.pollIntervalMs, this.signal);
      }
    } finally {
      await this.worker.close();
      this.client.close();
    }
  }
}

function defaultSocketPath(): string {
  const dataDir = resolve(process.env.RELAYFLOW_DATA_DIR ?? join(process.cwd(), '..', '.relayflowd'));
  return join(dataDir, 'relayflowd.sock');
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolveDelay();
    }
  });
}
