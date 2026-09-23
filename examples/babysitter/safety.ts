import type { Config } from './input.ts';
import { shaValid } from './input.ts';
import { eligible, type State } from './state.ts';
export function conflictAllowed(body: string, login: string, s: State, c: Config): string | undefined {
  const skip = eligible(s, c); if (skip) return skip;
  if (!/^@relay(?:-?bot)?\s+(?:fix|resolve)\s+conflicts?\s*$/i.test(body.trim())) return 'Explicit conflict directive required';
  const name = login.toLowerCase();
  if (!name || name.endsWith('[bot]') || (name !== String(s.author).toLowerCase() && !c.approvers.includes(name))) return 'Conflict commander not authorized';
  if (String(s.headRepo).toLowerCase() !== `${c.owner}/${c.repo}`.toLowerCase()) return 'Fork push prohibited';
  return undefined;
}
/** Narrower than the legacy prompt: only inert text files have an automatic transform. */
export function protectedPath(path: string): boolean {
  return path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..')
    || /(^|\/)(tests?|spec|__tests__|gates?|workflows?|scripts|ops|\.github|\.git|\.workforce)(\/|\.)/i.test(path)
    || /(^|\/)(package[^/]*\.json|[^/]*lock[^/]*|.*config.*|Makefile|Cargo\..*|AGENTS\.md)$/i.test(path)
    || !/\.(md|txt)$/i.test(path);
}
export function editAllowed(edit: { kind: string; paths: string[]; verified: boolean; unresolved: boolean }, s: State, c: Config, sha: string): string | undefined {
  const skip = eligible(s, c); if (skip) return skip;
  if (!shaValid(sha) || s.headSha !== sha) return 'Stale edit';
  if (String(s.headRepo).toLowerCase() !== `${c.owner}/${c.repo}`.toLowerCase()) return 'Fork push prohibited';
  if (edit.kind !== 'trailing-whitespace') return 'Semantic or unproven edit refused';
  if (edit.paths.some(protectedPath)) return 'Protected path edit veto';
  if (edit.unresolved) return 'Unresolved conflicts';
  if (!edit.verified) return 'Operator-pinned validation failed';
  return undefined;
}
export function publicationDecision(x: { expectedSha: string; liveSha: string; author?: string; botLogin: string; existingSha?: string; bodyMatches: boolean; atomic: boolean }): string {
  if (!shaValid(x.expectedSha) || x.expectedSha !== x.liveSha) return 'stale';
  if (!x.atomic) return 'atomic-publication-unavailable';
  if (x.author !== undefined && x.author !== x.botLogin) return 'not-owned';
  // No commit-date heuristic: rebases and forged dates do not order wakes.
  if (x.existingSha !== undefined && x.existingSha !== x.expectedSha) return 'newer-verdict';
  return x.bodyMatches ? 'unchanged' : x.author ? 'update' : 'create';
}
