import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { getFlowDefinition } from '@relayflows/surface/runtime';
import type { Ctx } from '@relayflows/surface';
import recommended, { recommendedBabysitterBody } from '../recommended.ts';
import { subscriptionIds } from '../subscriptions.ts';

const liveHead = 'b'.repeat(40);
const live = {
  state: 'open', merged: false, draft: false, headSha: liveHead,
  baseSha: 'c'.repeat(40), headRepo: 'acme/widgets', headRef: 'work',
  author: 'alice', labels: ['babysit'], mergeable: true, mergeState: 'clean',
  checks: [], reviews: [], requestedReviewers: [],
};

function input(eventType = 'pull_request.labeled') {
  return {
    approver: 'alice',
    issue: { source: 'github', repository: 'acme/widgets', title: 'A PR', labels: ['babysit'] },
    pullRequest: { owner: 'acme', repo: 'widgets', number: 7, headSha: 'a'.repeat(40) },
    event: { provider: 'github', eventType, paths: [], deliveryId: 'delivery-7' },
  };
}

function context() {
  const commands: string[] = [];
  const reasons: string[] = [];
  return {
    commands,
    reasons,
    f: {
      run: async (command: string) => {
        commands.push(command);
        return command.startsWith('node -e') ? JSON.stringify(live) : '';
      },
      done: (reason: string) => { reasons.push(reason); },
      agent: () => { throw new Error('Unsafe review capability must remain held'); },
    } as unknown as Ctx,
  };
}

test('recommended artifact is a versioned standalone flow body', () => {
  const definition = getFlowDefinition(recommended);
  assert.equal(definition.name, 'babysitter');
  assert.equal(definition.header.version, '1.0.0');
  assert.equal(definition.handlers.length, 0);
});

test('every Cloud change-request subscription binds dynamic repository coordinates and rereads live state', async () => {
  for (const id of subscriptionIds) {
    const { f, commands } = context();
    await recommendedBabysitterBody(f, input(id));
    assert.match(commands[0]!, /^node -e /);
    assert.match(commands[0]!, /"owner":"acme","repo":"widgets","number":7/);
    assert.ok(commands.some(command => command.includes(`wake ${id} hint=stale-hint bind=${liveHead}`)), id);
  }
});

test('delivery fields cannot enable merge, redirect coordinates, or bypass held capabilities', async () => {
  const { f, commands, reasons } = context();
  await recommendedBabysitterBody(f, {
    ...input(),
    owner: 'evil', repo: 'other', number: 99, merge: true,
    testCommand: 'touch /untrusted', botLogin: 'alice', organizations: ['acme'],
  });
  assert.match(commands[0]!, /"owner":"acme","repo":"widgets","number":7/);
  assert.ok(commands.every(command => !command.includes('/untrusted')));
  assert.ok(commands.every(command => !command.includes('touch')));
  assert.deepEqual(reasons, ['needs_human']);
  assert.ok(commands.some(command => command.includes('enforce agent workspace and credential scopes')));
});

test('malformed or undeclared Cloud deliveries fail before the first live read', async () => {
  for (const value of [
    { ...input(), approver: '' },
    { ...input(), pullRequest: { ...input().pullRequest, host: 'gitlab' } },
    { ...input(), pullRequest: { ...input().pullRequest, number: 0 } },
    { ...input(), event: { ...input().event, provider: 'gitlab' } },
    { ...input(), event: { ...input().event, eventType: 'pull_request.edited' } },
    { ...input(), event: { ...input().event, deliveryId: '' } },
  ]) {
    const { f, commands } = context();
    await assert.rejects(recommendedBabysitterBody(f, value));
    assert.equal(commands.length, 0);
  }
});

test('committed catalog artifact is self-contained and preserves fail-closed capability text', async () => {
  const artifact = await readFile(new URL('../dist/babysitter-recommended.flow.ts', import.meta.url), 'utf8');
  assert.match(artifact, /from \"@relayflows\/surface\"/);
  assert.doesNotMatch(artifact, /from \"\.\//);
  assert.match(artifact, /enforce agent workspace and credential scopes/);
  assert.match(artifact, /testCommand: \"false\"/);
  assert.match(artifact, /merge: false/);
  assert.match(artifact, /version: \"1\.0\.0\"/);
});
