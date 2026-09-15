/**
 * Legacy dispatch surface — retained so existing callers (`worker-cli.ts`,
 * `cli/check.ts`, real-cli-adapters tests) compile unchanged. The per-CLI
 * knowledge now lives in `./adapters/{claude,codex,wrapper}.ts` behind the
 * `HeadlessAdapter` interface (flows#141). New CLIs implement the interface
 * and register in `./adapters/index.ts`; this file no longer needs edits.
 */
import {
  resolveAdapterKind,
  registeredAdapters,
} from './adapters/index.js';
import type { CliAdapterKind } from './adapters/index.js';
import type { CliInvocation, CliAdapterIdentification } from './adapters/base.js';

export type { CliAdapterKind } from './adapters/index.js';
export type { CliInvocation, CliAdapterIdentification, HeadlessAdapter } from './adapters/base.js';

export {
  WRAPPER_IDENTIFY_ARG,
  WRAPPER_IDENTIFY_TOKEN,
  WRAPPER_EXECUTE_TOKEN,
} from './adapters/wrapper.js';

export { resolveAdapter, resolveAdapterKind, registeredAdapters } from './adapters/index.js';

/** Select a closed adapter from the resolved executable's basename. */
export function cliAdapterKind(executable: string): CliAdapterKind {
  return resolveAdapterKind(executable);
}

export type CliModelSource = 'step' | 'named' | 'adapter';

export interface ResolvedCliModel {
  readonly model?: string;
  readonly source?: CliModelSource;
}

/**
 * Resolve the model once, in authoring priority order: step, selected named
 * agent, then the registered CLI adapter's default. Unregistered executables
 * resolve through the wrapper adapter, whose absent default remains undefined.
 */
export function resolveCliModelSelection(
  executable: string,
  declarations: Readonly<{ step?: string; named?: string }> = {},
): ResolvedCliModel {
  if (declarations.step !== undefined) return { model: declarations.step, source: 'step' };
  if (declarations.named !== undefined) return { model: declarations.named, source: 'named' };
  const model = registeredAdapters()[resolveAdapterKind(executable)].defaultModel;
  return model === undefined ? {} : { model, source: 'adapter' };
}

/** Resolve a runtime model, where any materialized value is step-owned. */
export function resolveCliModel(executable: string, model?: string): string | undefined {
  return resolveCliModelSelection(executable, { step: model }).model;
}

/** Prove the adapter command shape before classifying an auth failure. */
export function adapterIdentification(kind: CliAdapterKind): CliAdapterIdentification {
  return registeredAdapters()[kind].buildIdentification();
}

export function authenticationProbe(kind: CliAdapterKind): CliInvocation {
  return registeredAdapters()[kind].buildAuthProbe();
}

/**
 * A provider model probe is a real, noninteractive model round trip. The
 * wrapper protocol keeps its established auth-status shape and receives the
 * exact model through its explicitly identified environment contract.
 */
export function modelReadinessProbe(kind: CliAdapterKind, model: string): CliInvocation {
  return registeredAdapters()[kind].buildModelReadinessProbe(model);
}

/** Build the actual worker argv; this is shared contract, not probe-only lore. */
export function agentExecution(
  kind: CliAdapterKind,
  instruction: string,
  model?: string,
): CliInvocation {
  return registeredAdapters()[kind].buildAgentInvocation(instruction, model);
}

/** Reuse the workspace-free model probe's provider flags for a real LLM call. */
export function llmExecution(kind: CliAdapterKind, prompt: string, model?: string): CliInvocation {
  return registeredAdapters()[kind].buildLlmInvocation(prompt, model);
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
