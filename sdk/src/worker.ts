import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { JournalClient } from './journal-client.js';
import type { Pins, StepDispatchEvent } from './protocol.js';
import type { KernelAgentStep } from './spec.js';
import { agentExecution, cliAdapterKind } from './cli-adapter.js';

export interface AgentWorkerOptions {
  workerId: string;
  pins: Pins;
}

interface CliResult {
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
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
      ? await runCli(spec.cli, spec.instruction, dispatch.wake_context, spec.model)
      : { exit_code: null, stdout_tail: '', stderr_tail: 'agent step has no declared CLI' };
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

/**
 * Environment variable name AgentWorker sets when dispatching an
 * agent step whose kernel dispatch carried a `wake_context` (the
 * payload assembled at subscription.matched, containing the
 * triggering event). A real analyzer reads this to see which HN
 * story / webhook / trigger woke it — an env var is a stable,
 * language-agnostic surface that works with any CLI shape, without
 * changing the `spawn(cli, [instruction])` argv contract every
 * existing agent CLI already depends on.
 *
 * Not set when `wake_context` is absent (e.g. a directly-started
 * run, no trigger fired) — the variable simply won't exist. That is
 * DELIBERATE, so a CLI that reads `RELAYFLOW_WAKE_CONTEXT` can
 * distinguish "no wake context available" from "wake context = null".
 */
export const WAKE_CONTEXT_ENV = 'RELAYFLOW_WAKE_CONTEXT';

/**
 * Environment variable AgentWorker sets when the dispatched agent step
 * DECLARED a `model`. Same contract as {@link WAKE_CONTEXT_ENV}: when the
 * wrapper step declares no model the variable is not merely empty, it is ABSENT,
 * so a CLI can tell "the flow author chose nothing" from "the flow author
 * chose something". Raw Claude/Codex adapters use their real model flags
 * instead; only an explicitly identified Relayflows wrapper receives this
 * private environment contract.
 *
 * This exists because a CLI inheriting whatever model the host happens to
 * pin produces two failures: runs whose model cannot be recovered from the
 * journal, and hard failure on a host pinning an alias the CLI cannot
 * resolve. Declaring it on the step makes the choice portable and recorded.
 */
export const MODEL_ENV = 'RELAYFLOW_MODEL';

function runCli(
  cli: string,
  instruction: string,
  wakeContext: unknown,
  model?: string,
): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const invocation = agentExecution(cliAdapterKind(cli), instruction, model);
    // Explicit unset. Without this, a parent process (wrapper
    // script, systemd unit, docker env, or a prior test) that
    // already had RELAYFLOW_WAKE_CONTEXT set would leak into
    // this subprocess even on a run with no wake context — which
    // would defeat the WAKE_CONTEXT_ENV doc guarantee that CLIs
    // can key on absence to distinguish "no wake context
    // available" from "wake context = null". Unset first, then
    // set only if we have context. Deleting a key from
    // ProcessEnv drops it from the child's environ; a subsequent
    // conditional assign is the source of truth.
    delete env[WAKE_CONTEXT_ENV];
    // Same explicit-unset reasoning as WAKE_CONTEXT_ENV below: an inherited
    // RELAYFLOW_MODEL from a parent process would make a step that declared
    // no model look like one that did, silently pinning the run to whatever
    // the launching shell happened to export.
    delete env[MODEL_ENV];
    if (invocation.modelEnv !== undefined) env[MODEL_ENV] = invocation.modelEnv;
    if (wakeContext !== undefined) {
      // `execve` caps argv + envp at ARG_MAX (macOS ~256 KB, Linux
      // ~2 MB). A wake_context that packs a rich payload could
      // exceed that and make spawn fail with an opaque E2BIG.
      // Truncation would be worse than a loud failure — the CLI
      // needs the intact context to analyze the event correctly —
      // so we let spawn's error surface naturally.
      //
      // `JSON.stringify` can throw synchronously (on a cycle or a
      // non-serializable value like BigInt). Values that arrived
      // through the wire protocol are already JSON-clean by
      // construction, but this worker also runs inside test rigs
      // and future callers may construct `wake_context` in-process.
      // Catching the throw here converts a would-be silent
      // lease-expiration (Promise executor throw → no `resolve`,
      // no stepComplete written) into a clean `worker_error`
      // completion the kernel journals normally. Fail-closed per
      // AGENTS.md.
      try {
        env[WAKE_CONTEXT_ENV] = JSON.stringify(wakeContext);
      } catch (error) {
        resolve({
          exit_code: null,
          stdout_tail: '',
          stderr_tail: `wake_context could not be JSON-serialized for the CLI: ${String(error)}`,
        });
        return;
      }
    }
    const child = spawn(cli, invocation.args, { stdio: ['ignore', 'pipe', 'pipe'], env });
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
