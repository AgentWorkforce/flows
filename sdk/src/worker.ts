import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { JournalClient } from './journal-client.js';
import type { Pins, StepDispatchEvent } from './protocol.js';
import type { KernelAgentStep } from './spec.js';

export interface AgentWorkerOptions {
  workerId: string;
  pins: Pins;
}

interface CliResult {
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
}

/** Executes dispatched agent steps using their declared CLI. */
export class AgentWorker extends EventEmitter {
  private attached = false;

  constructor(
    private readonly client: JournalClient,
    private readonly options: AgentWorkerOptions,
  ) {
    super();
  }

  async attach(): Promise<void> {
    if (this.attached) throw new Error('agent worker: already attached');
    this.client.on('step.dispatch', this.onDispatch);
    try {
      await this.client.workerAttach(this.options.workerId, ['agent'], this.options.pins);
      this.attached = true;
    } catch (error) {
      this.client.off('step.dispatch', this.onDispatch);
      throw error;
    }
  }

  close(): void {
    // Protocol v0 has no worker release verb; close only detaches dispatch handling.
    this.client.off('step.dispatch', this.onDispatch);
    this.attached = false;
  }

  private readonly onDispatch = (dispatch: StepDispatchEvent): void => {
    if (dispatch.step_type !== 'agent') return;
    void this.execute(dispatch).catch((error: unknown) => this.emit('error', error));
  };

  private async execute(dispatch: StepDispatchEvent): Promise<void> {
    const spec = dispatch.spec as Partial<KernelAgentStep>;
    const result = typeof spec.cli === 'string' && typeof spec.instruction === 'string'
      ? await runCli(spec.cli, spec.instruction)
      : { exit_code: null, stdout_tail: '', stderr_tail: 'agent step has no declared CLI' };
    const completionReason = result.exit_code === 0 ? 'success' : 'worker_error';

    await this.client.stepComplete(
      dispatch.run_id,
      dispatch.step_id,
      dispatch.attempt,
      dispatch.idempotency_key,
      completionReason,
      {
        output: result,
        started_pins: dispatch.pins,
        end_pins: dispatch.pins,
      },
    );
  }
}

function runCli(cli: string, instruction: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(cli, [instruction], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => resolve({
      exit_code: null,
      stdout_tail: Buffer.concat(stdout).toString('utf8'),
      stderr_tail: error.message,
    }));
    child.once('close', (code) => resolve({
      exit_code: code,
      stdout_tail: Buffer.concat(stdout).toString('utf8'),
      stderr_tail: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}
