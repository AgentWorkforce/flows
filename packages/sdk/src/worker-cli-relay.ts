import { redactRelayError } from './redact.js';
import {
  runAgentRelayTask,
  AgentRelayTransportError,
} from './agent-relay-transport.js';
import type { CliAdapterKind } from './cli-adapter.js';
import { requirePricedUsage } from './worker-usage.js';
import type { WorkerCliResult } from './worker-cli.js';

/** Journal identity and durable dispatch storage used by the Relay task transport. */
export interface AgentRelayContext {
  runId: string;
  stepId: string;
  idempotencyKey: string;
  dataDir?: string;
  resultSchema?: unknown;
}

/** Wait under the same worker lease for an authoritative task receipt. */
export async function runViaAgentRelay(
  kind: CliAdapterKind, instruction: string, wakeContext: unknown,
  model: string | undefined, context: AgentRelayContext | undefined,
  worker_cwd: string | undefined, signal: AbortSignal | undefined,
): Promise<WorkerCliResult> {
  try {
    if (kind === 'relayflows-wrapper-v1') throw new Error('Relay task transport does not support same-process wrappers.');
    if (!context?.dataDir) throw new Error('Relay task transport requires a durable data directory and journal dispatch identity.');
    const task = instruction + (wakeContext === undefined ? '' : `\n\nWake context (journaled):\n${JSON.stringify(wakeContext)}`)
      + '\n\nReport the final task output with the injected agent_result tool and final=true. Wait for its successful durable acknowledgment before exiting.';
    const received = await runAgentRelayTask({
      cli: kind, task, model, worker_cwd, result_schema: context.resultSchema,
      runId: context.runId, stepId: context.stepId, idempotencyKey: context.idempotencyKey,
      dataDir: context.dataDir,
    }, { signal });
    const receipt = { ...received, error: received.error === null ? null : redactRelayError(received.error) };
    const accounting = receipt.task_execution.accounting;
    const result: WorkerCliResult = {
      relay_task: receipt, exit_code: receipt.status === 'completed' ? 0 : 1,
      stdout_tail: receipt.status === 'completed' ? JSON.stringify(receipt.output) : '',
      stderr_tail: receipt.status === 'failed' ? `Relay task failed: ${receipt.error}` : '',
      ...(accounting?.tokens_input === undefined ? {} : { tokens_input: accounting.tokens_input }),
      ...(accounting?.tokens_output === undefined ? {} : { tokens_output: accounting.tokens_output }),
    };
    return requirePricedUsage(result, model);
  } catch (error) {
    signal?.throwIfAborted();
    const detail = error instanceof AgentRelayTransportError ? error.message
      : error instanceof Error ? error.message : 'Relay task transport failed';
    return { exit_code: null, stdout_tail: '', stderr_tail: redactRelayError(detail) };
  }
}
