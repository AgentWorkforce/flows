import { spawn } from 'node:child_process';
import {
  agentExecution,
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
): Promise<WorkerCliResult> {
  signal?.throwIfAborted();
  const kind = cliAdapterKind(cli);

  if (kind === 'relayflows-wrapper-v1') {
    return runWrapperSession(
      cli,
      instruction,
      wakeContext,
      model,
      wrapperEnvironment(process.env),
      wrapperLimits,
      signal,
    );
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[WAKE_CONTEXT_ENV];
  delete env[MODEL_ENV];
  const invocation = agentExecution(kind, instruction, model);

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
  return spawnInvocation(cli, invocation, env, signal);
}

function spawnInvocation(
  cli: string,
  invocation: CliInvocation,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<WorkerCliResult> {
  return new Promise((resolve) => {
    const child = spawn(cli, invocation.args, {
      stdio: ['ignore', 'pipe', 'pipe'], env,
      detached: signal !== undefined && process.platform !== 'win32',
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: WorkerCliResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => {
      if (child.pid !== undefined && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else child.kill('SIGKILL');
      finish({ exit_code: null, stdout_tail: '', stderr_tail: 'Agent execution aborted: lease ownership lost.' });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => finish({
      exit_code: null,
      stdout_tail: Buffer.concat(stdout).toString('utf8'),
      stderr_tail: error.message,
    }));
    child.once('close', (code) => finish({
      exit_code: code,
      stdout_tail: Buffer.concat(stdout).toString('utf8'),
      stderr_tail: Buffer.concat(stderr).toString('utf8'),
    }));
    if (invocation.timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish({
          exit_code: null,
          stdout_tail: Buffer.concat(stdout).toString('utf8'),
          stderr_tail: `CLI invocation timed out after ${invocation.timeoutMs}ms.`,
        });
      }, invocation.timeoutMs);
    }
  });
}
