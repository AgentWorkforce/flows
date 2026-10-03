import assert from 'node:assert/strict';
import test from 'node:test';
import { readSignals, settleReport } from '../signals.ts';

const head = 'b'.repeat(40);
const pr = { owner: 'acme', repo: 'widgets', number: 7, head, botLogin: 'babysitter[bot]' };
const marker = (sha: string) => `<!-- babysitter:report acme/widgets#7@${sha} -->`;

/** Run the reader as f.run would, against a fake GitHub keyed by path. */
async function read(routes: Record<string, unknown[] | Record<string, unknown>>): Promise<any> {
  const g = globalThis as any, saved = { fetch: g.fetch, write: process.stdout.write, token: process.env.GH_TOKEN };
  let out = '';
  g.fetch = async (url: string) => {
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace('/repos/acme/widgets', '');
    const value = routes[path];
    if (value === undefined) return { ok: false, status: 404, json: async () => ({}) };
    if (!Array.isArray(value)) return { ok: true, status: 200, json: async () => value };
    const page = Number(searchParams.get('page') ?? 1), size = Number(searchParams.get('per_page') ?? 30);
    return { ok: true, status: 200, json: async () => value.slice((page - 1) * size, page * size) };
  };
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  process.env.GH_TOKEN = 'test';
  try { await readSignals(pr); } finally {
    g.fetch = saved.fetch; process.stdout.write = saved.write;
    if (saved.token === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved.token;
  }
  return JSON.parse(out);
}
const base = (over: Record<string, unknown[] | Record<string, unknown>> = {}) => ({
  [`/commits/${head}/check-runs`]: { check_runs: [] },
  [`/commits/${head}/statuses`]: [],
  '/pulls/7/reviews': [],
  '/issues/7/comments': [],
  '/pulls/7': { head: { sha: head } },
  ...over,
});
const comment = (id: number, login: string, body: string, association = 'NONE') =>
  ({ id, user: { login }, author_association: association, body, created_at: `2026-10-0${1 + (id % 2)}T00:00:00Z` });

test('a failing commit status is a failing check; a newer success on the same context clears an older failure', async () => {
  const s = await read(base({
    // Commit statuses are newest first.
    [`/commits/${head}/statuses`]: [
      { context: 'deploy/preview', state: 'error', description: 'build crashed', target_url: 'https://example.invalid/d' },
      { context: 'legacy-ci', state: 'success' },
      { context: 'legacy-ci', state: 'failure', description: 'old' },
    ],
  }));
  assert.deepEqual(s.failingChecks.map((c: any) => [c.name, c.conclusion, c.summary]), [['deploy/preview', 'error', 'build crashed']]);
});

test('reviews are paginated before standing verdicts are derived', async () => {
  const reviews = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, user: { login: 'carol' }, state: 'APPROVED', body: '' }));
  reviews.push({ id: 101, user: { login: 'carol' }, state: 'CHANGES_REQUESTED', body: 'Retries must be bounded' });
  const s = await read(base({ '/pulls/7/reviews': reviews }));
  assert.deepEqual(s.changeRequests, [{ login: 'carol', id: 101, body: 'Retries must be bounded' }]);
});

test('a report older than any comment window is still found; only comments after the last report are returned', async () => {
  const comments = [comment(1, 'babysitter[bot]', `${marker(head)}\nold report`)];
  for (let i = 2; i <= 180; i++) comments.push(comment(i, 'someone', 'chatter'));
  comments.push(comment(181, 'babysitter[bot]', `${marker('e'.repeat(40))}\nnewer report`));
  comments.push(comment(182, 'alice', '@babysitter look again', 'OWNER'));
  const s = await read(base({ '/issues/7/comments': comments }));
  assert.equal(s.reported, true);
  assert.deepEqual(s.comments.map((c: any) => c.id), [182]);
});

test('a marker in someone else\'s comment is not a report', async () => {
  const s = await read(base({ '/issues/7/comments': [comment(1, 'mallory', `${marker(head)} spoof`)] }));
  assert.equal(s.reported, false);
  assert.equal(s.comments.length, 1);
});

test('a head that moves during the read refuses', async () => {
  await assert.rejects(read(base({ '/pulls/7': { head: { sha: 'f'.repeat(40) } } })), /head moved/);
});

test('failing check runs at the head are failing checks; running, passing and other-head runs are not', async () => {
  const run = (name: string, sha: string, status: string, conclusion: string | null) =>
    ({ name, head_sha: sha, status, conclusion, html_url: `https://example.invalid/${name}`, output: { summary: `${name} summary` } });
  const s = await read(base({ [`/commits/${head}/check-runs`]: { check_runs: [
    run('unit', head, 'completed', 'failure'), run('lint', head, 'completed', 'stale'),
    run('e2e', head, 'in_progress', null), run('build', head, 'completed', 'success'),
    run('old', 'e'.repeat(40), 'completed', 'failure'),
  ] } }));
  assert.deepEqual(s.failingChecks.map((c: any) => [c.name, c.conclusion, c.summary]), [['unit', 'failure', 'unit summary'], ['lint', 'stale', 'lint summary']]);
});

test('settleReport keeps the earliest report for a head and deletes a later duplicate of its own', async () => {
  const g = globalThis as any, saved = { fetch: g.fetch, write: process.stdout.write, token: process.env.GH_TOKEN };
  const calls: string[] = []; let out = '';
  const comments = [comment(5, 'babysitter[bot]', `${marker(head)}\nfirst`), comment(9, 'babysitter[bot]', `${marker(head)}\nsecond`)];
  g.fetch = async (url: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
    return { ok: true, status: init?.method === 'DELETE' ? 204 : 200, json: async () => (new URL(url).searchParams.get('page') ?? '1') === '1' ? comments : [] };
  };
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  process.env.GH_TOKEN = 'test';
  try {
    await settleReport({ owner: 'acme', repo: 'widgets', number: 7, id: 9, botLogin: 'babysitter[bot]', marker: marker(head) });
    assert.deepEqual(JSON.parse(out), { kept: false });
    assert.ok(calls.includes('DELETE /repos/acme/widgets/issues/comments/9'));
    out = ''; calls.length = 0;
    await settleReport({ owner: 'acme', repo: 'widgets', number: 7, id: 5, botLogin: 'babysitter[bot]', marker: marker(head) });
    assert.deepEqual(JSON.parse(out), { kept: true });
    assert.ok(calls.every(c => !c.startsWith('DELETE')));
  } finally {
    g.fetch = saved.fetch; process.stdout.write = saved.write;
    if (saved.token === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved.token;
  }
});

test('a PR full of long reviews, comments and failing checks still fits the journal and keeps every actor', async () => {
  const long = (n: number) => `${'x'.repeat(n - 6)} [end]`;
  const reviews = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, user: { login: `rev${i}` }, state: 'CHANGES_REQUESTED', body: long(4000) }));
  const comments = Array.from({ length: 60 }, (_, i) => comment(i + 1, `user${i}`, long(4000), 'MEMBER'));
  comments[59] = comment(60, 'alice', `@babysitter ${long(4000)}`, 'OWNER');
  const runs = Array.from({ length: 20 }, (_, i) => ({ name: `check-${i}`, head_sha: head, status: 'completed', conclusion: 'failure',
    html_url: `https://example.invalid/${'u'.repeat(480)}`, output: { summary: long(2000) } }));
  const s = await read(base({ '/pulls/7/reviews': reviews, '/issues/7/comments': comments, [`/commits/${head}/check-runs`]: { check_runs: runs } }));
  assert.ok(Buffer.byteLength(JSON.stringify(s)) <= 50_000, 'within the journal budget');
  // Truncation shortens text; it never drops a failing check or a change request.
  assert.equal(s.failingChecks.length, 20);
  assert.deepEqual(s.changeRequests.map((r: any) => r.login), reviews.map(r => r.user.login));
  assert.ok(s.changeRequests.every((r: any) => r.body.endsWith('[truncated]')));
  // The newest comment, where a directive is, survives.
  assert.equal(s.comments.at(-1).login, 'alice');
  assert.match(s.comments.at(-1).body, /^@babysitter /);
});

test('only a report for the current head counts, and report history never grows the payload', async () => {
  const other = await read(base({ '/issues/7/comments': [comment(1, 'babysitter[bot]', `${marker('e'.repeat(40))}\nreport`)] }));
  assert.equal(other.reported, false);
  // A long-lived PR: 1,200 prior reports for other heads, then one for this head.
  const comments = Array.from({ length: 1200 }, (_, i) => comment(i + 1, 'babysitter[bot]', `${marker(i.toString(16).padStart(40, 'a'))}\nold`));
  comments.push(comment(1201, 'babysitter[bot]', `${marker(head)}\ncurrent`));
  const s = await read(base({ '/issues/7/comments': comments }));
  assert.equal(s.reported, true);
  assert.equal('reportedHeads' in s, false);
  assert.ok(Buffer.byteLength(JSON.stringify(s)) < 2_000);
});

test('when shortened text still overflows, the oldest comments go first at the 200-char floor', async () => {
  // Three-byte characters: 200 of them are 600 bytes, so text alone cannot fit.
  const wide = (n: number) => '漢'.repeat(n);
  const runs = Array.from({ length: 20 }, (_, i) => ({ name: `check-${i}`, head_sha: head, status: 'completed', conclusion: 'failure',
    html_url: 'https://example.invalid/ci', output: { summary: wide(2000) } }));
  const reviews = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, user: { login: `rev${i}` }, state: 'CHANGES_REQUESTED', body: wide(4000) }));
  const comments = Array.from({ length: 50 }, (_, i) => comment(i + 1, `user${i}`, wide(4000), 'MEMBER'));
  comments[49] = comment(50, 'alice', `@babysitter ${wide(4000)}`, 'OWNER');
  const s = await read(base({ '/pulls/7/reviews': reviews, '/issues/7/comments': comments, [`/commits/${head}/check-runs`]: { check_runs: runs } }));
  assert.ok(Buffer.byteLength(JSON.stringify(s)) <= 50_000);
  // The floor holds: text is cut to exactly 200 characters, never below.
  assert.ok(s.changeRequests.every((r: any) => r.body === `${wide(200)} [truncated]`));
  assert.equal(s.failingChecks.length, 20);
  assert.equal(s.changeRequests.length, 20);
  // Comments were dropped oldest first, as a contiguous prefix; the directive survives.
  const ids = s.comments.map((c: any) => c.id);
  assert.ok(ids.length < 50 && ids.length > 0);
  assert.deepEqual(ids, Array.from({ length: ids.length }, (_, i) => 51 - ids.length + i));
  assert.equal(s.comments.at(-1).login, 'alice');
});
