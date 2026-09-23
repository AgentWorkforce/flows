import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { getFlowDefinition } from '@relayflows/surface/runtime';
import { webhook, type TriggerSource, type WebhookTriggerSource } from '@relayflows/surface';
// The real author-time provider contract the SDK runs, imported from source so
// this suite refuses exactly what `flows check` and ingress would refuse. Its
// only runtime dependency is the surface's generated registry.
import { preflightProviderTriggers } from '../../../packages/sdk/src/provider-trigger-contract.ts';
import babysitter, { babysit } from '../babysitter.flow.ts';
import { subscriptions, subscriptionIds, requiredExecutors } from '../subscriptions.ts';
import { parseInput } from '../input.ts';
import { wakeOf, bindHead, decisionKey, observation, hintStaleness } from '../wake.ts';
import { liveness, unhealthy, livenessReport } from '../liveness.ts';
import type { Ctx } from '@relayflows/surface';

const sha = 'a'.repeat(40), newer = 'b'.repeat(40), older = 'c'.repeat(40);
const config = {
  owner: 'acme', repo: 'widgets', number: 7, testCommand: 'npm test', botLogin: 'babysitter[bot]',
  merge: true, approvers: ['alice'], organizations: ['acme'], reviewAuthors: [], skipLabels: ['skip'], requiredChecks: ['unit'],
};
const open = (head: string) => ({
  state: 'open', merged: false, draft: false, headSha: head, baseSha: 'd'.repeat(40), headRepo: 'acme/widgets',
  author: 'author', labels: [], mergeable: true, mergeState: 'clean',
  checks: [{ name: 'unit', sha: head, status: 'completed', conclusion: 'success' }],
  reviews: [{ login: 'alice', sha: head, state: 'APPROVED', id: 1 }], requestedReviewers: [],
});
const repository = { full_name: 'acme/widgets' };

/** Records every command a wake issues so two wakes can be compared exactly. */
function context(live: unknown) {
  const commands: string[] = [], reasons: string[] = [];
  let agents = 0;
  const f = {
    run: async (command: string) => { commands.push(command); return command.startsWith('node -e') ? JSON.stringify(live) : ''; },
    done: (reason: string) => { reasons.push(reason); },
    agent: () => { agents++; throw new Error('unsafe agent dispatch'); },
  } as unknown as Ctx;
  return { f, commands, reasons, agents: () => agents };
}

const events = {
  opened: { action: 'opened', repository, pull_request: { number: 7, head: { sha } } },
  synchronize: (head: string) => ({ action: 'synchronize', repository, pull_request: { number: 7, head: { sha: head } } }),
  closed: { action: 'closed', repository, pull_request: { number: 7, head: { sha } } },
  ready: { action: 'ready_for_review', repository, pull_request: { number: 7, head: { sha } } },
  reopened: { action: 'reopened', repository, pull_request: { number: 7, head: { sha } } },
  labeled: { action: 'labeled', repository, pull_request: { number: 7, head: { sha } }, label: { name: 'skip' } },
  unlabeled: { action: 'unlabeled', repository, pull_request: { number: 7, head: { sha } }, label: { name: 'skip' } },
  submitted: { action: 'submitted', repository, pull_request: { number: 7, head: { sha } }, review: { state: 'approved' } },
  dismissed: { action: 'dismissed', repository, pull_request: { number: 7, head: { sha } }, review: { state: 'dismissed' } },
  completed: { action: 'completed', repository, check_run: { head_sha: sha, pull_requests: [{ number: 7 }] } },
  created: { action: 'created', repository, issue: { number: 7, pull_request: {} }, comment: { body: 'hello', user: { login: 'author' } } },
} as const;

// ---------------------------------------------------------------- binding

test('the declared subscription contract is exactly the required resident set', () => {
  assert.deepEqual([...subscriptionIds], [
    'pull_request.opened', 'pull_request.synchronize', 'pull_request.reopened',
    'pull_request.ready_for_review', 'pull_request.closed',
    'pull_request.labeled', 'pull_request.unlabeled',
    'pull_request_review.submitted', 'pull_request_review.dismissed',
    'check_run.completed', 'issue_comment.created',
  ]);
  // Every lifecycle, review, check, policy and repair reason is represented.
  assert.deepEqual([...new Set(subscriptions.map(s => s.purpose))].sort(), ['checks', 'lifecycle', 'policy', 'repair', 'review']);
  assert.ok(subscriptions.every(s => s.why.trim().length > 0));
});

test('every declared subscription registers one handler bound to the one body', () => {
  const d = getFlowDefinition(babysitter);
  assert.equal(d.name, 'Babysitter');
  assert.equal(d.handlers.length, subscriptions.length);
  for (const handler of d.handlers) assert.equal(handler.body, babysit);
  // Registration order is the declaration order, so the flow cannot subscribe
  // to something the validator and the liveness sweep do not know about.
  assert.deepEqual(d.handlers.map(h => h.trigger), subscriptions.map(s => s.trigger));
});

test('each trigger filters to its own provider, type and action', () => {
  const d = getFlowDefinition(babysitter);
  for (const [index, subscription] of subscriptions.entries()) {
    const trigger = d.handlers[index]!.trigger as WebhookTriggerSource;
    assert.equal(trigger.kind, 'webhook');
    assert.equal(trigger.name, 'github');
    assert.deepEqual(trigger.filter, { provider: 'github', type: subscription.family, payload: { action: subscription.action } });
  }
  // Distinct filters: two subscriptions that matched the same deliveries would
  // double every wake and make the liveness sweep unable to tell them apart.
  const filters = d.handlers.map(h => JSON.stringify((h.trigger as WebhookTriggerSource).filter));
  assert.equal(new Set(filters).size, filters.length);
});

test('compatibility entry points still resolve to this one implementation', () => {
  assert.match(readFileSync(new URL('../../../workflows/pr-review.flow.ts', import.meta.url), 'utf8'), /babysitter\/babysitter.flow.ts/);
  assert.match(readFileSync(new URL('../../pr-reviewer/pr-reviewer.flow.ts', import.meta.url), 'utf8'), /babysitter\/babysitter.flow.ts/);
});

// -------------------------------------------------------------- preflight

test('subscription preflight passes the declared contract and has teeth', () => {
  const declared = getFlowDefinition(babysitter).handlers.map(h => h.trigger);
  // (a) Deliverable: every declared type is one GitHub actually publishes.
  assert.deepEqual(preflightProviderTriggers(declared), []);
  // (b) Registered: mirrors `preflightWebhookTriggers`, which refuses any
  // webhook inbox absent from flows.json with kind `no_executor`.
  const executors: string[] = JSON.parse(readFileSync(new URL('../flows.json', import.meta.url), 'utf8')).executors;
  for (const inbox of requiredExecutors) assert.ok(executors.includes(inbox), `flows.json must register the "${inbox}" executor`);
  const unregistered = [...new Set(declared.map(t => t.name))].filter(name => !executors.includes(name));
  assert.deepEqual(unregistered, []);
});

test('preflight refuses an undeliverable subscription rather than deploying it', () => {
  // A type GitHub does not publish: accepted by the type system, matched by no
  // delivered event, and refused here instead of at ingress after deployment.
  const invented = webhook('github', { provider: 'github', type: 'pull_request.merged', payload: { action: 'merged' } }) as TriggerSource;
  const refusals = preflightProviderTriggers([invented]);
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0]!.severity, 'refusal');
  assert.match(refusals[0]!.message, /does not publish/);
  // And an unregistered inbox is refused by registration, not silently ignored.
  const executors: string[] = JSON.parse(readFileSync(new URL('../flows.json', import.meta.url), 'utf8')).executors;
  assert.ok(!executors.includes('gitlab'));
});

// ------------------------------------------------- wake hints are only hints

test('a delivery is accepted as a hint; only routing is enforced', () => {
  for (const [name, event] of Object.entries(events)) {
    const value = typeof event === 'function' ? event(sha) : event;
    assert.equal(parseInput({ ...config, event: value }).event, value, name);
  }
  // Routing failures are misroutes, not staleness: refuse them outright.
  for (const event of [
    { ...events.opened, repository: { full_name: 'evil/repo' } },
    { ...events.opened, pull_request: { number: 9, head: { sha } } },
    { action: 'completed', repository, check_run: { head_sha: sha, pull_requests: [{ number: 9 }] } },
    { action: 'created', repository, issue: { number: 7 }, comment: { body: 'hi', user: { login: 'a' } } },
    { action: 'opened', repository },
  ]) assert.throws(() => parseInput({ ...config, event }), JSON.stringify(event));
  // Undeclared actions are refused: no silent "some other event" branch.
  for (const action of ['assigned', 'edited', 'locked', '']) {
    assert.throws(() => parseInput({ ...config, event: { ...events.opened, action } }), /Unsubscribed|no declared/);
  }
  // Malformed bodies for the families that carry one.
  for (const event of [
    { action: 'submitted', repository, pull_request: { number: 7, head: { sha } }, review: {} },
    { action: 'labeled', repository, pull_request: { number: 7, head: { sha } }, label: {} },
    { action: 'created', repository, issue: { number: 7, pull_request: {} }, comment: { body: '', user: { login: 'a' } } },
  ]) assert.throws(() => parseInput({ ...config, event }), JSON.stringify(event));
});

test('a fork check_run with no PR attribution still wakes and rereads', async () => {
  // GitHub leaves `check_run.pull_requests` empty for pull requests from forks.
  // Repository routing has already succeeded at that point; whether the check
  // belongs to the pinned PR is a live-state question, and refusing the wake is
  // exactly how fork CI goes unnoticed forever.
  const forked = { action: 'completed', repository, check_run: { head_sha: sha, pull_requests: [] } };
  assert.equal(parseInput({ ...config, event: forked }).event, forked);
  assert.equal(wakeOf(parseInput({ ...config, event: forked })).id, 'check_run.completed');
  assert.doesNotThrow(() => parseInput({ ...config, event: { action: 'completed', repository, check_run: { head_sha: sha } } }));
  // It is a hint, so the decision still comes from the reread and nothing else.
  const x = context(open(sha));
  await babysit(x.f, { ...config, skipLabels: [], event: forked });
  assert.ok(x.commands[0]!.startsWith('node -e'));
  assert.ok(x.commands[1]!.includes(`wake check_run.completed`) && x.commands[1]!.includes(`bind=${sha}`));
  assert.deepEqual(x.reasons, ['needs_human']);
  // A check_run that names other PRs and not ours is genuinely misrouted.
  assert.throws(() => parseInput({ ...config, event: { action: 'completed', repository, check_run: { head_sha: sha, pull_requests: [{ number: 9 }] } } }), /does not identify/);
});

test('repository routing compares owner and repository case-insensitively', () => {
  // GitHub owner and repository names are case-insensitive, and every other
  // babysitter comparison already lowercases them. An exact-case compare here
  // rejects every delivery for a repository the operator spelled differently.
  for (const full_name of ['AcMe/Widgets', 'ACME/WIDGETS', 'acme/widgets']) {
    assert.doesNotThrow(() => parseInput({ ...config, event: { ...events.opened, repository: { full_name } } }), full_name);
  }
  assert.doesNotThrow(() => parseInput({ ...config, owner: 'AcMe', repo: 'Widgets', event: events.opened }));
  // A different repository is still refused, whatever its casing.
  for (const full_name of ['acme/gadgets', 'other/widgets', 'acmewidgets', '']) {
    assert.throws(() => parseInput({ ...config, event: { ...events.opened, repository: { full_name } } }), /differs from pinned repository/, full_name);
  }
});

test('a stale hinted head is recorded, never enforced, and never binds', () => {
  // The delivery was born on an older head; live state has moved on.
  const c = parseInput({ ...config, event: events.synchronize(older) });
  const wake = wakeOf(c);
  assert.equal(wake.id, 'pull_request.synchronize');
  assert.equal(wake.hintedSha, older);
  const bound = bindHead(open(newer), c);
  assert.deepEqual(bound, { head: newer });
  assert.equal(hintStaleness(wake, newer), 'stale-hint');
  // The observation says so out loud; the bound head is the live one.
  assert.equal(observation(c, wake, bound), `wake pull_request.synchronize hint=stale-hint bind=${newer} key=babysitter:pull_request.synchronize:acme/widgets#7@${newer}`);
});

test('an operator pin constrains the run; it never substitutes for live state', () => {
  const pinned = parseInput({ ...config, headSha: sha });
  assert.deepEqual(bindHead(open(sha), pinned), { head: sha });
  assert.deepEqual(bindHead(open(newer), pinned), { refusal: `Operator pin ${sha} is no longer the live head ${newer}` });
  // Unpinned — the resident default — binds whatever live state reports.
  const resident = parseInput(config);
  assert.equal(resident.headSha, undefined);
  assert.deepEqual(bindHead(open(newer), resident), { head: newer });
  // No live head at all is a refusal to act, not a fallback to the hint.
  for (const broken of [{}, { headSha: 'abc' }, { headSha: null }]) {
    assert.ok('refusal' in bindHead(broken, resident), JSON.stringify(broken));
  }
});

test('every wake rereads live state before it decides anything', async () => {
  for (const event of [events.opened, events.closed, events.labeled, events.submitted, events.completed, events.created]) {
    const x = context(open(sha));
    await babysit(x.f, { ...config, skipLabels: [], event });
    // The first command of every wake is the authoritative read.
    assert.ok(x.commands[0]!.startsWith('node -e'), event.action);
    assert.ok(x.commands[0]!.includes('api.github.com'), event.action);
    // And it carries no head: the read discovers one, it is not told one.
    assert.ok(!x.commands[0]!.includes(sha), event.action);
  }
});

// --------------------------------------------- stale payload vs live state

test('a payload that disagrees with live state loses: closed hint, open PR', async () => {
  // The hint says the PR closed. Live state says it is open and green. The run
  // proceeds on live state, because a payload is not evidence.
  const x = context(open(sha));
  await babysit(x.f, { ...config, skipLabels: [], event: events.closed });
  assert.deepEqual(x.reasons, ['needs_human']);
  assert.ok(x.commands.some(c => c.includes('enforce agent workspace and credential scopes')));
});

test('a payload that disagrees with live state loses: open hint, closed PR', async () => {
  // The mirror image, and the one that matters for safety: an `opened` hint
  // cannot resurrect a PR that live state reports merged.
  const x = context({ ...open(sha), state: 'closed', merged: true });
  await babysit(x.f, { ...config, event: events.opened });
  assert.deepEqual(x.reasons, ['declined']);
  assert.equal(x.agents(), 0);
  assert.ok(x.commands.some(c => c.includes('PR is closed, merged, draft or missing live state')));
});

test('a label hint is re-read from live state in both directions', async () => {
  // Hint claims the skip label was added; live labels do not carry it.
  const added = context({ ...open(sha), labels: [] });
  await babysit(added.f, { ...config, event: events.labeled });
  assert.deepEqual(added.reasons, ['needs_human']);
  // Hint claims the skip label was removed; live labels still carry it.
  const removed = context({ ...open(sha), labels: ['skip'] });
  await babysit(removed.f, { ...config, event: events.unlabeled });
  assert.deepEqual(removed.reasons, ['declined']);
  assert.ok(removed.commands.some(c => c.includes('Skip label')));
  assert.equal(removed.agents(), 0);
});

test('a review hint cannot assert an approval live state does not show', async () => {
  // The payload says "approved". Live reviews show a dismissal at this head, so
  // the merge gate holds — the verdict came from the reread, not the delivery.
  const x = context({ ...open(sha), reviews: [{ login: 'alice', sha, state: 'DISMISSED', id: 2 }] });
  await babysit(x.f, { ...config, skipLabels: [], event: events.submitted });
  assert.deepEqual(x.reasons, ['declined']);
  assert.ok(x.commands.every(c => !c.includes('curl')));
  // A dismissed hint over a live approval is the mirror case and passes the gate.
  const y = context(open(sha));
  await babysit(y.f, { ...config, skipLabels: [], event: events.dismissed });
  assert.deepEqual(y.reasons, ['needs_human']);
  assert.ok(y.commands.every(c => !c.includes('curl')));
});

test('a check hint cannot assert a conclusion live state does not show', async () => {
  const x = context({ ...open(sha), checks: [{ name: 'unit', sha, status: 'completed', conclusion: 'failure' }] });
  await babysit(x.f, { ...config, skipLabels: [], event: events.completed });
  assert.deepEqual(x.reasons, ['declined']);
  assert.ok(x.commands.some(c => c.includes('Checks are missing, stale, pending or red')));
});

// ----------------------------------------- duplicate and out-of-order wakes

test('duplicate delivery repeats a decision instead of adding one', async () => {
  const first = context(open(sha));
  await babysit(first.f, { ...config, skipLabels: [], event: events.submitted });
  const second = context(open(sha));
  await babysit(second.f, { ...config, skipLabels: [], event: events.submitted });
  // Byte-identical command streams: no second effect, no drift.
  assert.deepEqual(second.commands, first.commands);
  assert.deepEqual(second.reasons, first.reasons);
  assert.deepEqual(first.reasons, ['needs_human']);
  assert.ok(first.commands.every(c => !/curl|git push/.test(c)));
  // Replayed in the same run, the decision is still one decision.
  const replay = context(open(sha));
  await babysit(replay.f, { ...config, skipLabels: [], event: events.submitted });
  await babysit(replay.f, { ...config, skipLabels: [], event: events.submitted });
  assert.deepEqual(replay.reasons, ['needs_human', 'needs_human']);
  assert.deepEqual(replay.commands.slice(0, first.commands.length), first.commands);
  assert.deepEqual(replay.commands.slice(first.commands.length), first.commands);
});

test('out-of-order delivery decides about the head that exists now', async () => {
  // A synchronize for an older head is delivered after the newer head landed.
  const late = context(open(newer));
  await babysit(late.f, { ...config, skipLabels: [], event: events.synchronize(older) });
  // A synchronize for the current head, delivered in order.
  const ordered = context(open(newer));
  await babysit(ordered.f, { ...config, skipLabels: [], event: events.synchronize(newer) });
  assert.deepEqual(late.reasons, ordered.reasons);
  // Both bind the live head. Only the recorded hint staleness differs, which is
  // the point: the observation is honest about lateness without acting on it.
  assert.ok(late.commands[1]!.includes(`bind=${newer}`) && late.commands[1]!.includes('hint=stale-hint'));
  assert.ok(ordered.commands[1]!.includes(`bind=${newer}`) && ordered.commands[1]!.includes('hint=bound'));
  assert.ok(!late.commands.some(c => c.includes(older)));
});

test('the decision key names the subscription and the live head, never the hint', () => {
  const c = parseInput({ ...config, event: events.synchronize(older) });
  const wake = wakeOf(c);
  assert.equal(decisionKey(c, wake, newer), `babysitter:pull_request.synchronize:acme/widgets#7@${newer}`);
  // Same subscription, same live head, two deliveries: one key.
  const duplicate = wakeOf(parseInput({ ...config, event: events.synchronize(newer) }));
  assert.equal(decisionKey(c, duplicate, newer), decisionKey(c, wake, newer));
  // Different heads are different decisions; different subscriptions are too.
  assert.notEqual(decisionKey(c, wake, sha), decisionKey(c, wake, newer));
  assert.notEqual(decisionKey(c, wakeOf(parseInput({ ...config, event: events.completed })), newer), decisionKey(c, wake, newer));
});

// ------------------------------------------------- liveness observability

test('each wake emits one deterministic observation line', async () => {
  const x = context(open(sha));
  await babysit(x.f, { ...config, skipLabels: [], event: events.completed });
  const line = x.commands[1]!;
  assert.ok(line.startsWith('printf'));
  assert.ok(line.includes('wake check_run.completed'));
  assert.ok(line.includes(`bind=${sha}`));
  assert.ok(line.includes('hint=bound'));
  // A refusal to bind is observable as such, with its reason, before the decline.
  const blind = context({});
  await babysit(blind.f, { ...config, event: events.completed });
  assert.deepEqual(blind.reasons, ['declined']);
  assert.ok(blind.commands[1]!.includes('bind=refused'));
  assert.ok(blind.commands[1]!.includes('No authoritative live head'));
});

test('the sweep separates a quiet subscription from a dead one', () => {
  const hour = 3_600_000;
  const window = { nowMs: 10 * hour, sinceMs: 0, staleAfterMs: 2 * hour };
  const wakes = subscriptionIds.map((subscription, index) => ({ subscription, atMs: index === 0 ? 1 * hour : 9 * hour }));
  const report = liveness(wakes, window);
  assert.deepEqual(report.map(r => r.subscription), [...subscriptionIds]);
  assert.equal(report[0]!.status, 'stale');
  assert.equal(report[0]!.ageMs, 9 * hour);
  assert.ok(report.slice(1).every(r => r.status === 'live'));
  assert.deepEqual(unhealthy(report).map(r => r.subscription), [subscriptionIds[0]]);
  // Only the latest wake per subscription counts, and order of records does not.
  assert.deepEqual(liveness([...wakes].reverse(), window), report);
  assert.deepEqual(liveness([...wakes, { subscription: subscriptionIds[0]!, atMs: 3 * hour }], window)[0]!.ageMs, 7 * hour);
});

test('a young subscription is pending, an old silent one is never', () => {
  const hour = 3_600_000;
  const young = liveness([], { nowMs: hour, sinceMs: 0, staleAfterMs: 2 * hour });
  assert.ok(young.every(r => r.status === 'pending' && r.lastWakeMs === null));
  assert.deepEqual(unhealthy(young), []);
  const old = liveness([], { nowMs: 10 * hour, sinceMs: 0, staleAfterMs: 2 * hour });
  assert.ok(old.every(r => r.status === 'never'));
  assert.equal(unhealthy(old).length, subscriptionIds.length);
  assert.match(livenessReport(old), /11 of 11 unaccounted for/);
  assert.match(livenessReport(young), /all declared subscriptions accounted for/);
  // Same window, same bytes.
  assert.equal(livenessReport(old), livenessReport(liveness([], { nowMs: 10 * hour, sinceMs: 0, staleAfterMs: 2 * hour })));
});

test('the sweep refuses impossible windows and clock-faulted records', () => {
  const window = { nowMs: 1000, sinceMs: 0, staleAfterMs: 100 };
  for (const broken of [
    { ...window, staleAfterMs: 0 }, { ...window, staleAfterMs: -1 },
    { ...window, sinceMs: 2000 }, { ...window, nowMs: Number.NaN },
  ]) assert.throws(() => liveness([], broken), JSON.stringify(broken));
  assert.throws(() => liveness([{ subscription: 'pull_request.opened', atMs: Number.NaN }], window));
  // A wake stamped in the future, or before observation began, is not evidence.
  for (const atMs of [5000, -1]) {
    assert.equal(liveness([{ subscription: 'pull_request.opened', atMs }], window)[0]!.status, 'never');
  }
});

test('the sweep expects exactly the subscriptions the flow registers', () => {
  const registered = getFlowDefinition(babysitter).handlers.length;
  assert.equal(liveness([], { nowMs: 1, sinceMs: 0, staleAfterMs: 1 }).length, registered);
});
