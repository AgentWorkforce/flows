import { spawn } from 'node:child_process';
import {
  adapterIdentification,
  agentExecution,
  cliAdapterKind,
  WRAPPER_IDENTIFY_TOKEN,
  type CliInvocation,
} from './cli-adapter.js';

/** Present only when a dispatched agent step carries a journaled wake context. */
export const WAKE_CONTEXT_ENV = 'RELAYFLOW_WAKE_CONTEXT';

/**
 * Present only for a declared model sent to a currently identified custom
 * wrapper. Raw Claude/Codex adapters receive provider-native model flags.
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
): Promise<WorkerCliResult> {
  const kind = cliAdapterKind(cli);
  const invocation = agentExecution(kind, instruction, model);
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[WAKE_CONTEXT_ENV];
  delete env[MODEL_ENV];

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

  if (kind === 'relayflows-wrapper-v1') {
    const identity = adapterIdentification(kind);
    const identityEnv = { ...env };
    delete identityEnv[WAKE_CONTEXT_ENV];
    const identified = await spawnInvocation(cli, identity.invocation, identityEnv);
    if (
      identified.exit_code !== 0
      || identified.stdout_tail.trim() !== identity.expectedStdout
    ) {
      return {
        exit_code: null,
        stdout_tail: '',
        stderr_tail: `CLI "${cli}" did not identify as ${WRAPPER_IDENTIFY_TOKEN} at worker execution.`,
      };
    }
  }

  if (invocation.modelEnv !== undefined) env[MODEL_ENV] = invocation.modelEnv;
  return spawnInvocation(cli, invocation, env);
}

function spawnInvocation(
  cli: string,
  invocation: CliInvocation,
  env: NodeJS.ProcessEnv,
): Promise<WorkerCliResult> {
  return new Promise((resolve) => {
    const child = spawn(cli, invocation.args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: WorkerCliResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
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
