import { spawn } from 'node:child_process';
import { JournalClient } from './journal-client.js';
import type { Pins, StepDispatchEvent } from './protocol.js';
import type { KernelAgentStep } from './spec.js';

export interface AgentWorkerOptions {
  socketPath: string;
  workerId: string;
  pins: Pins;
}

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Minimal protocol worker for agent steps. Scheduling and retries stay kernel-owned. */
export class AgentWorker {
  private readonly client: JournalClient;
  private readonly running = new Set<Promise<void>>();
  private failure: Error | undefined;
  private started = false;

  constructor(private readonly options: AgentWorkerOptions) {
    this.client = new JournalClient(options.socketPath);
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('agent worker is already started');
    this.started = true;
    this.client.on('step.dispatch', (value: unknown) => this.accept(value));
    try {
      await this.client.connect();
      await this.client.hello(this.options.workerId);
      await this.client.workerAttach(this.options.workerId, ['agent'], this.options.pins);
    } catch (error) {
      this.started = false;
      this.client.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.running]);
    this.client.close();
    this.started = false;
    if (this.failure) throw this.failure;
  }

  private accept(value: unknown): void {
    const work = this.handleDispatch(value as StepDispatchEvent);
    this.running.add(work);
    void work.catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error(String(error));
    }).finally(() => this.running.delete(work));
  }

  private async handleDispatch(dispatch: StepDispatchEvent): Promise<void> {
    const spec = dispatch.spec as Partial<KernelAgentStep>;
    if (dispatch.step_type !== 'agent' || spec.type !== 'agent' || !spec.cli) {
      await this.complete(dispatch, 'worker_error', {
        error: 'agent dispatch does not declare a CLI',
      });
      return;
    }

    const result = await runCli(spec.cli, spec.instruction ?? '');
    await this.complete(
      dispatch,
      result.exitCode === 0 ? 'success' : 'worker_error',
      {
        exit_code: result.exitCode,
        stdout_tail: result.stdout,
        stderr_tail: result.stderr,
      },
    );
  }

  private async complete(
    dispatch: StepDispatchEvent,
    reason: 'success' | 'worker_error',
    output: unknown,
  ): Promise<void> {
    await this.client.stepComplete(
      dispatch.run_id,
      dispatch.step_id,
      dispatch.attempt,
      dispatch.idempotency_key,
      reason,
      { output, started_pins: dispatch.pins, end_pins: dispatch.pins },
    );
  }
}

function runCli(cli: string, instruction: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(cli, [instruction], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => resolve({ exitCode: null, stdout, stderr: error.message }));
    child.once('close', (code) => resolve({ exitCode: code, stdout, stderr }));
  });
}
