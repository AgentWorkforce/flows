import assert from 'node:assert/strict';
import test from 'node:test';
import { getFlowDefinition } from '@relayflows/surface/runtime';
import type { Ctx } from '@relayflows/surface';
import { createHostedBabysitter } from '../hosted.ts';
import { subscriptionIds } from '../subscriptions.ts';

const head = 'b'.repeat(40);
const policy = {
  owner: 'acme', repo: 'widgets', number: 7, testCommand: 'npm test',
  botLogin: 'babysitter[bot]', merge: false,
};
const live = {
  state: 'open', merged: false, draft: false, headSha: head,
  baseSha: 'c'.repeat(40), headRepo: 'acme/widgets', headRef: 'work',
  author: 'alice', labels: [], mergeable: true, mergeState: 'clean',
  checks: [], reviews: [], requestedReviewers: [],
};
function input(eventType = 'pull_request.synchronize') {
  return {
    approver: 'alice', issue: { source: 'github', repository: 'acme/widgets', title: 'A PR' },
    pullRequest: { owner: 'acme', repo: 'widgets', number: 7, headSha: 'a'.repeat(40) },
    event: { provider: 'github', eventType, paths: [], deliveryId: 'real-delivery-id' },
  };
}
function context() {
  const commands: string[] = [], reasons: string[] = [];
  return {
    commands, reasons,
    f: {
      run: async (command: string) => {
        commands.push(command);
        return command.startsWith('node -e') ? JSON.stringify(live) : '';
      },
      done: (reason: string) => { reasons.push(reason); },
      agent: () => { throw new Error('Hosted proof must not dispatch an agent'); },
    } as unknown as Ctx,
  };
}

test('every hosted subscription reaches the same authoritative reread with pinned coordinates', async () => {
  const definition = getFlowDefinition(createHostedBabysitter(policy));
  assert.equal(definition.handlers.length, subscriptionIds.length);
  for (const id of subscriptionIds) {
    const { f, commands } = context();
    await definition.body(f, input(id));
    assert.match(commands[0]!, /^node -e /);
    assert.match(commands[0]!, /"owner":"acme","repo":"widgets","number":7/);
    assert.ok(commands.some(c => c.includes(`wake ${id} hint=stale-hint bind=${head}`)), id);
    assert.ok(commands.some(c => c.includes('delivery=real-delivery-id')), id);
  }
});

test('hosted delivery fields cannot redirect policy, coordinates or live-head binding', async () => {
  const definition = getFlowDefinition(createHostedBabysitter(policy));
  const { f, commands, reasons } = context();
  await definition.body(f, {
    ...input(), owner: 'evil', repo: 'other', number: 99, merge: true,
    testCommand: 'touch /tmp/untrusted', botLogin: 'alice', headSha: 'd'.repeat(40),
    approvers: ['attacker'], skipLabels: [],
  });
  assert.match(commands[0]!, /"owner":"acme","repo":"widgets","number":7/);
  assert.ok(commands.some(c => c.includes(`bind=${head}`)));
  assert.ok(commands.every(c => !c.includes('/tmp/untrusted')));
  assert.deepEqual(reasons, ['needs_human']);
});

test('wrong repository, PR, host, provider or subscription refuse before the live read', async () => {
  const definition = getFlowDefinition(createHostedBabysitter(policy));
  const original = input();
  const invalid = [
    { ...original, pullRequest: { ...original.pullRequest, owner: 'other' } },
    { ...original, pullRequest: { ...original.pullRequest, number: 8 } },
    { ...original, pullRequest: { ...original.pullRequest, host: 'gitlab' } },
    { ...original, event: { ...original.event, provider: 'gitlab' } },
    { ...original, event: { ...original.event, eventType: 'pull_request.edited' } },
    { ...original, event: { ...original.event, deliveryId: '' } },
    { ...original, pullRequest: undefined },
  ];
  for (const value of invalid) {
    const { f, commands } = context();
    await assert.rejects(definition.body(f, value));
    assert.equal(commands.length, 0);
  }
});

test('case-insensitive Cloud coordinates work and policy is snapshotted at construction', async () => {
  const mutable = { ...policy };
  const definition = getFlowDefinition(createHostedBabysitter(mutable));
  mutable.owner = 'other';
  const value = input();
  value.pullRequest.owner = 'ACME'; value.pullRequest.repo = 'WIDGETS';
  const { f, commands } = context();
  await definition.body(f, value);
  assert.match(commands[0]!, /"owner":"acme","repo":"widgets"/);
});

test('normalized comment wake rereads then holds for missing original repair directive', async () => {
  const definition = getFlowDefinition(createHostedBabysitter(policy));
  const { f, commands, reasons } = context();
  await definition.body(f, { ...input('issue_comment.created'), comment: { body: '/resolve-conflicts', user: { login: 'alice' } } });
  assert.match(commands[0]!, /^node -e /);
  assert.deepEqual(reasons, ['needs_human']);
  assert.ok(commands.some(c => c.includes('original comment directive')));
});

test('invalid operator policy is refused when the hosted source loads', () => {
  assert.throws(() => createHostedBabysitter({ ...policy, number: 0 }), /Invalid Babysitter/);
  assert.throws(() => createHostedBabysitter({ ...policy, event: {} }), /operator policy/);
});
