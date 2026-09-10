import { EventEmitter } from 'node:events';
import type { JournalClient } from './journal-client.js';
import type { CompletionReason, StepDispatchEvent } from './protocol.js';
import type { KernelLlmStep } from './spec.js';
import { runAgentCli } from './worker-cli.js';
import { withWorkerLease } from './worker-lease.js';
import { workerInstruction } from './worker-input.js';
import { jsonSchemaOutputError } from './json-schema.js';

/** Bare value-producing LLM dispatch, without agent workspace/recovery pins. */
export class LlmWorker extends EventEmitter {
  private attached = false;
  private closing = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly client: JournalClient, private readonly workerId: string) {
    super();
  }

  async attach(): Promise<void> {
    if (this.attached || this.closing) throw new Error('llm worker: cannot attach twice or after close');
    this.client.on('step.dispatch', this.onDispatch);
    try {
      await this.client.workerAttach(this.workerId, ['llm'], { workspace: [], streams: [] }, 1);
      this.attached = true;
    } catch (error) {
      this.client.off('step.dispatch', this.onDispatch);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.client.off('step.dispatch', this.onDispatch);
    await Promise.allSettled([...this.inFlight]);
  }

  private readonly onDispatch = (dispatch: StepDispatchEvent): void => {
    if (this.closing || dispatch.step_type !== 'llm') return;
    const running = this.execute(dispatch).catch(error => { this.emit('error', error); });
    this.inFlight.add(running);
    void running.finally(() => { this.inFlight.delete(running); });
  };

  private async execute(dispatch: StepDispatchEvent): Promise<void> {
    const spec = dispatch.spec as KernelLlmStep;
    const schema = spec.verification?.json_schema;
    const prompt = schema === undefined ? spec.prompt
      : `${spec.prompt}\n\nReturn only a JSON value matching this JSON Schema (no Markdown fences):\n${JSON.stringify(schema)}`;
    const result = await withWorkerLease(this.client, dispatch, signal =>
      typeof spec.cli === 'string' && typeof spec.prompt === 'string'
        ? runAgentCli(spec.cli, workerInstruction(prompt, dispatch), dispatch.wake_context, spec.model, undefined, signal, 'llm')
        : Promise.resolve({ exit_code: null, stdout_tail: '', stderr_tail: 'llm step has no declared CLI' }));
    let reason: CompletionReason = result.exit_code === 0 ? 'success' : 'worker_error';
    let output: unknown = result.stdout_tail;
    let detail = result.stderr_tail;
    if (reason === 'success' && schema !== undefined) {
      try {
        output = JSON.parse(result.stdout_tail);
        const invalid = jsonSchemaOutputError(schema, output);
        if (invalid !== undefined) {
          reason = 'verification_failed';
          detail = `LLM output does not match its declared schema: ${invalid}`;
        }
      } catch {
        reason = 'verification_failed';
        detail = 'LLM output is not valid JSON.';
      }
    }
    // Never submit schema-invalid JSON as a successful completion. The kernel
    // also runs its own gate before making output available to dependents.
    await this.client.stepComplete(dispatch.run_id, dispatch.step_id, dispatch.attempt,
      dispatch.idempotency_key, reason, {
        output,
        ...(reason === 'success' ? {} : { trajectory_tail: { error: detail } }),
      });
  }
}
