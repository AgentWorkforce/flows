import { EventEmitter } from 'node:events';
import type { JournalClient } from './journal-client.js';
import type { Pins, StepDispatchEvent } from './protocol.js';
import type { KernelAgentStep } from './spec.js';
import { runAgentCli } from './worker-cli.js';

export { MODEL_ENV, WAKE_CONTEXT_ENV } from './worker-cli.js';

export interface AgentWorkerOptions {
  workerId: string;
  pins: Pins;
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
      await this.client.workerAttach(this.options.workerId, ['agent'], this.options.pins);
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
    const result = typeof spec.cli === 'string' && typeof spec.instruction === 'string'
      ? await runAgentCli(spec.cli, spec.instruction, dispatch.wake_context, spec.model)
      : { exit_code: null, stdout_tail: '', stderr_tail: 'agent step has no declared CLI' };
    const completionReason = result.exit_code === 0 ? 'success' : 'worker_error';

    // Structured providers expose a final message separately from their
    // trajectory. Promote JSON in that message so json_schema gates judge the
    // agent's answer, never the CLI's event envelope. A provider parser
    // rejects a zero-exit stream without a final message before this point.
    // Custom wrappers retain their established raw-stdout behavior.
    const agentText = result.headless?.finalText ?? result.stdout_tail;
    const output = parseJsonOutput(agentText) ?? (result.headless === undefined ? result : agentText);

    await this.client.stepComplete(
      dispatch.run_id,
      dispatch.step_id,
      dispatch.attempt,
      dispatch.idempotency_key,
      completionReason,
      {
        output,
        ...(result.headless?.usage === undefined ? {} : { usage: result.headless.usage }),
        ...(result.headless === undefined ? {} : {
          trajectory_tail: {
            events: result.headless.trajectory,
            ...(result.headless.sessionId === undefined ? {} : { sessionId: result.headless.sessionId }),
            ...(result.headless.subagents === undefined ? {} : { subagents: result.headless.subagents }),
          },
        }),
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
