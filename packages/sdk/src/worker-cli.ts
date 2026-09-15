import { decodeProviderResult, decodeWrapperResult, requirePricedUsage } from './worker-usage.js';
import { openSidechannel, type SidechannelContext } from './pty-sidechannel.js';
import { spawn } from 'node:child_process';
import { childStop, ownsProcessGroup } from './child-stop.js';
import {
  agentExecution,
  llmExecution,
  cliAdapterKind,
  type CliInvocation,
  type CliAdapterKind,
} from './cli-adapter.js';
import {
  runWrapperSession,
  type WrapperSessionLimits,
} from './wrapper-session.js';
import { wrapperEnvironment } from './wrapper-runtime.js';
import {
  runAgentRelayTask,
  AgentRelayTransportError,
  type AgentTransport,
} from './agent-relay-transport.js';

/** Present only when a dispatched agent step carries a journaled wake context. */
export const WAKE_CONTEXT_ENV = 'RELAYFLOW_WAKE_CONTEXT';

/**
 * Private wrapper model variable name. Ambient values are scrubbed; a wrapper
 * may set it inside the already-identified process from the session request.
 * Raw Claude/Codex adapters receive provider-native model flags.
 */
export const MODEL_ENV = 'RELAYFLOW_MODEL';

export interface WorkerCliResult {
  relay_task?: import('./agent-relay-receipt.js').RelayTaskReceipt;
  tokens_input?: number;
  tokens_output?: number;
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
}

/**
 * Journal identity and durable dispatch storage used by the Relay task transport.
 */
export interface AgentRelayContext {
  runId: string;
  stepId: string;
  idempotencyKey: string;
  dataDir?: string;
  resultSchema?: unknown;
}

export async function runAgentCli(
  cli: string,
  instruction: string,
  wakeContext: unknown,
  model?: string,
  wrapperLimits?: Partial<WrapperSessionLimits>,
  signal?: AbortSignal,
  mode: 'agent' | 'llm' = 'agent',
  sidechannel?: SidechannelContext,
  cwd?: string,
  transport: AgentTransport = 'direct',
  relayContext?: AgentRelayContext,
): Promise<WorkerCliResult> {
  signal?.throwIfAborted();
  if (signal !== undefined && process.platform === 'win32') {
    throw new Error('Lease-bound agent execution requires macOS or Linux process-group cancellation; Windows is unsupported.');
  }
  const kind = cliAdapterKind(cli);

  if (mode === 'agent' && transport === 'relay') {
    return runViaAgentRelay(kind, instruction, wakeContext, model, relayContext, cwd, signal);
  }

  if (kind === 'relayflows-wrapper-v1') {
    return requirePricedUsage(decodeWrapperResult(await runWrapperSession(
      cli,
      instruction,
      wakeContext,
      model,
      wrapperEnvironment(process.env),
      wrapperLimits,
      signal,
    )), model);
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[WAKE_CONTEXT_ENV];
  delete env[MODEL_ENV];
  const invocation = mode === 'llm' ? llmExecution(kind, instruction, model) : agentExecution(kind, instruction, model);

  if (wakeContext !== undefined) {
    try {
      env[WAKE_CONTEXT_ENV] = JSON.stringify(wakeContext);
    } catch (error) {
      return {
        exit_code: null,
        stdout_tail: '',
        stderr_tail: `wake_context could not be JSON-serialized for the CLI: ${String(error)}`,
      };
    }
  }

  if (invocation.modelEnv !== undefined) env[MODEL_ENV] = invocation.modelEnv;
  // Structured provider output carries the authoritative token counts.
  const args = [...invocation.args];
  args.splice(args.length - 1, 0, ...(kind === 'claude' ? ['--output-format', 'json'] : ['--json']));
  return requirePricedUsage(decodeProviderResult(await spawnInvocation(cli, { ...invocation, args }, env, signal, sidechannel, cwd), kind), model);
}

/** Wait under the same worker lease for an authoritative task receipt. */
async function runViaAgentRelay(
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

function redactRelayError(message: string): string {
  for (const key of ['RELAY_AGENT_TOKEN', 'RELAY_API_KEY']) {
    const secret = process.env[key];
    if (secret) message = message.replaceAll(secret, '[redacted]');
  }
  return message.replace(/\b(?:at|rk|nt|ot|br|arr)_(?:live_)?[A-Za-z0-9_-]+/g, '[redacted]');
}

async function spawnInvocation(
  cli: string,
  invocation: CliInvocation,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  sidechannel?: SidechannelContext,
  cwd?: string,
): Promise<WorkerCliResult> {
  let writeInput: (bytes: Buffer) => Promise<boolean> = async () => false;
  let canDrive = () => false;
  let driven = false;
  const channel = sidechannel === undefined ? undefined : await openSidechannel({
    ...sidechannel,
    onDrive() { driven = true; sidechannel.onDrive(); },
  }, bytes => writeInput(bytes), () => canDrive());
  if (signal?.aborted) { channel?.close(); signal.throwIfAborted(); }
  return new Promise((resolve) => {
    const ownsGroup = ownsProcessGroup(signal);
    const child = spawn(cli, invocation.args, {
      stdio: ['pipe', 'pipe', 'pipe'], env,
      detached: ownsGroup,
      ...(cwd === undefined ? {} : { cwd }),
    });
    child.stdin.on('error', () => {});
    if (channel === undefined) child.stdin.end();
    canDrive = () => !child.stdin.destroyed && !child.stdin.writableEnded;
    // A pipe cannot be reopened after EOF. Give startup subscribers a bounded
    // chance to opt into drive, then let unattended/view-only CLIs read EOF.
    const inputTimer = channel === undefined ? undefined : setTimeout(() => {
      if (!driven) child.stdin.end();
    }, 100);
    writeInput = bytes => new Promise(resolve => {
      if (!canDrive()) { resolve(false); return; }
      // write(false) still accepts the bytes. The completion callback waits
      // until they flush; the sidechannel pauses its reader in the meantime.
      child.stdin.write(bytes, error => resolve(!error));
    });
    const stop = childStop(child, ownsGroup);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: WorkerCliResult): void => {
      if (settled) return;
      settled = true;
      if (inputTimer !== undefined) clearTimeout(inputTimer);
      channel?.close();
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => {
      stop.kill();
      finish({ exit_code: null, stdout_tail: '', stderr_tail: 'Agent execution aborted: lease ownership lost.' });
    };
    /**
     * Same invariant as `wrapper-session.ts`: `'close'` and `'error'` are
     * evidence about the DIRECT CHILD, so they may not settle over a pending
     * escalation, and only `maySettleOnChildExit` may drop one. This settle
     * carries no deadline of its own because it needs none — the timeout below
     * settles on the spot and lets its escalation outlive that, so refusing
     * here can only defer to a `'close'` we are still going to get.
     */
    const finishOnChildExit = (result: WorkerCliResult): void => {
      if (!stop.maySettleOnChildExit()) return;
      finish(result);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk); channel?.publish(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk); channel?.publish(chunk); });
    child.once('error', (error) => finishOnChildExit({
      exit_code: null,
      stdout_tail: Buffer.concat(stdout).toString('utf8'),
      stderr_tail: error.message,
    }));
    child.once('close', (code) => finishOnChildExit({
      exit_code: code,
      stdout_tail: Buffer.concat(stdout).toString('utf8'),
      stderr_tail: Buffer.concat(stderr).toString('utf8'),
    }));
    if (invocation.timeoutMs > 0) {
      timer = setTimeout(() => {
        // The stop outlives this settle on purpose: `finish` resolves the step,
        // but only the forced group kill releases the pipes a leaked descendant
        // is holding, and until they are released `flows run` cannot exit.
        stop.terminate();
        finish({
          exit_code: null,
          stdout_tail: Buffer.concat(stdout).toString('utf8'),
          stderr_tail: `CLI invocation timed out after ${invocation.timeoutMs}ms.`,
        });
      }, invocation.timeoutMs);
    }
  });
}
