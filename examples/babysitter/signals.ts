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
  /** Heads this bot has already reported on, from its own comments' markers. */
  reportedHeads: string[];
  /** Comments after the bot's last comment, newest 50: where a new directive can be. */
  comments: { id: number; login: string; association: string; body: string; createdAt: string }[];
}

/**
 * What changed at one live head: failing check runs and commit statuses with
 * their own summaries, standing change requests with their bodies, this bot's
 * prior reports, and the comments since its last one. Lists are paginated in
 * full (bounded, failing closed past the bound) so a verdict or a report is
 * never lost to a page edge. Every text field is bounded and is untrusted
 * data. Refuses if the head moves during the read.
 */
export async function readSignals(c: { owner: string; repo: string; number: number; head: string; botLogin: string }): Promise<void> {
  const api = `https://api.github.com/repos/${c.owner}/${c.repo}`;
  const cut = (s: unknown, n: number) => typeof s === 'string' ? s.slice(0, n) : '';
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
    throw new Error('Pagination exceeded; signals incomplete');
  }
  const [runs, statuses, reviews, comments] = await Promise.all([
    pages(`/commits/${c.head}/check-runs?filter=latest`, 'check_runs'), pages(`/commits/${c.head}/statuses`),
    pages(`/pulls/${c.number}/reviews`), pages(`/issues/${c.number}/comments`),
  ]);
  const bad = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'error'];
  // Commit statuses are newest first; an old failure must not outlive a newer success.
  const latestStatus = new Map<string, any>();
  for (const s of statuses) if (!latestStatus.has(s.context)) latestStatus.set(s.context, s);
  const standing = new Map<string, any>();
  for (const r of reviews) {
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state) || typeof r.user?.login !== 'string') continue;
    const prior = standing.get(r.user.login.toLowerCase());
    if (!prior || r.id > prior.id) standing.set(r.user.login.toLowerCase(), r);
  }
  const bot = c.botLogin.toLowerCase();
  const prefix = `<!-- babysitter:report ${c.owner.toLowerCase()}/${c.repo.toLowerCase()}#${c.number}@`;
  const own = (m: any) => String(m.user?.login ?? '').toLowerCase() === bot;
  const reportedHeads: string[] = [];
  let lastOwn = -1;
  comments.forEach((m: any, i: number) => {
    if (!own(m)) return;
    lastOwn = i;
    const body = String(m.body ?? '');
    const at = body.indexOf(prefix);
    if (at >= 0) reportedHeads.push(body.slice(at + prefix.length, at + prefix.length + 40));
  });
  const out = JSON.stringify({
    headSha: c.head,
    failingChecks: [
      ...runs.filter((r: any) => r.head_sha === c.head && r.status === 'completed' && bad.includes(r.conclusion))
        .map((r: any) => ({ name: cut(r.name, 200), conclusion: r.conclusion, summary: cut(r.output?.summary, 2000), url: cut(r.html_url, 500) })),
      ...[...latestStatus.values()].filter(s => bad.includes(s.state))
        .map(s => ({ name: cut(s.context, 200), conclusion: s.state, summary: cut(s.description, 2000), url: cut(s.target_url, 500) })),
    ].slice(0, 20),
    changeRequests: [...standing.values()].filter(r => r.state === 'CHANGES_REQUESTED')
      .slice(0, 20).map(r => ({ login: r.user.login, id: r.id, body: cut(r.body, 4000) })),
    reportedHeads,
    comments: comments.slice(lastOwn + 1).slice(-50).map((m: any) => ({
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

/** Prefix a posted report when the head moved under it: the issue-comment API has no SHA precondition. */
async function markSuperseded(c: { owner: string; repo: string; id: number; head: string; liveHead: string }): Promise<void> {
  if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN required');
  const url = `https://api.github.com/repos/${c.owner}/${c.repo}/issues/comments/${c.id}`;
  const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
  const current = await fetch(url, { headers });
  if (!current.ok) throw new Error(`GitHub comment GET: ${current.status}`);
  const note = `> **Superseded:** the head moved to \`${c.liveHead}\` while this was posted; this diagnosis is for \`${c.head}\` only.\n\n`;
  const res = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ body: note + (await current.json()).body }) });
  if (!res.ok) throw new Error(`GitHub comment PATCH: ${res.status}`);
}

export async function readSignalsAt(f: Ctx, pr: BoundPullRequest, head: string, botLogin: string): Promise<Signals> {
  const value = JSON.parse(await f.run(nodeCommand(readSignals, { owner: pr.owner, repo: pr.repo, number: pr.number, head, botLogin }), { timeout: '2m' }));
  if (value.headSha !== head) throw new Error('Signals were read for a different head');
  return value;
}

/** Returns the posted comment's id. */
export async function postReport(f: Ctx, pr: BoundPullRequest, body: string): Promise<number> {
  const posted = JSON.parse(await f.run(nodeCommand(postComment, { owner: pr.owner, repo: pr.repo, number: pr.number, body }), { timeout: '2m' }));
  if (!Number.isSafeInteger(posted.id)) throw new Error('GitHub did not return the posted comment id');
  return posted.id;
}

export async function supersedeReport(f: Ctx, pr: BoundPullRequest, id: number, head: string, liveHead: string): Promise<void> {
  await f.run(nodeCommand(markSuperseded, { owner: pr.owner, repo: pr.repo, id, head, liveHead }), { timeout: '2m' });
}
