import { basename } from 'node:path';

export type CliAdapterKind = 'claude' | 'codex' | 'grok' | 'relayflows-wrapper-v1';

export interface CliInvocation {
  args: string[];
  timeoutMs: number;
  /** Prompt delivered over stdin, never appended to argv. */
  stdin?: string;
  /** Prompt content written to a private temporary file before spawning. */
  promptFile?: string;
  /** Set only for wrapper readiness probes; raw providers receive a model flag. */
  modelEnv?: string;
}

export interface CliAdapterIdentification {
  invocation: CliInvocation;
  expectedStdout?: string;
}

export const WRAPPER_IDENTIFY_ARG = '--relayflows-adapter-v1';
export const WRAPPER_IDENTIFY_TOKEN = 'relayflows-agent-cli-v1';
export const WRAPPER_EXECUTE_TOKEN = 'relayflows-agent-cli-v1-execute';
/** Replaced with a private temporary pathname immediately before spawning Grok. */
export const HEADLESS_PROMPT_FILE = '__relayflows_prompt_file__';

const MODEL_PROBE_PROMPT = 'Reply with exactly RELAYFLOWS_MODEL_READY and nothing else.';

/** Select a closed adapter from the resolved executable's basename. */
export function cliAdapterKind(executable: string): CliAdapterKind {
  const name = basename(executable).replace(/\.exe$/i, '');
  if (name === 'claude') return 'claude';
  if (name === 'codex') return 'codex';
  if (name === 'grok') return 'grok';
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
  if (kind === 'grok') {
    return { invocation: { args: ['auth', 'status', '--help'], timeoutMs: 10_000 } };
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
  if (kind !== 'relayflows-wrapper-v1') {
    const invocation = agentExecution(kind, MODEL_PROBE_PROMPT, model);
    return {
      ...invocation,
      // Claude's readiness call is deliberately side-effect-free. Codex has
      // the same read-only sandbox rail as its historical probe.
      args: kind === 'claude'
        ? [...invocation.args, '--tools', '', '--no-session-persistence']
        : kind === 'codex'
          ? [
              'exec', '--json', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check',
              ...(model === undefined ? [] : ['--model', model]), '-',
            ]
          : invocation.args,
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
      args: [
        '-p', '--output-format', 'stream-json', '--verbose',
        ...(model === undefined ? [] : ['--model', model]),
      ],
      timeoutMs: 0,
      stdin: instruction,
    };
  }
  if (kind === 'codex') {
    return {
      args: [
        'exec', '--json', '--ephemeral', '--skip-git-repo-check',
        ...(model === undefined ? [] : ['--model', model]),
        '-',
      ],
      timeoutMs: 0,
      stdin: instruction,
    };
  }
  if (kind === 'grok') {
    return {
      args: [
        '--prompt-file', HEADLESS_PROMPT_FILE, '--output-format', 'json',
        ...(model === undefined ? [] : ['--model', model]),
      ],
      timeoutMs: 0,
      promptFile: instruction,
    };
  }
  throw new Error('custom wrapper execution requires the runAgentCli same-process session');
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
