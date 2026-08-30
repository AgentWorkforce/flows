import { spawn } from 'node:child_process';
import type { JournalClient } from './journal-client.js';
import type { Pins, StepDispatchEvent } from './protocol.js';

export interface AgentWorkerOptions {
  workerId: string;
  pins: Pins;
}

interface AgentDispatchSpec {
  type: 'agent';
  cli: string;
  instruction: string;
}

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Minimal SDK-side executor for kernel-dispatched agent steps. */
export class AgentWorker {
  private attached = false;

  constructor(
    private readonly client: JournalClient,
    private readonly options: AgentWorkerOptions,
  ) {}

  async attach(): Promise<void> {
    if (this.attached) throw new Error('agent worker is already attached');
    this.client.on('step.dispatch', this.onDispatch);
    try {
      await this.client.workerAttach(this.options.workerId, ['agent'], this.options.pins);
      this.attached = true;
    } catch (error) {
      this.client.off('step.dispatch', this.onDispatch);
      throw error;
    }
  }

  detach(): void {
    this.client.off('step.dispatch', this.onDispatch);
    this.attached = false;
  }

  private readonly onDispatch = (dispatch: StepDispatchEvent): void => {
    if (dispatch.step_type !== 'agent') return;
    void this.execute(dispatch).catch((error: unknown) => {
      queueMicrotask(() => { throw error; });
    });
  };

  private async execute(dispatch: StepDispatchEvent): Promise<void> {
    const spec = agentSpec(dispatch.spec);
    if (spec === null) {
      await this.complete(dispatch, 'worker_error', {
        error: 'agent dispatch spec must include string cli and instruction fields',
      });
      return;
    }

    const result = await runCli(spec.cli, spec.instruction);
    const output = {
      exit_code: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
    await this.complete(
      dispatch,
      result.exitCode === 0 ? 'success' : 'worker_error',
      output,
    );
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
}

function agentSpec(value: unknown): AgentDispatchSpec | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const spec = value as Record<string, unknown>;
  return spec['type'] === 'agent'
    && typeof spec['cli'] === 'string'
    && typeof spec['instruction'] === 'string'
    ? { type: 'agent', cli: spec['cli'], instruction: spec['instruction'] }
    : null;
}

function runCli(cli: string, instruction: string): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(cli, [instruction], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => resolve({
      exitCode: null,
      signal: null,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      error: error.message,
    }));
    child.once('exit', (exitCode, signal) => resolve({
      exitCode,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}
