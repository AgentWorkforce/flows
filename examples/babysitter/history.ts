import type { Config } from './input.ts';
/** Behavioral source: agents origin/main review/agent.ts attributeCiFailure. */
export function attribution(x: { priorCiFailing: boolean | null; priorHeadSha: string | null; currentHeadSha: string | null; leftEdits: boolean; priorOwnedRegression?: boolean }): 'ours' | 'pre-existing' | 'unknown' {
  if (x.priorOwnedRegression) return 'ours';
  if (!x.leftEdits || x.priorCiFailing === true) return 'pre-existing';
  if (x.priorCiFailing === false && x.priorHeadSha && x.currentHeadSha && x.priorHeadSha !== x.currentHeadSha) return 'ours';
  return 'unknown';
}
export const notificationKey = (c: Pick<Config, 'owner' | 'repo' | 'number'>, sha: string): string => `babysitter:ready:${c.owner.toLowerCase()}/${c.repo.toLowerCase()}#${c.number}:${sha}`;
/** Used only when a runner exposes an exit code, never parse an error message. */
export async function retryInfra<T extends { exitCode: number }>(run: () => Promise<T>): Promise<T> {
  const first = await run();
  return first.exitCode === 137 || first.exitCode === 143 ? run() : first;
}
