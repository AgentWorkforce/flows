import type { EventEmitter } from 'node:events';
import { AgentWorker, type AgentWorkerOptions } from './worker.js';
import { pollHackerNewsOnce, type EventSink, type PollOptions } from './hn-poller.js';
import { JournalClient } from './journal-client.js';

const DEFAULT_POLL_INTERVAL_MS = 60_000;

interface RunnerClient extends EventSink, EventEmitter {
  connect(): Promise<void>;
  hello(client: string): Promise<unknown>;
  close(): void;
}

interface RunnerWorker {
  attach(): Promise<void>;
  close(): void;
}

interface SignalSource {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface HnMonitorRunnerOptions {
  socketPath: string;
  spec: unknown;
  worker: AgentWorkerOptions;
  pollIntervalMs?: number;
  pollOptions?: PollOptions;
  client?: RunnerClient;
  agentWorker?: RunnerWorker;
  signalSource?: SignalSource;
  onPollError?: (error: unknown) => void;
}

/**
 * Owns the lifetime of one continuous HN polling workload.
 * A class keeps shutdown state and injected lifecycle dependencies scoped to
 * this run instead of installing process-global state in a start function.
 */
export class HnMonitorRunner {
  private readonly client: RunnerClient;
  private readonly worker: RunnerWorker;
  private readonly signals: SignalSource;
  private readonly intervalMs: number;
  private stopping = false;
  private sleepController: AbortController | undefined;

  constructor(private readonly options: HnMonitorRunnerOptions) {
    this.client = options.client ?? new JournalClient(options.socketPath);
    this.worker = options.agentWorker ?? new AgentWorker(this.client as JournalClient, options.worker);
    this.signals = options.signalSource ?? process;
    this.intervalMs = options.pollIntervalMs ?? pollIntervalFromEnvironment();
    if (!Number.isFinite(this.intervalMs) || this.intervalMs < 0) {
      throw new Error('HN monitor poll interval must be a non-negative finite number');
    }
  }

  async run(): Promise<void> {
    this.signals.on('SIGINT', this.stop);
    this.signals.on('SIGTERM', this.stop);
    try {
      await this.client.connect();
      await this.client.hello('hn-monitor-runner');
      await this.worker.attach();

      while (!this.stopping) {
        try {
          await pollHackerNewsOnce(this.options.spec, this.client, this.options.pollOptions);
        } catch (error) {
          this.options.onPollError?.(error);
        }
        if (!this.stopping) await this.sleep();
      }
    } finally {
      this.signals.off('SIGINT', this.stop);
      this.signals.off('SIGTERM', this.stop);
      this.worker.close();
      this.client.close();
    }
  }

  private readonly stop = (): void => {
    this.stopping = true;
    this.sleepController?.abort();
  };

  private async sleep(): Promise<void> {
    const controller = new AbortController();
    this.sleepController = controller;
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.intervalMs);
        controller.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    } finally {
      this.sleepController = undefined;
    }
  }
}

function pollIntervalFromEnvironment(): number {
  const configured = process.env.POLL_INTERVAL_MS;
  return configured === undefined ? DEFAULT_POLL_INTERVAL_MS : Number(configured);
}

export { DEFAULT_POLL_INTERVAL_MS };
