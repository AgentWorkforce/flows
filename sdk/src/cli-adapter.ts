import { basename } from 'node:path';

export type CliAdapterKind = 'claude' | 'codex' | 'relayflows-wrapper-v1';

export interface CliInvocation {
  args: string[];
  timeoutMs: number;
  /** Set only for the explicit wrapper protocol; raw providers receive a model flag. */
  modelEnv?: string;
}

export interface CliAdapterIdentification {
  invocation: CliInvocation;
  expectedStdout?: string;
}

export const WRAPPER_IDENTIFY_ARG = '--relayflows-adapter-v1';
export const WRAPPER_IDENTIFY_TOKEN = 'relayflows-agent-cli-v1';

const MODEL_PROBE_PROMPT = 'Reply with exactly RELAYFLOWS_MODEL_READY and nothing else.';

/** Select a closed adapter from the resolved executable's basename. */
export function cliAdapterKind(executable: string): CliAdapterKind {
  const name = basename(executable).replace(/\.exe$/i, '');
  if (name === 'claude') return 'claude';
  if (name === 'codex') return 'codex';
  return 'relayflows-wrapper-v1';
}

/** Prove the adapter command shape before classifying an auth failure. */
export function adapterIdentification(kind: CliAdapterKind): CliAdapterIdentification {
  if (kind === 'claude') {
    return { invocation: { args: ['auth', 'status', '--help'], timeoutMs: 10_000 } };
  }
  if (kind === 'codex') {
    return { invocation: { args: ['login', 'status', '--help'], timeoutMs: 10_000 } };
  }
  return {
    invocation: { args: [WRAPPER_IDENTIFY_ARG], timeoutMs: 10_000 },
    expectedStdout: WRAPPER_IDENTIFY_TOKEN,
  };
}

export function authenticationProbe(kind: CliAdapterKind): CliInvocation {
  if (kind === 'codex') return { args: ['login', 'status'], timeoutMs: 10_000 };
  return { args: ['auth', 'status'], timeoutMs: 10_000 };
}

/**
 * A provider model probe is a real, noninteractive model round trip. The
 * wrapper protocol keeps its established auth-status shape and receives the
 * exact model through its explicitly identified environment contract.
 */
export function modelReadinessProbe(kind: CliAdapterKind, model: string): CliInvocation {
  if (kind === 'claude') {
    return {
      args: [
        '-p', '--model', model, '--tools', '', '--no-session-persistence',
        MODEL_PROBE_PROMPT,
      ],
      timeoutMs: 60_000,
    };
  }
  if (kind === 'codex') {
    return {
      args: [
        'exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check',
        '--model', model, MODEL_PROBE_PROMPT,
      ],
      timeoutMs: 60_000,
    };
  }
  return {
    args: ['auth', 'status'],
    timeoutMs: 60_000,
    modelEnv: model,
  };
}

/** Build the actual worker argv; this is shared contract, not probe-only lore. */
export function agentExecution(
  kind: CliAdapterKind,
  instruction: string,
  model?: string,
): CliInvocation {
  if (kind === 'claude') {
    return {
      args: ['-p', ...(model === undefined ? [] : ['--model', model]), instruction],
      timeoutMs: 0,
    };
  }
  if (kind === 'codex') {
    return {
      args: [
        'exec', '--ephemeral', '--skip-git-repo-check',
        ...(model === undefined ? [] : ['--model', model]),
        instruction,
      ],
      timeoutMs: 0,
    };
  }
  return {
    args: [instruction],
    timeoutMs: 0,
    ...(model === undefined ? {} : { modelEnv: model }),
  };
}

export function displayInvocation(cli: string, invocation: CliInvocation): string {
  const command = [cli, ...invocation.args].map(shellDisplayWord).join(' ');
  return invocation.modelEnv === undefined
    ? command
    : `RELAYFLOW_MODEL=${shellDisplayWord(invocation.modelEnv)} ${command}`;
}

function shellDisplayWord(word: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(word) ? word : JSON.stringify(word);
}
