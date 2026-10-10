import type { Ctx } from '@relayflows/surface';
import { nodeCommand } from './github.ts';

// Stringified by `nodeCommand` and run by `node -e` inside an `f.run` step,
// never in this process (see github.ts and fix.ts).
declare const process: { env: Record<string, string | undefined>; stdout: { write(chunk: string): void } };
declare const Buffer: { from(value: string): { toString(encoding: string): string } };

/** Drizzle's generated metadata: renumbered deterministically by Cloud, never by an agent. */
export const DRIZZLE_META = String.raw`^packages/web/drizzle/meta/`;

/**
 * For `resolve_conflict`: fetch the trunk commit Cloud named into the
 * checkout and start merging it, leaving conflicts for the agent. The token
 * travels as a header, as in `checkoutHead`; nothing is committed. Prints
 * the merge base, the conflicted paths, and those under drizzle metadata,
 * or a refusal.
 */
export async function mergeTrunk(c: { dir: string; owner: string; repo: string; head: string; trunkSha: string; meta: string; origin?: string }): Promise<void> {
  const { execFileSync } = await import('node:child_process');
  if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN required');
  const auth = Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString('base64');
  const env = {
    ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Babysitter', GIT_AUTHOR_EMAIL: 'babysitter@invalid', GIT_COMMITTER_NAME: 'Babysitter', GIT_COMMITTER_EMAIL: 'babysitter@invalid',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${auth}`,
    GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
    GIT_CONFIG_KEY_2: 'core.quotePath', GIT_CONFIG_VALUE_2: 'false',
  };
  const git = (...args: string[]) => String(execFileSync('git', ['-C', c.dir, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  const refuse = (reason: string) => process.stdout.write(JSON.stringify({ kind: 'babysitter-refusal', reason }));
  const url = c.origin ?? `https://github.com/${c.owner}/${c.repo}.git`;
  if (git('rev-parse', 'HEAD') !== c.head) return refuse('checkout is not at the bound head');
  git('fetch', '-q', '--no-tags', '--depth=500', url, c.trunkSha);
  git('fetch', '-q', '--no-tags', '--deepen=500', url, c.head);
  let mergeBase: string;
  try { mergeBase = git('merge-base', c.head, c.trunkSha); } catch { return refuse('no merge base between the head and trunk within the fetched history'); }
  try { git('merge', '-q', '--no-commit', '--no-ff', c.trunkSha); } catch { /* conflicts are listed below */ }
  const conflicts = git('diff', '--name-only', '--diff-filter=U', '-z').split('\0').filter(Boolean);
  const metaConflicts = conflicts.filter(p => new RegExp(c.meta).test(p));
  process.stdout.write(JSON.stringify({ kind: 'babysitter-merge', mergeBase, conflicts, metaConflicts }));
}

export type Merge =
  | { kind: 'babysitter-merge'; mergeBase: string; conflicts: string[]; metaConflicts: string[] }
  | { kind: 'babysitter-refusal'; reason: string };

export async function merge(f: Ctx, input: { dir: string; owner: string; repo: string; head: string; trunkSha: string }): Promise<Merge> {
  const value = JSON.parse(await f.run(nodeCommand(mergeTrunk, { ...input, meta: DRIZZLE_META }), { timeout: '5m' }));
  if (value.kind === 'babysitter-refusal' && typeof value.reason === 'string') return value;
  if (value.kind !== 'babysitter-merge' || typeof value.mergeBase !== 'string' || !Array.isArray(value.conflicts) || !Array.isArray(value.metaConflicts))
    throw new Error('Merge step returned a malformed result');
  return value;
}
