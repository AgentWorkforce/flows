import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { getFlowDefinition } from '@relayflows/surface/runtime';
import babysitter, { babysit } from '../babysitter.flow.ts';
import { mergeExact } from '../github.ts';
import type { Ctx } from '@relayflows/surface';
const sha = 'a'.repeat(40);
const config = { owner: 'acme', repo: 'widgets', number: 7, headSha: sha, testCommand: 'npm test', botLogin: 'babysitter[bot]', merge: true, approvers: ['alice'], organizations: ['acme'], reviewAuthors: [], skipLabels: [], requiredChecks: ['unit'] };
const state = { state: 'open', merged: false, draft: false, headSha: sha, baseSha: 'b'.repeat(40), headRepo: 'acme/widgets', author: 'author', labels: [], mergeable: true, mergeState: 'clean', checks: [{ name: 'unit', sha, status: 'completed', conclusion: 'success' }], reviews: [{ login: 'alice', sha, state: 'APPROVED', id: 1 }], requestedReviewers: [] };
function context(live: unknown = state) {
  const commands: string[] = [], reasons: string[] = [];
  let agents = 0;
  const f = { run: async (command: string) => { commands.push(command); return command.startsWith('node -e') ? JSON.stringify(live) : ''; }, done: (reason: string) => { reasons.push(reason); }, agent: () => { agents++; throw new Error('unsafe agent dispatch'); } } as unknown as Ctx;
  return { f, commands, reasons, agents: () => agents };
}
test('seven real wake handlers and both compatibility entries use one implementation', () => {
  const d = getFlowDefinition(babysitter);
  assert.equal(d.name, 'Babysitter'); assert.equal(d.handlers.length, 7);
  for (const h of d.handlers) assert.equal(h.body, babysit);
  assert.match(readFileSync(new URL('../../../workflows/pr-review.flow.ts', import.meta.url), 'utf8'), /babysitter\/babysitter.flow.ts/);
  assert.match(readFileSync(new URL('../../pr-reviewer/pr-reviewer.flow.ts', import.meta.url), 'utf8'), /babysitter\/babysitter.flow.ts/);
});
test('malformed input makes zero effects; missing live state declines before agents', async () => {
  const x = context(); await assert.rejects(babysit(x.f, null)); assert.equal(x.commands.length, 0);
  const y = context({}); await babysit(y.f, config); assert.deepEqual(y.reasons, ['declined']); assert.equal(y.agents(), 0);
});
test('duplicate delivery cannot bypass missing publication or agent-scope capability', async () => {
  const x = context(); await babysit(x.f, config); await babysit(x.f, config);
  assert.deepEqual(x.reasons, ['needs_human', 'needs_human']); assert.equal(x.agents(), 0);
  assert.ok(x.commands.every(c => !/curl|git push/.test(c)));
});
test('exact-head review/check wakes evaluate merge but do not simulate an unavailable receipt', async () => {
  for (const event of [
    { action: 'submitted', repository: { full_name: 'acme/widgets' }, pull_request: { number: 7, head: { sha } }, review: { state: 'approved' } },
    { action: 'completed', repository: { full_name: 'acme/widgets' }, check_run: { head_sha: sha, pull_requests: [{ number: 7 }] } },
  ]) {
    const x = context(); await babysit(x.f, { ...config, event });
    assert.deepEqual(x.reasons, ['needs_human']); assert.ok(x.commands.every(c => !c.includes('curl')));
  }
});
test('authorized conflict wakes hand off unresolved semantic work; ordinary/unauthorized comments decline', async () => {
  for (const [body, login, expected] of [['@relay fix conflicts', 'author', 'needs_human'], ['hello', 'author', 'declined'], ['@relay fix conflicts', 'mallory', 'declined']]) {
    const x = context(); await babysit(x.f, { ...config, event: { action: 'created', repository: { full_name: 'acme/widgets' }, issue: { number: 7, pull_request: {} }, comment: { body, user: { login } } } });
    assert.deepEqual(x.reasons, [expected]); assert.equal(x.agents(), 0);
  }
});
test('merge transport sends exact SHA and fails if provider does not confirm', async () => {
  const commands: string[] = [];
  const f = { run: async (command: string) => { commands.push(command); return '{"merged":true}'; } } as unknown as Ctx;
  await mergeExact(f, config);
  assert.ok(commands[0]!.includes(`"sha":"${sha}"`)); assert.ok(commands[0]!.includes('/pulls/7/merge'));
  await assert.rejects(mergeExact({ run: async () => '{"merged":false}' } as unknown as Ctx, config), /did not confirm/);
});
test('exact-head end-to-end review and merge acceptance remains RED', { todo: 'Requires enforced agent scopes and durable fenced publication; the passing merge transport unit test is not end-to-end acceptance' }, async () => {
  const x = context(); await babysit(x.f, config);
  assert.deepEqual(x.reasons, ['success']);
});
