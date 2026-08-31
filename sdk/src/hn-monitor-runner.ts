import { AgentWorker } from './worker.js';
import { pollHackerNewsOnce, type EventSink, type Fetcher } from './hn-poller.js';
import { JournalClient } from './journal-client.js';
import { join } from 'node:path';

const DEFAULT_POLL_INTERVAL_MS = 60_000;

interface RunnerClient extends EventSink {
  connect(): Promise<void>;
  hello(client: string): Promise<unknown>;
  close(): void;
}

interface RunnerWorker {
  attach(): Promise<void>;
  close(): Promise<void> | void;
}

export interface HnMonitorRunnerOptions {
  socketPath?: string;
  client?: RunnerClient;
  worker?: RunnerWorker;
  workerId?: string;
  intervalMs?: number;
  fetcher?: Fetcher;
  onPollError?: (error: unknown) => void;
}

export interface HnMonitorRunOptions {
  /** Test-only bound; production runs until signaled. */
  maxPolls?: number;
}

/** Continuously submits Hacker News events while an agent worker is attached. */
export class HnMonitorRunner {
  private readonly client: RunnerClient;
  private readonly worker: RunnerWorker;
  private readonly intervalMs: number;
  private stopping = false;

  constructor(
    private readonly spec: unknown,
    options: HnMonitorRunnerOptions = {},
  ) {
    const dataDir = process.env.RELAYFLOW_DATA_DIR ?? '.relayflowd';
    const socketPath = options.socketPath ?? process.env.RELAYFLOW_SOCKET_PATH
      ?? join(dataDir, 'relayflowd.sock');
    this.client = options.client ?? new JournalClient(socketPath);
    this.worker = options.worker ?? new AgentWorker(this.client as JournalClient, {
      workerId: options.workerId ?? 'hn-monitor-agent',
      pins: {},
    });
    this.intervalMs = options.intervalMs ?? pollIntervalFromEnv();
    this.fetcher = options.fetcher;
    this.onPollError = options.onPollError ?? ((error) => console.error(error));
  }

  private readonly fetcher: Fetcher | undefined;
  private readonly onPollError: (error: unknown) => void;

  async run(options: HnMonitorRunOptions = {}): Promise<void> {
    const stop = (): void => { this.stopping = true; };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);

    try {
      await this.client.connect();
      await this.client.hello('hn-monitor-runner');
      await this.worker.attach();

      let polls = 0;
      while (!this.stopping && (options.maxPolls === undefined || polls < options.maxPolls)) {
        try {
          await pollHackerNewsOnce(this.spec, this.client, { fetcher: this.fetcher });
        } catch (error) {
          this.onPollError(error);
        }
        polls += 1;
        if (!this.stopping && (options.maxPolls === undefined || polls < options.maxPolls)) {
          await this.sleepUntilNextPoll();
        }
      }
    } finally {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      await this.worker.close();
      this.client.close();
    }
  }

  private sleepUntilNextPoll(): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        process.off('SIGTERM', finish);
        process.off('SIGINT', finish);
        resolve();
      };
      const timer = setTimeout(finish, this.intervalMs);
      process.once('SIGTERM', finish);
      process.once('SIGINT', finish);
    });
  }
}

function pollIntervalFromEnv(): number {
  const value = process.env.POLL_INTERVAL_MS;
  if (value === undefined) return DEFAULT_POLL_INTERVAL_MS;
  const interval = Number(value);
  if (!Number.isFinite(interval) || interval < 0) {
    throw new Error('hn monitor runner: POLL_INTERVAL_MS must be a non-negative number');
  }
  return interval;
}
