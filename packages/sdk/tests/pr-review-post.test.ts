// Exercises workflows/pr-review-post.cjs (this repo's own PR reviewer's
// publisher) against a fake GitHub API, one branch per case, and pins the
// copy embedded in workflows/pr-review.flow.ts to the file.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const SCRIPT = join(ROOT, 'workflows/pr-review-post.cjs');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

interface Comment { id: number; body: string; user: { login: string; type: string }; updated_at: string }
interface Fake {
  comments: Comment[];
  user: { login: string } | null;
  compare: Record<string, 'ahead' | 'behind' | 'identical' | 'diverged' | 404 | 500>;
  rereadStatus: number | null;
  dates: Record<string, string>;
  log: string[];
  nextId: number;
}

let server: Server; let base: string; let fake: Fake; let dir: string;

function body(req: IncomingMessage): Promise<string> {
  return new Promise((res) => { let s = ''; req.on('data', (d) => { s += d; }); req.on('end', () => res(s)); });
}
beforeEach(async () => {
  fake = { comments: [], user: null, compare: {}, dates: {}, log: [], nextId: 100, rereadStatus: null };
  dir = mkdtempSync(join(tmpdir(), 'pr-review-post-'));
  writeFileSync(join(dir, 'body.md'), 'verdict body\n');
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname; const method = req.method ?? 'GET';
    fake.log.push(`${method} ${path}`);
    const json = (code: number, value: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(value === null ? '' : JSON.stringify(value)); };
    if (method === 'GET' && path === '/user') return fake.user ? json(200, fake.user) : json(403, { message: 'Resource not accessible by integration' });
    if (method === 'GET' && path === '/repos/o/r/issues/7/comments') {
      const page = Number(url.searchParams.get('page') ?? '1'); const per = Number(url.searchParams.get('per_page') ?? '100');
      return json(200, fake.comments.slice((page - 1) * per, page * per));
    }
    if (method === 'POST' && path === '/repos/o/r/issues/7/comments') {
      const { body: b } = JSON.parse(await body(req)) as { body: string };
      const c: Comment = { id: fake.nextId++, body: b, user: { login: 'relay[bot]', type: 'Bot' }, updated_at: new Date().toISOString() };
      fake.comments.push(c); return json(201, c);
    }
    const one = path.match(/^\/repos\/o\/r\/issues\/comments\/(\d+)$/);
    if (one) {
      const c = fake.comments.find((x) => x.id === Number(one[1]));
      if (!c) return json(404, { message: 'Not Found' });
      if (method === 'GET') return fake.rereadStatus ? json(fake.rereadStatus, { message: 'x' }) : json(200, c);
      if (method === 'PATCH') { c.body = (JSON.parse(await body(req)) as { body: string }).body; c.updated_at = new Date().toISOString(); return json(200, c); }
      if (method === 'DELETE') { fake.comments = fake.comments.filter((x) => x.id !== c.id); return json(204, null); }
    }
    const cmp = path.match(/^\/repos\/o\/r\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/);
    if (cmp) { const st = fake.compare[`${cmp[1]}...${cmp[2]}`]; return st === undefined || st === 404 ? json(404, { message: 'Not Found' }) : st === 500 ? json(500, { message: 'boom' }) : json(200, { status: st }); }
    const commit = path.match(/^\/repos\/o\/r\/commits\/([0-9a-f]{40})$/);
    if (commit) { const d = fake.dates[commit[1]]; return d ? json(200, { commit: { committer: { date: d } } }) : json(404, { message: 'Not Found' }); }
    return json(500, { message: `unhandled ${method} ${path}` });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address(); base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterEach(() => { server.close(); });

// Async on purpose: a sync spawn would block the loop that serves the fake API.
function run(headSha: string, opts: { token?: string } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT, 'o', 'r', '7', headSha, join(dir, 'body.md')], {
      env: { ...process.env, GITHUB_API: base, GH_TOKEN: opts.token ?? 't' }, encoding: 'utf8', timeout: 10_000,
    }, (error, out, err) => done({ code: error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : (error ? -1 : 0), out, err }));
  });
}
const mark = (sha: string, login?: string) => `<!-- flows-pr-review ${sha}${login ? ` by:${login}` : ''} -->`;
const seed = (sha: string, opts: { login?: string | null; author?: string; text?: string; updated?: string } = {}): Comment => {
  const c: Comment = { id: fake.nextId++, body: `${mark(sha, opts.login === null ? undefined : (opts.login ?? 'relay[bot]'))}\n${opts.text ?? 'old'}`, user: { login: opts.author ?? 'relay[bot]', type: 'Bot' }, updated_at: opts.updated ?? '2026-01-01T00:00:00Z' };
  fake.comments.push(c); return c;
};
const ours = () => fake.comments.filter((c) => c.body.startsWith('<!-- flows-pr-review'));

describe('workflows/pr-review-post.cjs', () => {
  it('is embedded verbatim in the flow', async () => {
    const flow = readFileSync(join(ROOT, 'workflows/pr-review.flow.ts'), 'utf8');
    const m = flow.match(/const POST_SCRIPT = `\n([\s\S]*?)`;/);
    expect(m).not.toBeNull();
    const embedded = m![1].replaceAll('\\`', '`').replaceAll('\\${', '${');
    expect(embedded).toBe(readFileSync(SCRIPT, 'utf8'));
  });
  it('refuses without GH_TOKEN and never touches the API', async () => {
    const r = await run(SHA_A, { token: '' });
    expect(r.code).toBe(1); expect(r.err).toContain('GH_TOKEN'); expect(fake.log).toEqual([]);
  });
  it('posts once with the final marker when /user resolves the identity', async () => {
    fake.user = { login: 'relay[bot]' };
    const r = await run(SHA_A);
    expect(r.code).toBe(0); expect(r.out).toContain('posted comment');
    expect(ours()).toHaveLength(1); expect(ours()[0].body.startsWith(mark(SHA_A, 'relay[bot]') + '\n')).toBe(true);
    expect(fake.log.filter((l) => l.startsWith('PATCH'))).toEqual([]);
  });
  it('posts as pending then stamps the login when /user is refused (installation token)', async () => {
    const r = await run(SHA_A);
    expect(r.code).toBe(0);
    expect(ours()).toHaveLength(1); expect(ours()[0].body.startsWith(mark(SHA_A, 'relay[bot]') + '\n')).toBe(true);
    expect(fake.log.filter((l) => l.startsWith('PATCH'))).toHaveLength(1);
  });
  it('skips when the comment already carries this head', async () => {
    seed(SHA_A);
    const r = await run(SHA_A);
    expect(r.out).toContain('not overwriting'); expect(ours()).toHaveLength(1); expect(ours()[0].body).toContain('\nold');
  });
  it('updates in place when the comment carries an older head (behind)', async () => {
    seed(SHA_A); fake.compare[`${SHA_B}...${SHA_A}`] = 'behind';
    const r = await run(SHA_B);
    expect(r.out).toContain('updated comment'); expect(ours()).toHaveLength(1);
    expect(ours()[0].body).toBe(`${mark(SHA_B, 'relay[bot]')}\nverdict body\n`);
  });
  it('refuses to overwrite a newer head (ahead)', async () => {
    seed(SHA_B, { text: 'newer' }); fake.compare[`${SHA_A}...${SHA_B}`] = 'ahead';
    const r = await run(SHA_A);
    expect(r.out).toContain('not overwriting'); expect(ours()[0].body).toContain('\nnewer');
  });
  it('after a rebase (diverged) the more recently committed head wins', async () => {
    seed(SHA_B, { text: 'rebased-old' }); fake.compare[`${SHA_C}...${SHA_B}`] = 'diverged';
    fake.dates[SHA_B] = '2026-09-18T10:00:00Z'; fake.dates[SHA_C] = '2026-09-18T11:00:00Z';
    expect((await run(SHA_C)).out).toContain('updated comment');
    fake.compare[`${SHA_A}...${SHA_C}`] = 'diverged'; fake.dates[SHA_A] = '2026-09-18T09:00:00Z';
    expect((await run(SHA_A)).out).toContain('not overwriting');
  });
  it('treats an unresolvable head as older (compare 404, commit gone) and overwrites', async () => {
    seed(SHA_B); fake.dates[SHA_A] = '2026-09-18T09:00:00Z'; // SHA_B has no commit → gone
    expect((await run(SHA_A)).out).toContain('updated comment');
  });
  it('a transient compare failure never overwrites', async () => {
    seed(SHA_B, { text: 'keep' }); fake.compare[`${SHA_A}...${SHA_B}`] = 500;
    const r = await run(SHA_A);
    expect(r.code).toBe(0); expect(r.out).toContain('not overwriting'); expect(ours()[0].body).toContain('\nkeep');
  });
  it('a transient re-read stops without POST or PATCH', async () => {
    seed(SHA_A, { text: 'keep' }); fake.compare[`${SHA_B}...${SHA_A}`] = 'behind'; fake.rereadStatus = 502;
    const r = await run(SHA_B);
    expect(r.code).toBe(0); expect(r.out).toContain('transient'); expect(ours()).toHaveLength(1); expect(ours()[0].body).toContain('\nkeep');
    expect(fake.log.filter((l) => /^(POST|PATCH)/.test(l))).toEqual([]);
  });
  it('an unresolvable leftover never wins the dedupe over the resolvable verdict', async () => {
    fake.user = { login: 'relay[bot]' };
    seed(SHA_C, { text: 'gone-head' }); const mine = seed(SHA_A, { text: 'mine' }); // SHA_C: no commit, no compare
    fake.dates[SHA_A] = '2026-09-18T09:00:00Z';
    const r = await run(SHA_A);
    expect(ours()).toHaveLength(1); expect(ours()[0].id).toBe(mine.id); expect(r.out).toContain('not overwriting');
  });
  it('a transient failure while ordering duplicates leaves them for the next wake', async () => {
    fake.user = { login: 'relay[bot]' };
    seed(SHA_B, { text: 'x' }); seed(SHA_A, { text: 'y' }); fake.compare[`${SHA_B}...${SHA_A}`] = 500;
    const r = await run(SHA_A);
    expect(r.code).toBe(0); expect(r.out).toContain('leaving them'); expect(ours()).toHaveLength(2);
    expect(fake.log.filter((l) => /^(DELETE|POST|PATCH)/.test(l))).toEqual([]);
  });
  it('ignores a spoofed marker from another author', async () => {
    const spoof = seed(SHA_A, { login: 'relay[bot]', author: 'mallory', text: 'spoof' });
    const r = await run(SHA_B);
    expect(r.out).toContain('posted comment');
    expect(fake.comments.find((c) => c.id === spoof.id)?.body).toContain('spoof'); // untouched
    expect(ours()).toHaveLength(2);
  });
  it('adopts legacy markers by the same login and converges duplicates, keeping the newest', async () => {
    seed(SHA_A, { login: null, updated: '2026-09-18T08:00:00Z', text: 'legacy-old' });
    const newer = seed(SHA_B, { login: null, updated: '2026-09-18T12:00:00Z', text: 'legacy-newer' });
    fake.compare[`${SHA_A}...${SHA_B}`] = 'ahead'; fake.compare[`${SHA_B}...${SHA_A}`] = 'behind';
    // With an installation token the login is only known after posting, so
    // the script posts, adopts the legacy comments as the same login, and
    // converges on the newest — deleting its own just-posted older verdict.
    const r = await run(SHA_A);
    expect(r.code).toBe(0);
    expect(ours()).toHaveLength(1); expect(ours()[0].id).toBe(newer.id); expect(ours()[0].body).toContain('legacy-newer');
  });
  it('adopts legacy markers directly when /user resolves the identity', async () => {
    fake.user = { login: 'relay[bot]' };
    seed(SHA_A, { login: null, text: 'legacy' }); fake.compare[`${SHA_B}...${SHA_A}`] = 'behind';
    const r = await run(SHA_B);
    expect(r.out).toContain('updated comment'); expect(ours()).toHaveLength(1); expect(ours()[0].body).toBe(`${mark(SHA_B, 'relay[bot]')}\nverdict body\n`);
    expect(fake.log.filter((l) => l.startsWith('POST'))).toEqual([]);
  });
  it('first-scan cleanup keeps the newest head even when an older wake runs last', async () => {
    const newer = seed(SHA_B, { text: 'newer' }); seed(SHA_A, { text: 'older-dup' });
    fake.compare[`${SHA_B}...${SHA_A}`] = 'behind'; fake.compare[`${SHA_A}...${SHA_B}`] = 'ahead';
    const r = await run(SHA_A);
    expect(ours()).toHaveLength(1); expect(ours()[0].id).toBe(newer.id); expect(ours()[0].body).toContain('\nnewer'); expect(r.out).toContain('not overwriting');
  });
  it('stamps the real author login when updating a by:pending comment (identity known)', async () => {
    fake.user = { login: 'relay[bot]' };
    seed(SHA_A, { login: 'pending' }); fake.compare[`${SHA_B}...${SHA_A}`] = 'behind';
    const r = await run(SHA_B);
    expect(r.out).toContain('updated comment'); expect(ours()).toHaveLength(1); expect(ours()[0].body.startsWith(mark(SHA_B, 'relay[bot]') + '\n')).toBe(true);
  });
  it('converges a by:pending orphan to one stamped comment with an installation token', async () => {
    seed(SHA_A, { login: 'pending' }); fake.compare[`${SHA_B}...${SHA_A}`] = 'behind'; fake.compare[`${SHA_A}...${SHA_B}`] = 'ahead';
    const r = await run(SHA_B);
    expect(r.code).toBe(0); expect(ours()).toHaveLength(1); expect(ours()[0].body.startsWith(mark(SHA_B, 'relay[bot]') + '\n')).toBe(true);
  });
  it('re-posts when the comment vanished between scan and write', async () => {
    const c = seed(SHA_A);
    // Delete it on the first re-read: emulate by removing after listing.
    const origComments = fake.comments;
    let listed = false;
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (req.method === 'GET' && (req.url ?? '').startsWith('/repos/o/r/issues/7/comments')) { listed = true; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(origComments)); return; }
      if (listed && req.method === 'GET' && (req.url ?? '') === `/repos/o/r/issues/comments/${c.id}`) { res.writeHead(404); res.end('{}'); return; }
      if (req.method === 'POST') { res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 999, user: { login: 'relay[bot]' } })); return; }
      res.writeHead(500); res.end('{}');
    });
    const r = await run(SHA_B);
    expect(r.code).toBe(0); expect(r.out).toContain('re-posted');
  });
  it('a failed best-effort delete does not stop the verdict', async () => {
    seed(SHA_A, { updated: '2026-09-18T08:00:00Z' }); seed(SHA_A, { updated: '2026-09-18T09:00:00Z' });
    server.removeAllListeners('request'); const comments = fake.comments;
    server.on('request', async (req, res) => {
      const u = req.url ?? '';
      if (req.method === 'DELETE') { res.writeHead(403); res.end('{"message":"no"}'); return; }
      if (req.method === 'GET' && u.startsWith('/repos/o/r/issues/7/comments')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(comments)); return; }
      if (req.method === 'GET' && u.startsWith('/repos/o/r/issues/comments/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(comments[1])); return; }
      if (req.method === 'PATCH') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(comments[1])); return; }
      if (req.method === 'GET' && u.includes('/compare/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'behind' })); return; }
      res.writeHead(500); res.end('{}');
    });
    const r = await run(SHA_B);
    expect(r.code).toBe(0); expect(r.out).toContain('soft-fail DELETE'); expect(r.out).toContain('updated comment');
  });
});
