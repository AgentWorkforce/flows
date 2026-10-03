import type { Ctx } from '@relayflows/surface';
import { nodeCommand } from './github.ts';
import type { BoundPullRequest } from './binding.ts';

// Both functions below are stringified by `nodeCommand` and run by `node -e`
// inside an `f.run` step, never in this process; see github.ts for why the
// runtime is declared here instead of pulling in @types/node.
declare const process: { env: Record<string, string | undefined>; stdout: { write(chunk: string): void } };
declare const Buffer: { byteLength(value: string): number };
declare function fetch(url: string, init: { method?: string; headers: Record<string, string>; body?: string }): Promise<{
  ok: boolean; status: number; json(): Promise<any>;
}>;

export interface Signals {
  headSha: string;
  failingChecks: { name: string; conclusion: string; summary: string; url: string }[];
  changeRequests: { login: string; id: number; body: string }[];
  comments: { id: number; login: string; association: string; body: string; createdAt: string }[];
}

/**
 * What changed at one live head: failing checks with their own summaries,
 * standing change requests with their bodies, and the newest PR comments.
 * Every text field is bounded and is untrusted data. Refuses if the head moves
 * during the read, so the signals can never span two heads.
 */
async function readSignals(c: { owner: string; repo: string; number: number; head: string }): Promise<void> {
  const api = `https://api.github.com/repos/${c.owner}/${c.repo}`;
  const cut = (s: unknown, n: number) => typeof s === 'string' ? s.slice(0, n) : '';
  async function get(path: string): Promise<any> {
    if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN required');
    const res = await fetch(api + path, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status}`);
    return res.json();
  }
  const runs = (await get(`/commits/${c.head}/check-runs?filter=latest&per_page=100`)).check_runs;
  const reviews = await get(`/pulls/${c.number}/reviews?per_page=100`);
  const meta = await get(`/issues/${c.number}`);
  // The newest comments: directives and our own reports are recent. Two pages,
  // so a nearly empty last page cannot hide the report just before it.
  const last = Math.max(1, Math.ceil(Number(meta.comments ?? 0) / 100));
  const comments = [
    ...(last > 1 ? await get(`/issues/${c.number}/comments?per_page=100&page=${last - 1}`) : []),
    ...await get(`/issues/${c.number}/comments?per_page=100&page=${last}`),
  ];
  if (!Array.isArray(runs) || !Array.isArray(reviews)) throw new Error('Malformed GitHub list');
  const bad = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'];
  const standing = new Map<string, any>();
  for (const r of reviews) {
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state) || typeof r.user?.login !== 'string') continue;
    const prior = standing.get(r.user.login.toLowerCase());
    if (!prior || r.id > prior.id) standing.set(r.user.login.toLowerCase(), r);
  }
  const out = JSON.stringify({
    headSha: c.head,
    failingChecks: runs.filter((r: any) => r.head_sha === c.head && r.status === 'completed' && bad.includes(r.conclusion))
      .slice(0, 20).map((r: any) => ({ name: cut(r.name, 200), conclusion: r.conclusion, summary: cut(r.output?.summary, 2000), url: cut(r.html_url, 500) })),
    changeRequests: [...standing.values()].filter(r => r.state === 'CHANGES_REQUESTED')
      .slice(0, 20).map(r => ({ login: r.user.login, id: r.id, body: cut(r.body, 4000) })),
    comments: comments.slice(-50).map((m: any) => ({
      id: m.id, login: m.user?.login ?? '', association: m.author_association ?? 'NONE', body: cut(m.body, 4000), createdAt: m.created_at,
    })),
  });
  const final = await get(`/pulls/${c.number}`);
  if (final.head?.sha !== c.head) throw new Error('Live PR head moved during signal capture');
  if (Buffer.byteLength(out) > 55000) throw new Error('PR signals exceed safe journal output size');
  process.stdout.write(out);
}

/** The one write v1 makes: a single issue comment on the bound PR. */
async function postComment(c: { owner: string; repo: string; number: number; body: string }): Promise<void> {
  if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN required');
  const res = await fetch(`https://api.github.com/repos/${c.owner}/${c.repo}/issues/${c.number}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: c.body }),
  });
  if (!res.ok) throw new Error(`GitHub comment POST: ${res.status}`);
  process.stdout.write(JSON.stringify({ id: (await res.json()).id }));
}

export async function readSignalsAt(f: Ctx, pr: BoundPullRequest, head: string): Promise<Signals> {
  const value = JSON.parse(await f.run(nodeCommand(readSignals, { owner: pr.owner, repo: pr.repo, number: pr.number, head }), { timeout: '2m' }));
  if (value.headSha !== head) throw new Error('Signals were read for a different head');
  return value;
}

export async function postReport(f: Ctx, pr: BoundPullRequest, body: string): Promise<void> {
  await f.run(nodeCommand(postComment, { owner: pr.owner, repo: pr.repo, number: pr.number, body }), { timeout: '2m' });
}
