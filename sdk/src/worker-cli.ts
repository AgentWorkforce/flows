import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentExecution,
  cliAdapterKind,
  HEADLESS_PROMPT_FILE,
  type CliInvocation,
} from './cli-adapter.js';
import { parseHeadlessOutput, type HeadlessResult } from './headless-adapter.js';
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
  /** Present only for supported raw provider CLIs with a validated final event. */
  headless?: HeadlessResult;
}

export async function runAgentCli(
  cli: string,
  instruction: string,
  wakeContext: unknown,
  model?: string,
  wrapperLimits?: Partial<WrapperSessionLimits>,
): Promise<WorkerCliResult> {
  const kind = cliAdapterKind(cli);

  if (kind === 'relayflows-wrapper-v1') {
    return runWrapperSession(
      cli,
      instruction,
      wakeContext,
      model,
      wrapperEnvironment(process.env),
      wrapperLimits,
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
  const raw = await spawnWithPromptFile(cli, invocation, env);
  if (raw.exit_code !== 0) return raw;
  try {
    return { ...raw, headless: parseHeadlessOutput(kind, raw.stdout_tail) };
  } catch (error) {
    return {
      exit_code: null,
      stdout_tail: raw.stdout_tail,
      stderr_tail: `${raw.stderr_tail}${raw.stderr_tail === '' ? '' : '\n'}headless adapter: ${String(error)}`,
    };
  }
}

function spawnInvocation(
  cli: string,
  invocation: CliInvocation,
  env: NodeJS.ProcessEnv,
): Promise<WorkerCliResult> {
  return new Promise((resolve) => {
    const child = spawn(cli, invocation.args, { stdio: ['pipe', 'pipe', 'pipe'], env });
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
    child.stdin.end(invocation.stdin);
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

/** Writes Grok's private prompt file only for the lifetime of its child. */
async function spawnWithPromptFile(
  cli: string,
  invocation: CliInvocation,
  env: NodeJS.ProcessEnv,
): Promise<WorkerCliResult> {
  if (invocation.promptFile === undefined) return spawnInvocation(cli, invocation, env);
  const directory = await mkdtemp(join(tmpdir(), 'relayflows-agent-prompt-'));
  const path = join(directory, 'prompt');
  try {
    await writeFile(path, invocation.promptFile, { mode: 0o600 });
    return await spawnInvocation(cli, {
      ...invocation,
      args: invocation.args.map((arg, index) => (
        invocation.args[index - 1] === '--prompt-file' && arg === HEADLESS_PROMPT_FILE ? path : arg
      )),
    }, env);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
