import type { MemoryHelper } from '@relayflows/surface';
import { createHash } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';
import { preflightMemory } from './preflight.js';

/** Stable across runs; disjoint from other flow files and other named flows. */
export function scriptMemoryScope(flowPath: string, name: string): string {
  const absolute = resolve(flowPath);
  const key = createHash('sha256').update(JSON.stringify([absolute, name])).digest('hex');
  return join(dirname(absolute), '.relayflows', 'memory', 'scripts', key);
}

export async function probeScriptMemory(): Promise<void> {
  const { defaultDbPath, openAiHist } = await import('ai-hist');
  const path = defaultDbPath();
  await access(path, constants.R_OK);
  if (!(await stat(path)).isFile()) throw new Error('memory database must be a file');
  const reader = await openAiHist({ dbPath: path, fallback: 'error' });
  try { reader.search('', { limit: 1 }); } finally { reader.close(); }
}

export async function assertMemoryReachable(): Promise<void> {
  const refusal = await preflightMemory(probeScriptMemory);
  if (refusal) throw new AuthoredFlowExecutionError('memory_unreachable', refusal.message);
}

export function authoredMemory(
  scope: string,
  assertOpen: () => void,
  enabled: boolean,
): MemoryHelper {
  async function read<T>(action: (reader: import('ai-hist').AiHist) => T): Promise<T> {
    assertOpen();
    if (!enabled) throw new AuthoredFlowExecutionError('unsupported_header', 'f.memory requires script memory; memory.script is false');
    await assertMemoryReachable();
    assertOpen();
    const { openAiHist } = await import('ai-hist');
    const reader = await openAiHist({ projectScope: scope, fallback: 'error' });
    try { return action(reader); } finally { reader.close(); }
  }
  return {
    recall: (query, options) => read(reader => reader.search(query, { ...options, project: scope })),
    why: task => read(reader => {
      const entry = reader.whyForTask(task);
      return entry?.projectId === scope ? [entry] : [];
    }),
    async learn() {
      assertOpen();
      throw new AuthoredFlowExecutionError('unsupported_verb', 'f.memory.learn requires the follow-up journal-backed trajectory writer');
    },
  };
}
