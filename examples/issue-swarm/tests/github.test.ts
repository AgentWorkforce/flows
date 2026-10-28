import assert from 'node:assert/strict';
import test from 'node:test';
import { blockers, capturePr } from '../issue-swarm.flow.ts';

const head = 'a'.repeat(40);
function github() {
  const meta = { state: 'open', merged: false, draft: false, head: { sha: head, ref: 'issue-1', repo: { full_name: 'acme/widgets' } }, base: { sha: 'b'.repeat(40) }, body: 'Fixes #1', mergeable: true, mergeable_state: 'clean' };
  const calls: string[][] = [];
  const data = new Map<string, unknown>([
    ['check-runs', { check_runs: [{ name: 'test', head_sha: head, status: 'completed', conclusion: 'success' }] }],
    ['statuses', [{ context: 'build', state: 'success' }, { context: 'build', state: 'failure' }]],
    ['reviews', []],
    ['threads', { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }],
  ]);
  let metaReads = 0;
  const gh = async (args: string[]) => {
    calls.push(args);
    const path = args[1]!;
    if (path === 'graphql') return { data: { repository: { pullRequest: { reviewThreads: data.get(args.includes('cursor=next') ? 'threads2' : 'threads') } } } };
    if (path.endsWith('/pulls/1')) { metaReads++; return structuredClone(meta); }
    for (const key of ['check-runs', 'statuses', 'reviews']) {
      if (path.includes(`/${key}?`)) return data.get(path.includes('page=2') ? `${key}2` : key);
    }
    throw new Error(`Unexpected gh args ${args}`);
  };
  return { gh, meta, data, calls, metaReads: () => metaReads };
}

test('captures current-head checks, newest status and final metadata read', async () => {
  const x = github();
  const state = await capturePr(x.gh, 'acme/widgets', 1);
  assert.equal(x.metaReads(), 2);
  assert.equal(state.checks.length, 2);
  assert.deepEqual(blockers(state, head), []);
  assert.equal(state.checks[1]?.conclusion, 'success');
});

test('pages REST checks and GraphQL unresolved threads', async () => {
  const x = github();
  x.data.set('check-runs', { check_runs: Array.from({ length: 100 }, (_, n) => ({ name: `check-${n}`, head_sha: head, status: 'completed', conclusion: 'success' })) });
  x.data.set('check-runs2', { check_runs: [{ name: 'late-failure', head_sha: head, status: 'completed', conclusion: 'failure' }] });
  x.data.set('threads', { nodes: [{ id: 'resolved', isResolved: true, comments: { nodes: [] } }], pageInfo: { hasNextPage: true, endCursor: 'next' } });
  x.data.set('threads2', { nodes: [{ id: 'late-thread', isResolved: false, comments: { nodes: [{ body: 'Fix race', url: 'https://github.com/comment' }] } }], pageInfo: { hasNextPage: false } });
  const state = await capturePr(x.gh, 'acme/widgets', 1);
  assert.equal(state.checks.length, 102);
  assert.match(blockers(state, head).join('\n'), /late-failure.*failure/);
  assert.match(blockers(state, head).join('\n'), /late-thread.*Fix race/);
});

test('a later approval clears a changes-requested review but a comment does not', async () => {
  const x = github();
  x.data.set('reviews', [
    { id: 1, user: { login: 'alice' }, state: 'CHANGES_REQUESTED' },
    { id: 2, user: { login: 'alice' }, state: 'COMMENTED' },
    { id: 3, user: { login: 'bob' }, state: 'CHANGES_REQUESTED' },
    { id: 4, user: { login: 'bob' }, state: 'APPROVED' },
  ]);
  assert.deepEqual((await capturePr(x.gh, 'acme/widgets', 1)).changesRequested, ['alice']);
});

test('rejects changing heads and incomplete GraphQL responses', async () => {
  const x = github();
  await assert.rejects(capturePr(async args => {
    const result: any = await x.gh(args);
    if (x.metaReads() === 2) result.head.sha = 'c'.repeat(40);
    return result;
  }, 'acme/widgets', 1), /changed during/);
  await assert.rejects(capturePr(async args => args[1] === 'graphql' ? { errors: [{ message: 'denied' }] } : x.gh(args), 'acme/widgets', 1), /Incomplete/);
});

test('pending, stale checks, unknown mergeability, blocked state and stale review fail closed', async () => {
  const state = await capturePr(github().gh, 'acme/widgets', 1);
  state.mergeable = null;
  state.mergeState = 'blocked';
  state.checks[0]!.status = 'queued';
  state.checks[1]!.sha = 'f'.repeat(40);
  const reasons = blockers(state, 'e'.repeat(40));
  assert.equal(reasons.length, 5);
  assert.match(reasons.join('\n'), /mergeability unknown/);
  assert.match(reasons.join('\n'), /lacks adversarial GO/);
});

test('GraphQL repeated cursors and REST pagination exhaustion fail closed', async () => {
  const x = github();
  const threads = { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'next' } };
  x.data.set('threads', threads); x.data.set('threads2', threads);
  await assert.rejects(capturePr(x.gh, 'acme/widgets', 1), /pagination incomplete/);
  await assert.rejects(capturePr(async args => args[1]?.includes('/statuses?') ? Array(100).fill({ context: 'test', state: 'success' }) : x.gh(args), 'acme/widgets', 1), /Pagination exceeded/);
});
