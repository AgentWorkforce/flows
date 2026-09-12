import { workerSpend } from './worker-spend.js';
import type { WorkerCliResult } from './worker-cli.js';
import { EventEmitter } from 'node:events';
import type { JournalClient } from './journal-client.js';
import type { Pins, StepDispatchEvent } from './protocol.js';
import type { KernelAgentStep } from './spec.js';
import { runAgentCli } from './worker-cli.js';
import { withWorkerLease } from './worker-lease.js';
import { workerInstruction } from './worker-input.js';
import { helperCall } from './yaml-helpers.js';
import { completeHelperDispatch } from './yaml-helper-effect.js';

export { MODEL_ENV, WAKE_CONTEXT_ENV } from './worker-cli.js';

export interface AgentWorkerOptions {
  workerId: string;
  pins: Pins;
  capacity?: number;
  dataDir?: string;
  onPtyReady?: (path: string) => void;
}

/**
 * Executes dispatched agent steps using their declared CLI.
 *
 * Shutdown contract (close): async and drain-aware. The caller may await
 * close() to guarantee every dispatch this worker started before close
 * was called has either completed its stepComplete journal write or
 * thrown out through the worker's `error` event. Dispatches that arrive
 * AFTER close begins are ignored. Idempotent.
 *
 * Not implemented: releasing the worker registration with the kernel.
 * `sdk/src/protocol.ts` has no `workerRelease` verb today, so on close()
 * the kernel keeps this workerId in its registry until its lease expires.
 * When workerRelease lands, add a client call at the top of close()
 * (before the drain) so the kernel stops routing dispatches during
 * shutdown.
 */
export class AgentWorker extends EventEmitter {
  private attached = false;
  private closing = false;
  private readonly inFlight: Set<Promise<void>> = new Set();

  constructor(
    private readonly client: JournalClient,
    private readonly options: AgentWorkerOptions,
  ) {
    super();
  }

  async attach(): Promise<void> {
    if (this.attached) throw new Error('agent worker: already attached');
    if (this.closing) throw new Error('agent worker: cannot attach a closed worker (construct a new one)');
    this.client.on('step.dispatch', this.onDispatch);
    try {
      await this.client.workerAttach(
        this.options.workerId,
        ['agent'],
        this.options.pins,
        this.options.capacity,
      );
      this.attached = true;
    } catch (error) {
      this.client.off('step.dispatch', this.onDispatch);
      throw error;
    }
  }

  /**
   * Async, drain-aware shutdown. Awaits every dispatch in-flight; ignores
   * dispatches that arrive after close() begins. Idempotent.
   *
   * A prior synchronous close() did NOT drain, so a caller shutting
   * mid-dispatch could silently lose an in-flight step's stepComplete
   * journal write when the socket was immediately shut. This closes
   * that hole.
   */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.client.off('step.dispatch', this.onDispatch);
    const pending = Array.from(this.inFlight);
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
    this.attached = false;
  }

  private readonly onDispatch = (dispatch: StepDispatchEvent): void => {
    if (this.closing) return;
    if (dispatch.step_type !== 'agent') return;
    const running: Promise<void> = this.execute(dispatch).catch((error: unknown) => {
      this.emit('error', error);
    });
    this.inFlight.add(running);
    void running.finally(() => { this.inFlight.delete(running); });
  };

  private async execute(dispatch: StepDispatchEvent): Promise<void> {
    const spec = dispatch.spec as Partial<KernelAgentStep>;
    const helper = helperCall(spec);
    if (helper !== undefined) {
      if (this.options.dataDir === undefined) throw new Error('Helper worker requires a data directory for durable receipts');
      await completeHelperDispatch(this.client, dispatch, helper, this.options.dataDir);
      return;
    }
    let humanIntervention = false;
    const completed: WorkerCliResult = await withWorkerLease(this.client, dispatch, signal =>
      typeof spec.cli === 'string' && typeof spec.instruction === 'string'
        ? runAgentCli(spec.cli, workerInstruction(spec.instruction, dispatch), dispatch.wake_context, spec.model, undefined, signal, 'agent', this.options.dataDir === undefined ? undefined : {
          dataDir: this.options.dataDir, runId: dispatch.run_id, stepId: dispatch.step_id,
          onReady: this.options.onPtyReady, onDrive: () => { humanIntervention = true; },
        }, typeof spec.cwd === 'string' ? spec.cwd : undefined,
          spec.transport === 'relay' ? 'relay' : 'direct',
          { runId: dispatch.run_id, stepId: dispatch.step_id })
        : Promise.resolve({ exit_code: null, stdout_tail: '', stderr_tail: 'agent step has no declared CLI' }));
    const { result, usage } = workerSpend(completed, spec.model);
    const completionReason = result.exit_code === 0 ? 'success' : 'worker_error';

    // Output shape: if the CLI's stdout parses as JSON, promote THAT
    // as the step's `output` value so `json_schema` verification
    // validates the analysis payload, not a wrapper around stdout.
    // On the JSON path the CliResult (exit_code / stdout_tail /
    // stderr_tail) is DISCARDED from `output` — the schema author
    // wrote a shape for the analysis, not for the process wrapper.
    // Non-JSON stdout falls back to the wrapper so text-emitting
    // tools still round-trip usefully.
    //
    // Implicit contract: CLIs signal errors via non-zero exit, not by
    // emitting an error JSON with exit 0. `completionReason` is
    // derived from exit code, so a CLI that exits 0 while emitting
    // `{"error":...}` will report success with an error payload.
    const output = parseJsonOutput(result.stdout_tail) ?? result;

    await this.client.stepComplete(
      dispatch.run_id,
      dispatch.step_id,
      dispatch.attempt,
      dispatch.idempotency_key,
      completionReason,
      {
        output,
        ...(humanIntervention ? { human_intervention: true } : {}),
        ...(usage !== undefined ? { usage } : {}),
        started_pins: dispatch.pins,
        end_pins: dispatch.pins,
      },
    );
  }
}

/**
 * Return an object-shaped JSON payload parsed from `stdout`, or
 * `null` when stdout is empty, non-JSON, or JSON-of-a-scalar/array.
 * The object-only restriction matches how `json_schema` gates are
 * authored — a scalar or array sneaking through would confuse both
 * the schema and downstream readers who expect field lookups on
 * `output`. Text-emitting tools and non-object JSON both fall
 * through to the CliResult wrapper preserved by the caller.
 */
export function parseJsonOutput(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (trimmed === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}
