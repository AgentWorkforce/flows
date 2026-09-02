import { spawn } from 'node:child_process';
import {
  WRAPPER_EXECUTE_TOKEN,
  WRAPPER_IDENTIFY_ARG,
  WRAPPER_IDENTIFY_TOKEN,
} from './cli-adapter.js';
import {
  captureWrapperIdentity,
  sameWrapperIdentity,
  type WrapperIdentity,
} from './wrapper-runtime.js';

export interface WrapperSessionLimits {
  handshakeTimeoutMs: number;
  executionTimeoutMs: number;
  maxOutputBytes: number;
}

export interface WrapperSessionResult {
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
}

const DEFAULT_LIMITS: WrapperSessionLimits = {
  handshakeTimeoutMs: 10_000,
  executionTimeoutMs: 300_000,
  maxOutputBytes: 1_048_576,
};
const HANDSHAKE_OUTPUT_LIMIT = 8_192;
const FORCE_KILL_DELAY_MS = 1_000;

/**
 * Identify and execute a custom wrapper in one pinned process. No private
 * request is written until its declared path still names the captured file.
 */
export function runWrapperSession(
  cli: string,
  instruction: string,
  wakeContext: unknown,
  model: string | undefined,
  env: NodeJS.ProcessEnv,
  overrides: Partial<WrapperSessionLimits> = {},
): Promise<WrapperSessionResult> {
  const limits = sessionLimits(overrides);
  let request: string;
  try {
    request = JSON.stringify({
      protocol: WRAPPER_IDENTIFY_TOKEN,
      instruction,
      ...(model !== undefined ? { model } : {}),
      ...(wakeContext !== undefined ? { wakeContext } : {}),
    });
  } catch (error) {
    return Promise.resolve(failure(
      `wake_context could not be JSON-serialized for the CLI: ${String(error)}`,
    ));
  }
  let identity: WrapperIdentity;
  try {
    identity = captureWrapperIdentity(cli, env);
  } catch (error) {
    return Promise.resolve(failure(
      `CLI ${JSON.stringify(cli)} wrapper identity could not be pinned: ${String(error)}`,
    ));
  }

  return executePinnedWrapper(cli, identity, request, env, limits);
}

function executePinnedWrapper(
  cli: string,
  identity: WrapperIdentity,
  request: string,
  env: NodeJS.ProcessEnv,
  limits: WrapperSessionLimits,
): Promise<WrapperSessionResult> {
  return new Promise((resolve) => {
    const child = spawn(identity.executable, [WRAPPER_IDENTIFY_ARG], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    const stdout: string[] = [];
    const stderr: Buffer[] = [];
    let handshakePending = '';
    let executionPending = '';
    let capturedBytes = 0;
    let phase: 'identity' | 'ack' | 'execute' = 'identity';
    let protocolError: string | undefined;
    let settled = false;
    let lifecycleTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
      if (lifecycleTimer !== undefined) clearTimeout(lifecycleTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };
    const finish = (result: WrapperSessionResult): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };
    const terminate = (message: string): void => {
      if (protocolError !== undefined) return;
      protocolError = message;
      if (lifecycleTimer !== undefined) clearTimeout(lifecycleTimer);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), FORCE_KILL_DELAY_MS);
      killTimer.unref();
    };
    const startExecutionTimer = (): void => {
      if (lifecycleTimer !== undefined) clearTimeout(lifecycleTimer);
      lifecycleTimer = setTimeout(() => terminate(
        `CLI ${JSON.stringify(cli)} execution timed out after ${limits.executionTimeoutMs}ms.`,
      ), limits.executionTimeoutMs);
    };
    const exceedsOutputLimit = (additionalBytes: number): boolean => {
      const pendingBytes = Buffer.byteLength(executionPending);
      if (capturedBytes + pendingBytes + additionalBytes <= limits.maxOutputBytes) return false;
      terminate(
        `CLI ${JSON.stringify(cli)} exceeded the captured output limit of ${limits.maxOutputBytes} bytes.`,
      );
      return true;
    };
    const appendStdout = (value: string): void => {
      const bytes = Buffer.byteLength(value);
      capturedBytes += bytes;
      stdout.push(value);
    };
    const acceptHandshakeLine = (line: string): void => {
      const normalized = normalizeLine(line);
      if (phase === 'identity') {
        if (normalized !== WRAPPER_IDENTIFY_TOKEN) {
          terminate(`CLI ${JSON.stringify(cli)} did not identify as ${WRAPPER_IDENTIFY_TOKEN} at worker execution.`);
          return;
        }
        if (!sameWrapperIdentity(cli, env, identity)) {
          terminate(`CLI ${JSON.stringify(cli)} wrapper identity changed before private request delivery.`);
          return;
        }
        phase = 'ack';
        child.stdin.end(`${request}\n`);
        return;
      }
      if (phase === 'ack') {
        if (normalized !== WRAPPER_EXECUTE_TOKEN) {
          terminate(`CLI ${JSON.stringify(cli)} did not accept the ${WRAPPER_IDENTIFY_TOKEN} same-process execution request.`);
          return;
        }
        phase = 'execute';
        startExecutionTimer();
      }
    };
    const acceptExecutionData = (chunk: string): void => {
      executionPending += chunk;
      if (exceedsOutputLimit(0)) return;
      while (true) {
        const newline = executionPending.indexOf('\n');
        if (newline < 0) return;
        const line = executionPending.slice(0, newline);
        executionPending = executionPending.slice(newline + 1);
        if (normalizeLine(line) === WRAPPER_EXECUTE_TOKEN) {
          terminate(`CLI ${JSON.stringify(cli)} emitted a duplicate execute protocol frame.`);
          return;
        }
        appendStdout(`${line}\n`);
      }
    };
    const handshakeComplete = (): boolean => phase === 'execute';

    lifecycleTimer = setTimeout(() => terminate(
      `CLI ${JSON.stringify(cli)} did not identify as ${WRAPPER_IDENTIFY_TOKEN} within ${limits.handshakeTimeoutMs}ms.`,
    ), limits.handshakeTimeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (protocolError !== undefined) return;
      if (phase === 'execute') {
        acceptExecutionData(chunk);
        return;
      }
      handshakePending += chunk;
      if (Buffer.byteLength(handshakePending) > HANDSHAKE_OUTPUT_LIMIT) {
        terminate(`CLI ${JSON.stringify(cli)} exceeded the wrapper handshake limit.`);
        return;
      }
      while (!handshakeComplete()) {
        const newline = handshakePending.indexOf('\n');
        if (newline < 0) return;
        const line = handshakePending.slice(0, newline);
        handshakePending = handshakePending.slice(newline + 1);
        acceptHandshakeLine(line);
        if (protocolError !== undefined) return;
      }
      if (handshakePending.length > 0) {
        const remainder = handshakePending;
        handshakePending = '';
        acceptExecutionData(remainder);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (protocolError !== undefined || exceedsOutputLimit(chunk.byteLength)) return;
      capturedBytes += chunk.byteLength;
      stderr.push(chunk);
    });
    child.stdin.on('error', () => {
      // A child that closes stdin before acknowledgement is classified on close.
    });
    child.once('error', (error) => finish(failure(error.message)));
    child.once('close', (code) => {
      if (protocolError === undefined && phase === 'execute' && executionPending.length > 0) {
        if (normalizeLine(executionPending) === WRAPPER_EXECUTE_TOKEN) {
          protocolError = `CLI ${JSON.stringify(cli)} emitted a duplicate execute protocol frame.`;
        } else if (!exceedsOutputLimit(0)) {
          appendStdout(executionPending);
        }
      }
      if (protocolError !== undefined || phase !== 'execute') {
        finish(failure(
          protocolError
            ?? `CLI ${JSON.stringify(cli)} exited before completing the ${WRAPPER_IDENTIFY_TOKEN} same-process handshake.`,
        ));
        return;
      }
      finish({
        exit_code: code,
        stdout_tail: stdout.join(''),
        stderr_tail: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function sessionLimits(overrides: Partial<WrapperSessionLimits>): WrapperSessionLimits {
  return {
    handshakeTimeoutMs: positiveLimit(overrides.handshakeTimeoutMs, DEFAULT_LIMITS.handshakeTimeoutMs),
    executionTimeoutMs: positiveLimit(overrides.executionTimeoutMs, DEFAULT_LIMITS.executionTimeoutMs),
    maxOutputBytes: positiveLimit(overrides.maxOutputBytes, DEFAULT_LIMITS.maxOutputBytes),
  };
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function normalizeLine(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function failure(stderr_tail: string): WrapperSessionResult {
  return { exit_code: null, stdout_tail: '', stderr_tail };
}
