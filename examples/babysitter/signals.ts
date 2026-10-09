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
  /** Whether this bot already reported this head, from its own comments' markers. */
  reported: boolean;
  /** Comments after the bot's last comment, newest 50: where a new directive can be. */
  comments: { id: number; login: string; association: string; body: string; createdAt: string }[];
  /**
   * Review feedback Babysitter has not answered, oldest first: unresolved
   * inline comments (not outdated, not followed by this bot's reply in their
   * thread) and non-empty commented review bodies, newer than its last report.
   * Only from the PR author, OWNER/MEMBER/COLLABORATOR, or an allowlisted
   * review bot; never from this bot or another of our own agents.
   */
  reviewFeedback: {
    kind: 'inline' | 'review'; id: number; login: string; body: string;
    path?: string; line?: number; thread?: number; createdAt: string;
  }[];
}

/**
 * What changed at one live head: failing check runs and commit statuses with
 * their own summaries, standing change requests with their bodies, this bot's
 * prior reports, and the comments since its last one. Lists are paginated in
 * full (bounded, failing closed past the bound) so a verdict or a report is
 * never lost to a page edge. Every text field is bounded and is untrusted
 * data. Refuses if the head moves during the read.
 */
export async function readSignals(c: {
  owner: string; repo: string; number: number; head: string; botLogin: string; author: string; reviewBots: string[]; ownAgents: string[];
}): Promise<void> {
  const api = `https://api.github.com/repos/${c.owner}/${c.repo}`;
  const cut = (s: unknown, n: number) => typeof s === 'string' ? s.slice(0, n) : '';
  // Under the 55KB journal output guard, with room for the step envelope.
  const BUDGET = 50_000;
  const clip = (s: unknown, n: number) => typeof s === 'string' && s.length > n ? `${s.slice(0, n)} [truncated]` : cut(s, n);
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
  const [runs, statuses, reviews, comments, inline] = await Promise.all([
    pages(`/commits/${c.head}/check-runs?filter=latest`, 'check_runs'), pages(`/commits/${c.head}/statuses`),
    pages(`/pulls/${c.number}/reviews`), pages(`/issues/${c.number}/comments`), pages(`/pulls/${c.number}/comments`),
  ]);
  const bad = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale', 'error'];
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
  // A boolean for this head, not a history: report count must not grow the payload.
  const marker = `<!-- babysitter:report ${c.owner.toLowerCase()}/${c.repo.toLowerCase()}#${c.number}@${c.head} -->`;
  // The app login may be shared (Software Garden posts as the same app), so a
  // comment is Babysitter's only when it also carries a Babysitter marker.
  const own = (m: any) => String(m.user?.login ?? '').toLowerCase() === bot && String(m.body ?? '').includes('<!-- babysitter:');
  let reported = false, lastOwn = -1;
  comments.forEach((m: any, i: number) => {
    if (!own(m)) return;
    lastOwn = i;
    if (String(m.body ?? '').includes(marker)) reported = true;
  });
  const checks = [
    ...runs.filter((r: any) => r.head_sha === c.head && r.status === 'completed' && bad.includes(r.conclusion))
      .map((r: any) => ({ name: r.name, conclusion: r.conclusion, summary: r.output?.summary, url: r.html_url })),
    ...[...latestStatus.values()].filter(s => bad.includes(s.state))
      .map(s => ({ name: s.context, conclusion: s.state, summary: s.description, url: s.target_url })),
  ].slice(0, 20);
  const requests = [...standing.values()].filter(r => r.state === 'CHANGES_REQUESTED').slice(0, 20);
  let recent = comments.slice(lastOwn + 1).slice(-50);
  // Review feedback: who may give it, and only what is newer than the last
  // report and not already answered in its own thread by this bot.
  // Our own agents (this bot included) never give feedback, and their reply
  // in a thread answers it, so an agent's "Fixed in …" cannot wake Babysitter.
  const author = c.author.toLowerCase(), bots = c.reviewBots.map(b => b.toLowerCase());
  const ours = [bot, ...c.ownAgents.map(a => a.toLowerCase())];
  const trusted = ['OWNER', 'MEMBER', 'COLLABORATOR'];
  const from = (m: any) => {
    const login = String(m.user?.login ?? '').toLowerCase();
    if (!login || ours.includes(login)) return false;
    if (login.endsWith('[bot]')) return bots.includes(login);
    return login === author || trusted.includes(m.author_association);
  };
  const since = lastOwn < 0 ? '' : String(comments[lastOwn].created_at ?? '');
  const answered = new Map<number, number>();
  for (const m of inline) {
    const login = String(m.user?.login ?? '').toLowerCase();
    if (login === bot ? !own(m) : !ours.includes(login)) continue;
    const thread = m.in_reply_to_id ?? m.id;
    answered.set(thread, Math.max(answered.get(thread) ?? 0, m.id));
  }
  let feedback = [
    ...inline.filter((m: any) => from(m) && typeof m.line === 'number' && String(m.created_at ?? '') > since
      && m.id > (answered.get(m.in_reply_to_id ?? m.id) ?? 0))
      .map((m: any) => ({ kind: 'inline', id: m.id, login: m.user.login, body: m.body, path: m.path, line: m.line,
        thread: m.in_reply_to_id ?? m.id, createdAt: m.created_at })),
    ...reviews.filter((r: any) => r.state === 'COMMENTED' && typeof r.body === 'string' && r.body.trim() && from(r)
      && String(r.submitted_at ?? '') > since)
      .map((r: any) => ({ kind: 'review', id: r.id, login: r.user.login, body: r.body, createdAt: r.submitted_at })),
  ].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id - b.id).slice(-100);
  // Fit the journal: text shrinks first (halving its cap down to a floor),
  // then the oldest comments go. Failing checks and change requests define
  // actionability and are never dropped, only shortened.
  const shape = (text: number) => JSON.stringify({
    headSha: c.head,
    failingChecks: checks.map(r => ({ name: cut(r.name, 200), conclusion: r.conclusion, summary: clip(r.summary, text), url: cut(r.url, 500) })),
    changeRequests: requests.map(r => ({ login: r.user.login, id: r.id, body: clip(r.body, text) })),
    reported,
    comments: recent.map((m: any) => ({
      id: m.id, login: m.user?.login ?? '', association: m.author_association ?? 'NONE', body: clip(m.body, text), createdAt: m.created_at,
    })),
    reviewFeedback: feedback.map((r: any) => ({
      ...r, login: cut(r.login, 100), body: clip(r.body, text), ...(r.path ? { path: cut(r.path, 500) } : {}),
    })),
  });
  let text = 4000, out = shape(text);
  while (Buffer.byteLength(out) > BUDGET && text > 200) out = shape(text = Math.max(200, Math.floor(text / 2)));
  while (Buffer.byteLength(out) > BUDGET && recent.length > 1) { recent = recent.slice(1); out = shape(text); }
  while (Buffer.byteLength(out) > BUDGET && feedback.length > 1) { feedback = feedback.slice(1); out = shape(text); }
  const final = await get(`/pulls/${c.number}`);
  if (final.head?.sha !== c.head) throw new Error('Live PR head moved during signal capture');
  if (Buffer.byteLength(out) > BUDGET) throw new Error('PR signals exceed safe journal output size');
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

/**
 * Converge concurrent reports for one head without a provider claim: every run
 * that posted lists this bot's reports carrying the same marker, and any run
 * whose comment is not the earliest deletes its own. Two racing runs both see
 * both comments, so exactly the lower id survives.
 */
export async function settleReport(c: { owner: string; repo: string; number: number; id: number; botLogin: string; marker: string }): Promise<void> {
  if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN required');
  const api = `https://api.github.com/repos/${c.owner}/${c.repo}`;
  const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' };
  const own: number[] = [];
  for (let page = 1; ; page++) {
    if (page > 50) throw new Error('Pagination exceeded; cannot settle report');
    const res = await fetch(`${api}/issues/${c.number}/comments?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`GitHub GET comments: ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch)) throw new Error('Malformed GitHub list');
    for (const m of batch) {
      if (String(m.user?.login ?? '').toLowerCase() === c.botLogin.toLowerCase() && String(m.body ?? '').includes(c.marker)) own.push(m.id);
    }
    if (batch.length < 100) break;
  }
  if (!own.includes(c.id)) throw new Error('Posted report is not visible; cannot settle');
  const kept = Math.min(...own) === c.id;
  if (!kept) {
    const res = await fetch(`${api}/issues/comments/${c.id}`, { method: 'DELETE', headers });
    if (!res.ok) throw new Error(`GitHub comment DELETE: ${res.status}`);
  }
  process.stdout.write(JSON.stringify({ kept }));
}

/** Prefix a posted report whose claim no longer holds: the comment API has no head or label precondition. */
async function annotateReport(c: { owner: string; repo: string; id: number; note: string }): Promise<void> {
  if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN required');
  const url = `https://api.github.com/repos/${c.owner}/${c.repo}/issues/comments/${c.id}`;
  const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
  const current = await fetch(url, { headers });
  if (!current.ok) throw new Error(`GitHub comment GET: ${current.status}`);
  const res = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ body: `> ${c.note}\n\n${(await current.json()).body}` }) });
  if (!res.ok) throw new Error(`GitHub comment PATCH: ${res.status}`);
}

export async function readSignalsAt(
  f: Ctx, pr: BoundPullRequest, head: string, who: { botLogin: string; author: string; reviewBots: string[]; ownAgents: string[] },
): Promise<Signals> {
  const value = JSON.parse(await f.run(nodeCommand(readSignals, { owner: pr.owner, repo: pr.repo, number: pr.number, head, ...who }), { timeout: '2m' }));
  if (value.headSha !== head) throw new Error('Signals were read for a different head');
  return value;
}

/** Returns the posted comment's id. */
export async function postReport(f: Ctx, pr: BoundPullRequest, body: string): Promise<number> {
  const posted = JSON.parse(await f.run(nodeCommand(postComment, { owner: pr.owner, repo: pr.repo, number: pr.number, body }), { timeout: '2m' }));
  if (!Number.isSafeInteger(posted.id)) throw new Error('GitHub did not return the posted comment id');
  return posted.id;
}

/** True when this run's comment is the one report kept for its head. */
export async function settle(f: Ctx, pr: BoundPullRequest, id: number, botLogin: string, marker: string): Promise<boolean> {
  const value = JSON.parse(await f.run(nodeCommand(settleReport, { owner: pr.owner, repo: pr.repo, number: pr.number, id, botLogin, marker }), { timeout: '2m' }));
  if (typeof value.kept !== 'boolean') throw new Error('Report settlement returned no verdict');
  return value.kept;
}

export async function annotate(f: Ctx, pr: BoundPullRequest, id: number, note: string): Promise<void> {
  await f.run(nodeCommand(annotateReport, { owner: pr.owner, repo: pr.repo, id, note }), { timeout: '2m' });
}
