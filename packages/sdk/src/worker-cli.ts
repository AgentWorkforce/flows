import { decodeProviderResult, decodeWrapperResult, requirePricedUsage } from './worker-usage.js';
import { openSidechannel, type SidechannelContext } from './pty-sidechannel.js';
import { spawn } from 'node:child_process';
import { childStop, ownsProcessGroup } from './child-stop.js';
import {
  agentExecution,
  llmExecution,
  cliAdapterKind,
  type CliInvocation,
} from './cli-adapter.js';
import {
  runWrapperSession,
  type WrapperSessionLimits,
} from './wrapper-session.js';
import { wrapperEnvironment } from './wrapper-runtime.js';

/** Present only when a dispatched agent step carries a journaled wake context. */
export const WAKE_CONTEXT_ENV = 'RELAYFLOW_WAKE_CONTEXT';

/**
 * Private wrapper model variable name. Ambient values are scrubbed; a wrapper
 * may set it inside the already-identified process from the session request.
 * Raw Claude/Codex adapters receive provider-native model flags.
 */
export const MODEL_ENV = 'RELAYFLOW_MODEL';

export interface WorkerCliResult {
  tokens_input?: number;
  tokens_output?: number;
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
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
): Promise<WorkerCliResult> {
  signal?.throwIfAborted();
  if (signal !== undefined && process.platform === 'win32') {
    throw new Error('Lease-bound agent execution requires macOS or Linux process-group cancellation; Windows is unsupported.');
  }
  const kind = cliAdapterKind(cli);

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
  return requirePricedUsage(decodeProviderResult(await spawnInvocation(cli, { ...invocation, args }, env, signal, sidechannel), kind), model);
}

async function spawnInvocation(
  cli: string,
  invocation: CliInvocation,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  sidechannel?: SidechannelContext,
): Promise<WorkerCliResult> {
  let writeInput: (bytes: Buffer) => boolean = () => false;
  const channel = sidechannel === undefined ? undefined : await openSidechannel(sidechannel, bytes => writeInput(bytes));
  if (signal?.aborted) { channel?.close(); signal.throwIfAborted(); }
  return new Promise((resolve) => {
    const ownsGroup = ownsProcessGroup(signal);
    const child = spawn(cli, invocation.args, {
      stdio: ['pipe', 'pipe', 'pipe'], env,
      detached: ownsGroup,
    });
    child.stdin.on('error', () => {});
    if (channel === undefined) child.stdin.end();
    writeInput = bytes => !child.stdin.destroyed && child.stdin.write(bytes);
    const stop = childStop(child, ownsGroup);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: WorkerCliResult): void => {
      if (settled) return;
      settled = true;
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
