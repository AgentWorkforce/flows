import { spawn } from 'node:child_process';
import {
  agentExecution,
  cliAdapterKind,
  WRAPPER_EXECUTE_TOKEN,
  WRAPPER_IDENTIFY_ARG,
  WRAPPER_IDENTIFY_TOKEN,
  type CliInvocation,
} from './cli-adapter.js';

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
): Promise<WorkerCliResult> {
  const kind = cliAdapterKind(cli);
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[WAKE_CONTEXT_ENV];
  delete env[MODEL_ENV];

  if (kind === 'relayflows-wrapper-v1') {
    return runWrapperSession(cli, instruction, wakeContext, model, env);
  }

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
  return spawnInvocation(cli, invocation, env);
}

/**
 * Custom wrappers identify and execute within one child process. Private
 * values are withheld from argv/env and sent over stdin only after that exact
 * process emits the identity token. A second acknowledgement proves it parsed
 * the request; both protocol lines are removed from the agent output.
 */
function runWrapperSession(
  cli: string,
  instruction: string,
  wakeContext: unknown,
  model: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<WorkerCliResult> {
  let request: string;
  try {
    request = JSON.stringify({
      protocol: WRAPPER_IDENTIFY_TOKEN,
      instruction,
      ...(model !== undefined ? { model } : {}),
      ...(wakeContext !== undefined ? { wakeContext } : {}),
    });
  } catch (error) {
    return Promise.resolve({
      exit_code: null,
      stdout_tail: '',
      stderr_tail: `wake_context could not be JSON-serialized for the CLI: ${String(error)}`,
    });
  }

  return new Promise((resolve) => {
    const child = spawn(cli, [WRAPPER_IDENTIFY_ARG], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    const output: string[] = [];
    const stderr: Buffer[] = [];
    let pending = '';
    let phase: 'identity' | 'ack' | 'execute' = 'identity';
    let protocolError: string | undefined;
    let settled = false;
    const timer = setTimeout(() => {
      protocolError = `CLI "${cli}" did not identify as ${WRAPPER_IDENTIFY_TOKEN} within 10000ms.`;
      child.kill('SIGTERM');
    }, 10_000);

    const finish = (result: WorkerCliResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const failProtocol = (message: string): void => {
      if (protocolError !== undefined) return;
      protocolError = message;
      child.kill('SIGTERM');
    };
    const handshakeComplete = (): boolean => phase === 'execute';
    const acceptLine = (line: string): void => {
      const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (phase === 'identity') {
        if (normalized !== WRAPPER_IDENTIFY_TOKEN) {
          failProtocol(`CLI "${cli}" did not identify as ${WRAPPER_IDENTIFY_TOKEN} at worker execution.`);
          return;
        }
        phase = 'ack';
        child.stdin.end(`${request}\n`);
        return;
      }
      if (phase === 'ack') {
        if (normalized !== WRAPPER_EXECUTE_TOKEN) {
          failProtocol(`CLI "${cli}" did not accept the ${WRAPPER_IDENTIFY_TOKEN} same-process execution request.`);
          return;
        }
        phase = 'execute';
        clearTimeout(timer);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (phase === 'execute') {
        output.push(chunk);
        return;
      }
      pending += chunk;
      if (pending.length > 8_192) {
        failProtocol(`CLI "${cli}" exceeded the wrapper handshake limit.`);
        return;
      }
      while (!handshakeComplete()) {
        const newline = pending.indexOf('\n');
        if (newline < 0) return;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        acceptLine(line);
        if (protocolError !== undefined) return;
      }
      if (pending.length > 0) {
        output.push(pending);
        pending = '';
      }
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on('error', () => {
      // A child that exits before acknowledging is classified on close.
    });
    child.once('error', (error) => finish({
      exit_code: null,
      stdout_tail: '',
      stderr_tail: error.message,
    }));
    child.once('close', (code) => {
      if (protocolError !== undefined || phase !== 'execute') {
        finish({
          exit_code: null,
          stdout_tail: '',
          stderr_tail: protocolError
            ?? `CLI "${cli}" exited before completing the ${WRAPPER_IDENTIFY_TOKEN} same-process handshake.`,
        });
        return;
      }
      finish({
        exit_code: code,
        stdout_tail: output.join(''),
        stderr_tail: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
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
