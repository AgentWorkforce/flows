import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInput, eligible, ready, mergeAllowed, conflictAllowed, editAllowed, reconcile, attribution, notificationKey, retryInfra, publicationDecision } from '../policy.ts';
const sha = 'a'.repeat(40), newer = 'b'.repeat(40);
const config = { owner: 'acme', repo: 'widgets', number: 7, testCommand: 'npm test', approvers: ['alice'], organizations: ['acme'], merge: true, reviewAuthors: ['author'], skipLabels: ['skip'], requiredChecks: ['unit'], botLogin: 'babysitter[bot]' };
const state = () => ({ state: 'open', merged: false, draft: false, headSha: sha, baseSha: newer, headRepo: 'acme/widgets', headRef: 'topic', author: 'author', labels: [], mergeable: true, mergeState: 'clean', checks: [{ name: 'unit', sha, status: 'completed', conclusion: 'success' }], reviews: [{ login: 'alice', sha, state: 'APPROVED', id: 1 }], requestedReviewers: [] });
test('malformed external inputs fail before shell or API', () => {
  for (const value of [null, [], {}, { ...config, number: -1 }, { ...config, number: '7' }, { ...config, owner: 'a/b' }, { ...config, headSha: 'abc' }, { ...config, merge: 'true' }, { ...config, approvers: 'alice' }, { ...config, event: null }, { ...config, event: { action: 'opened', repository: { full_name: 'evil/repo' } } }]) assert.throws(() => parseInput(value), JSON.stringify(value));
  // The head is an optional operator constraint, not a required coordinate:
  // a resident deployment binds whatever head the live read reports.
  assert.equal(parseInput(config).headSha, undefined);
  assert.equal(parseInput({ ...config, headSha: sha }).headSha, sha);
});
test('live skip and author rules fail closed', () => {
  assert.equal(eligible(state(), config), undefined);
  for (const change of [{ state: undefined }, { merged: undefined }, { draft: undefined }, { state: 'closed' }, { merged: true }, { draft: true }, { labels: ['skip'] }, { labels: undefined }, { author: 'mallory' }, { author: undefined }]) assert.ok(eligible({ ...state(), ...change }, config), JSON.stringify(change));
});
test('READY rejects missing pending red conflicts stale heads and missing state', () => {
  assert.equal(ready(state(), config, sha), undefined);
  for (const change of [{ checks: [] }, { checks: undefined }, { mergeable: null }, { mergeable: false }, { mergeState: 'unknown' }, { headSha: newer }, { reviews: undefined }, { requestedReviewers: ['review-bot'] }, { checks: [{ name: 'unit', sha, status: 'in_progress', conclusion: null }] }, { checks: [{ name: 'unit', sha, status: 'completed', conclusion: 'failure' }] }, { checks: [{ name: 'unit', sha: newer, status: 'completed', conclusion: 'success' }] }, { reviews: [{ login: 'alice', sha, state: 'CHANGES_REQUESTED', id: 2 }] }]) assert.ok(ready({ ...state(), ...change }, config, sha), JSON.stringify(change));
});
test('a later comment or pending review cannot hide a standing verdict', () => {
  // GitHub leaves APPROVED and CHANGES_REQUESTED in force until the same
  // reviewer files another verdict or it is dismissed. COMMENTED and PENDING
  // decide nothing and must not supersede the verdict still standing —
  // otherwise a reviewer's follow-up comment silently opens a gate their
  // change request was holding closed.
  const blocked = [{ login: 'alice', sha, state: 'CHANGES_REQUESTED', id: 1 }, { login: 'alice', sha, state: 'COMMENTED', id: 2 }];
  assert.equal(ready({ ...state(), reviews: blocked }, config, sha), 'Changes requested');
  assert.ok(mergeAllowed({ ...state(), reviews: blocked }, config, sha));
  assert.equal(ready({ ...state(), reviews: [...blocked, { login: 'alice', sha, state: 'PENDING', id: 3 }] }, config, sha), 'Changes requested');
  // The same rule in the other direction: a live approval survives its author's
  // later comment, for the merge gate and for a requested reviewer alike.
  const approved = [{ login: 'alice', sha, state: 'APPROVED', id: 1 }, { login: 'alice', sha, state: 'COMMENTED', id: 2 }];
  assert.equal(mergeAllowed({ ...state(), reviews: approved }, config, sha), undefined);
  assert.equal(ready({ ...state(), reviews: approved, requestedReviewers: ['alice'] }, config, sha), undefined);
  // A real later verdict does supersede, both ways, and a dismissal withdraws.
  assert.equal(mergeAllowed({ ...state(), reviews: [...approved, { login: 'alice', sha, state: 'CHANGES_REQUESTED', id: 4 }] }, config, sha), 'Changes requested');
  assert.equal(mergeAllowed({ ...state(), reviews: [...blocked, { login: 'alice', sha, state: 'APPROVED', id: 5 }] }, config, sha), undefined);
  assert.ok(mergeAllowed({ ...state(), reviews: [...approved, { login: 'alice', sha, state: 'DISMISSED', id: 6 }] }, config, sha));
  // A reviewer who only ever commented carries no verdict at all.
  assert.ok(ready({ ...state(), reviews: [{ login: 'alice', sha, state: 'COMMENTED', id: 1 }], requestedReviewers: ['alice'] }, config, sha));
  // Malformed rows still fail closed: an unknown state invalidates the list.
  assert.equal(ready({ ...state(), reviews: [{ login: 'alice', sha, state: 'ENDORSED', id: 1 }] }, config, sha), 'Missing or malformed reviews');
  assert.equal(ready({ ...state(), reviews: [{ login: 'alice', state: 'COMMENTED', id: 1 }] }, config, sha), 'Missing or malformed reviews');
});
test('merge requires opt in org and configured independent approver at exact SHA', () => {
  assert.equal(mergeAllowed(state(), config, sha), undefined);
  for (const c of [{ ...config, merge: false }, { ...config, organizations: [] }, { ...config, approvers: [] }, { ...config, organizations: ['other'] }]) assert.ok(mergeAllowed(state(), c, sha));
  for (const reviews of [[], [{ login: 'alice', sha: newer, state: 'APPROVED', id: 1 }], [{ login: 'mallory', sha, state: 'APPROVED', id: 1 }], [{ login: 'alice', state: 'APPROVED', id: 1 }], [...state().reviews, { login: 'alice', sha, state: 'DISMISSED', id: 2 }]]) assert.ok(mergeAllowed({ ...state(), reviews }, config, sha));
});
test('conflict command is explicit authorized and same repository only', () => {
  assert.equal(conflictAllowed('@relay fix conflicts', 'author', state(), config), undefined);
  for (const [body, login, s] of [['ordinary comment', 'author', state()], ['@relay fix conflicts', 'mallory', state()], ['@relay fix conflicts', 'bot[bot]', state()], ['@relay fix conflicts', 'alice', { ...state(), headRepo: 'fork/widgets' }]] as const) assert.ok(conflictAllowed(body, login, s, config));
});
test('edits fail closed for semantic changes, fork, protected paths, tests and unresolved conflicts', () => {
  const edit = { kind: 'trailing-whitespace', paths: ['README.md'], verified: true, unresolved: false, pushed: false };
  assert.equal(editAllowed(edit, state(), config, sha), undefined);
  for (const change of [{ kind: 'semantic' }, { verified: false }, { unresolved: true }, { paths: ['package.json'] }, { paths: ['tests/a.ts'] }, { paths: ['workflows/review.ts'] }, { paths: ['scripts/test.sh'] }, { paths: ['src/a.ts'] }, { paths: ['../README.md'] }]) assert.ok(editAllowed({ ...edit, ...change }, state(), config, sha));
  assert.ok(editAllowed(edit, { ...state(), headRepo: 'fork/widgets' }, config, sha));
  assert.ok(ready(state(), config, sha, { pushed: true }));
});
test('artifacts are nonempty schema validated exact head and reconcile deterministically', () => {
  const artifacts = ['maintainability', 'history', 'structure'].map(lens => ({ lens, headSha: sha, summary: 'Read diff and callers', findings: [] }));
  assert.equal(reconcile(artifacts, sha).blocking, false);
  for (const value of [[], [null], artifacts.slice(1), [...artifacts, artifacts[0]], artifacts.map(x => ({ ...x, summary: '' })), artifacts.map(x => ({ ...x, headSha: newer }))]) assert.throws(() => reconcile(value, sha));
  const issue = { file: 'src/a.ts', line: 1, severity: 'blocker', message: 'unsafe default', evidence: 'undefined becomes true' };
  artifacts[0]!.findings.push(issue as never);
  assert.equal(reconcile(artifacts, sha).blocking, true);
  assert.deepEqual(reconcile([...artifacts].reverse(), sha), reconcile(artifacts, sha));
});
test('publication refuses stale post race newer verdict spoof and absent atomic capability', () => {
  const request = { expectedSha: sha, liveSha: sha, author: config.botLogin, botLogin: config.botLogin, existingSha: sha, bodyMatches: true, atomic: true };
  assert.equal(publicationDecision(request), 'unchanged');
  assert.equal(publicationDecision({ ...request, bodyMatches: false }), 'update');
  assert.equal(publicationDecision({ ...request, liveSha: newer }), 'stale');
  assert.equal(publicationDecision({ ...request, existingSha: newer }), 'newer-verdict');
  assert.equal(publicationDecision({ ...request, author: 'mallory' }), 'not-owned');
  assert.equal(publicationDecision({ ...request, atomic: false }), 'atomic-publication-unavailable');
});
test('once per head keys and sticky CI attribution survive duplicate wake decisions', () => {
  assert.equal(notificationKey(config, sha), notificationKey(config, sha));
  assert.notEqual(notificationKey(config, sha), notificationKey(config, newer));
  assert.equal(attribution({ priorCiFailing: true, priorHeadSha: sha, currentHeadSha: newer, leftEdits: true, priorOwnedRegression: true }), 'ours');
  assert.equal(attribution({ priorCiFailing: true, priorHeadSha: sha, currentHeadSha: newer, leftEdits: true }), 'pre-existing');
  assert.equal(attribution({ priorCiFailing: false, priorHeadSha: sha, currentHeadSha: newer, leftEdits: true }), 'ours');
  assert.equal(attribution({ priorCiFailing: null, priorHeadSha: null, currentHeadSha: sha, leftEdits: true }), 'unknown');
});
test('one bounded infra retry only for 137/143', async () => {
  for (const code of [0, 1, 137, 143]) { let calls = 0; await retryInfra(async () => { calls++; return { exitCode: code }; }); assert.equal(calls, [137, 143].includes(code) ? 2 : 1); }
});
