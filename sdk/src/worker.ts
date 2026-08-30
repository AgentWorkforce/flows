import { spawn, type ChildProcess } from 'node:child_process';
import { JournalClient } from './journal-client.js';
import type { Pins, StepDispatchEvent } from './protocol.js';

export interface AgentWorkerOptions {
  socketPath: string;
  workerId: string;
  pins?: Pins;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onError?: (error: Error) => void;
}

interface AgentDispatchSpec {
  type: 'agent';
  cli: string;
  instruction: string;
}

/** Executes journal-dispatched agent CLI steps outside the kernel. */
export class AgentWorker {
  private readonly client: JournalClient;
  private readonly children = new Set<ChildProcess>();
  private started = false;

  constructor(private readonly options: AgentWorkerOptions) {
    this.client = new JournalClient(options.socketPath);
  }

  /** Connect and attach before starting a run so its first drive can dispatch. */
  async start(): Promise<void> {
    if (this.started) return;
    await this.client.connect();
    this.client.on('step.dispatch', this.onDispatch);
    try {
      await this.client.hello(this.options.workerId);
      await this.client.workerAttach(
        this.options.workerId,
        ['agent'],
        this.options.pins ?? {
          workspace: [{ surface: 'repo', revision_id: 'unversioned' }],
          streams: [],
        },
      );
      this.started = true;
    } catch (error) {
      this.client.off('step.dispatch', this.onDispatch);
      this.client.close();
      throw error;
    }
  }

  close(): void {
    for (const child of this.children) child.kill();
    this.children.clear();
    this.client.off('step.dispatch', this.onDispatch);
    this.client.close();
    this.started = false;
  }

  private readonly onDispatch = (value: unknown): void => {
    void this.execute(value as StepDispatchEvent).catch((error: unknown) => {
      this.options.onError?.(asError(error));
    });
  };

  private async execute(dispatch: StepDispatchEvent): Promise<void> {
    const spec = agentSpec(dispatch.spec);
    if (!spec) {
      await this.complete(dispatch, 'worker_error', {
        error: 'agent dispatch omitted a CLI or instruction',
      });
      return;
    }

    const heartbeat = setInterval(() => {
      void this.client.stepHeartbeat(
        dispatch.run_id,
        dispatch.step_id,
        dispatch.attempt,
        dispatch.lease_id,
      ).catch((error: unknown) => this.options.onError?.(asError(error)));
    }, 5_000);
    heartbeat.unref();

    try {
      const result = await this.runCli(spec.cli, spec.instruction);
      await this.complete(
        dispatch,
        result.exitCode === 0 ? 'success' : 'worker_error',
        result.stdout,
      );
    } catch (error) {
      await this.complete(dispatch, 'worker_error', { error: asError(error).message });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private complete(
    dispatch: StepDispatchEvent,
    reason: 'success' | 'worker_error',
    output: unknown,
  ): Promise<unknown> {
    return this.client.stepComplete(
      dispatch.run_id,
      dispatch.step_id,
      dispatch.attempt,
      dispatch.idempotency_key,
      reason,
      { output, started_pins: dispatch.pins, end_pins: dispatch.pins },
    );
  }

  private runCli(cli: string, instruction: string): Promise<{ exitCode: number; stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(cli, [], {
        cwd: this.options.cwd,
        env: this.options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.children.add(child);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', reject);
      child.once('close', (code) => {
        this.children.delete(child);
        if (code === null) {
          reject(new Error('agent CLI exited without an exit code'));
          return;
        }
        const stderrText = Buffer.concat(stderr).toString('utf8');
        if (code !== 0 && stderrText.length > 0) {
          resolve({ exitCode: code, stdout: stderrText });
          return;
        }
        resolve({ exitCode: code, stdout: Buffer.concat(stdout).toString('utf8') });
      });
      child.stdin.end(`${instruction}\n`);
    });
  }
}

function agentSpec(value: unknown): AgentDispatchSpec | null {
  if (typeof value !== 'object' || value === null) return null;
  const spec = value as Record<string, unknown>;
  return spec['type'] === 'agent'
    && typeof spec['cli'] === 'string'
    && typeof spec['instruction'] === 'string'
    ? spec as unknown as AgentDispatchSpec
    : null;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
