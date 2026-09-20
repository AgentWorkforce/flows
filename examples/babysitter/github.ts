/// <reference types="node" />
import type { Ctx } from '@relayflows/surface';
import { shellWord, type Config } from './input.ts';
import type { State } from './state.ts';

/** Runs entirely inside f.run. Bound output prevents the worker stdout tail hiding state. */
async function githubRead(c: { owner: string; repo: string; number: number; headSha: string }): Promise<void> {
  const api = `https://api.github.com/repos/${c.owner}/${c.repo}`;
  async function get(path: string): Promise<any> {
    if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN required');
    const res = await fetch(api + path, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status}`);
    return res.json();
  }
  async function pages(path: string, key?: string): Promise<any[]> {
    const all: any[] = [];
    for (let page = 1; page <= 50; page++) {
      const value = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const batch = key ? value[key] : value;
      if (!Array.isArray(batch)) throw new Error('Malformed GitHub list');
      all.push(...batch);
      if (batch.length < 100) return all;
    }
    throw new Error('Pagination exceeded; state incomplete');
  }
  const meta = await get(`/pulls/${c.number}`);
  const head = meta.head?.sha;
  if (typeof head !== 'string' || !/^[a-f0-9]{40}$/.test(head)) throw new Error('Missing live head');
  const [checks, statuses, reviews] = await Promise.all([
    pages(`/commits/${head}/check-runs?filter=latest`, 'check_runs'), pages(`/commits/${head}/statuses`), pages(`/pulls/${c.number}/reviews`),
  ]);
  // Commit statuses are newest-first; old failures on the same context must not veto a newer success.
  const latestStatuses = new Map<string, any>();
  for (const item of statuses) if (!latestStatuses.has(item.context)) latestStatuses.set(item.context, item);
  const state = {
    state: meta.state, merged: meta.merged, draft: meta.draft, headSha: head,
    baseSha: meta.base?.sha, headRepo: meta.head?.repo?.full_name, headRef: meta.head?.ref,
    author: meta.user?.login, labels: Array.isArray(meta.labels) ? meta.labels.map((l: any) => l.name) : null,
    mergeable: meta.mergeable, mergeState: meta.mergeable_state,
    checks: [...checks.map(r => ({ name: r.name, sha: r.head_sha, status: r.status, conclusion: r.conclusion })),
      ...[...latestStatuses.values()].map(r => ({ name: r.context, sha: head, status: r.state === 'pending' ? 'pending' : 'completed', conclusion: r.state }))],
    reviews: reviews.map(r => ({ login: r.user?.login, sha: r.commit_id, state: r.state, id: r.id })),
    requestedReviewers: Array.isArray(meta.requested_reviewers) && Array.isArray(meta.requested_teams)
      ? [...meta.requested_reviewers.map((r: any) => r.login), ...meta.requested_teams.map((r: any) => `team:${r.slug}`)] : null,
  };
  // Re-read after pagination: don't assemble state spanning two heads.
  const final = await get(`/pulls/${c.number}`);
  if (final.head?.sha !== head || final.state !== meta.state || final.draft !== meta.draft || final.merged !== meta.merged
    || JSON.stringify(final.labels) !== JSON.stringify(meta.labels)) throw new Error('Live PR changed during state capture');
  const out = JSON.stringify(state);
  if (Buffer.byteLength(out) > 55000) throw new Error('PR state exceeds safe journal output size');
  process.stdout.write(out);
}
export function nodeCommand(fn: Function, value: unknown): string {
  return `node -e ${shellWord(`(${fn.toString()})(${JSON.stringify(value)}).catch(e => { console.error(e.message); process.exit(1); })`)}`;
}
export async function readState(f: Ctx, c: Config): Promise<State> {
  return JSON.parse(await f.run(nodeCommand(githubRead, { owner: c.owner, repo: c.repo, number: c.number, headSha: c.headSha }), { timeout: '2m' }));
}
/** SHA guard is enforced by GitHub, not an agent assertion. Caller must just have gated live state. */
export async function mergeExact(f: Ctx, c: Config): Promise<void> {
  const response = await f.run(`curl --fail-with-body -sS -X PUT -H "Authorization: Bearer $GH_TOKEN" -H 'Accept: application/vnd.github+json' -H 'Content-Type: application/json' ${shellWord(`https://api.github.com/repos/${c.owner}/${c.repo}/pulls/${c.number}/merge`)} --data ${shellWord(JSON.stringify({ sha: c.headSha, merge_method: 'squash' }))}`, { timeout: '2m' });
  if (JSON.parse(response).merged !== true) throw new Error('GitHub did not confirm exact-head merge');
}
