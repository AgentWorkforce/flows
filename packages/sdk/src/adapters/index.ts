import { basename } from 'node:path';

import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { wrapperAdapter } from './wrapper.js';
import type { HeadlessAdapter } from './base.js';

export type CliAdapterKind = 'claude' | 'codex' | 'relayflows-wrapper-v1';

/** The registered adapter set. Adding a CLI is adding one file + one entry. */
const ADAPTERS: Record<CliAdapterKind, HeadlessAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  'relayflows-wrapper-v1': wrapperAdapter,
};

/** Select the adapter for the resolved executable basename. */
export function resolveAdapter(executable: string): HeadlessAdapter {
  const name = basename(executable).replace(/\.exe$/i, '');
  if (name === 'claude') return ADAPTERS.claude;
  if (name === 'codex') return ADAPTERS.codex;
  return ADAPTERS['relayflows-wrapper-v1'];
}

/** Backward-compatible kind lookup for callers still speaking string-tag lang. */
export function resolveAdapterKind(executable: string): CliAdapterKind {
  return resolveAdapter(executable).kind as CliAdapterKind;
}

/** Registered adapters by kind (read-only view for tests and diagnostics). */
export function registeredAdapters(): Readonly<Record<CliAdapterKind, HeadlessAdapter>> {
  return ADAPTERS;
}

export { claudeAdapter, codexAdapter, wrapperAdapter };
export type { HeadlessAdapter, CliInvocation, CliAdapterIdentification } from './base.js';
