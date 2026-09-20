import { boundedText, redactText } from './agent-transcript.js';

export type CliTransportPhase = 'spawn' | 'close' | 'abort' | 'timeout' | 'result_exit_grace';
export type CliTransportCause =
  | 'exited'
  | 'nonzero_exit'
  | 'signal'
  | 'close_without_status'
  | 'spawn_error'
  | 'process_error'
  | 'lease_lost'
  | 'timeout'
  | 'result_exit_timeout'
  | 'codex_stdin_lifecycle';

export interface CliTransportEvidence {
  phase: CliTransportPhase;
  cause: CliTransportCause;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  /** OS/libuv error code, never an unbounded error message. */
  error_code?: string;
  /** True only for a closed set of infrastructure failures. */
  retryable: boolean;
  /** Redacted UTF-8 tail with its truncation made explicit. */
  stderr_tail: string;
}

/** Infrastructure classification is deliberately narrower than "nonzero". */
export function agentCompletionReason(
  result: { exit_code: number | null; transport?: CliTransportEvidence },
): 'success' | 'crashed' | 'timeout' | 'worker_error' {
  if (result.exit_code === 0) return 'success';
  if (result.transport?.retryable === true) return 'crashed';
  if (result.transport?.cause === 'timeout') return 'timeout';
  return 'worker_error';
}

const TRANSPORT_STDERR_MAX_BYTES = 2 * 1024;
const RETRYABLE_SPAWN_ERROR_CODES = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'ETXTBSY']);

export function isRetryableSpawnError(code: string | undefined): boolean {
  return code !== undefined && RETRYABLE_SPAWN_ERROR_CODES.has(code);
}

export function transportEvidence(
  value: {
    phase: CliTransportPhase;
    cause: CliTransportCause;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    errorCode?: string;
    retryable: boolean;
  },
  env: NodeJS.ProcessEnv,
): CliTransportEvidence {
  const bounded = boundedText(redactText(value.stderr, env), TRANSPORT_STDERR_MAX_BYTES, 'transport stderr: ');
  const errorCode = value.errorCode !== undefined && /^[A-Z0-9_-]{1,64}$/.test(value.errorCode)
    ? value.errorCode : undefined;
  return {
    phase: value.phase,
    cause: value.cause,
    exit_code: value.exitCode,
    signal: value.signal,
    ...(errorCode === undefined ? {} : { error_code: errorCode }),
    retryable: value.retryable,
    stderr_tail: bounded.text,
  };
}
