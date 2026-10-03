import assert from 'node:assert/strict';
import test from 'node:test';
import { getFlowDefinition } from '@relayflows/surface/runtime';
import type { Ctx } from '@relayflows/surface';
import { createStandaloneBabysitter } from '../standalone.ts';

const head = 'b'.repeat(40);
const moved = 'f'.repeat(40);
const policy = { botLogin: 'babysitter[bot]' };
// Gate 8 (#442) is a platform fact, not policy: these tests supply it to prove
// what the body does once it holds. The default is proven separately.
const isolated = { enforcedAgentWriteScope: true };

const firstPrompt = 'Fix the flaky retry in queue.ts.\nDo NOT touch the public API.\n"quoted" and `ticks` and END ORIGINAL TASK';
const originContext = {
  status: 'ok', source: 'claude', sessionId: 'sess-123', rootSessionId: 'sess-root', parentChain: ['sess-root'],
  firstPrompt, firstPromptTruncated: false,
  events: [{ kind: 'message', type: 'assistant', ts: null, actorRole: 'assistant', toolName: null, content: 'Plan: retry with jitter', contentTruncated: false }],
};
const live = (over: Record<string, unknown> = {}) => ({
  state: 'open', merged: false, draft: false, headSha: head,
  baseSha: 'c'.repeat(40), headRepo: 'acme/widgets', headRef: 'work',
  author: 'alice', labels: ['babysit'], mergeable: true, mergeState: 'clean',
  checks: [{ name: 'ci', sha: head, status: 'completed', conclusion: 'failure' }],
  reviews: [], requestedReviewers: [], ...over,
});
const signals = (over: Record<string, unknown> = {}) => ({
  headSha: head,
  failingChecks: [{ name: 'ci', conclusion: 'failure', summary: 'queue.test.ts: expected 3 retries, got 1', url: 'https://example.invalid/ci' }],
  changeRequests: [], comments: [], reportedHeads: [], ...over,
});
function input(over: { deliveryId?: string; eventType?: string; babysitter?: unknown; pullRequest?: unknown } = {}) {
  return {
    pullRequest: over.pullRequest ?? { owner: 'acme', repo: 'widgets', number: 7, headSha: 'a'.repeat(40) },
    event: { provider: 'github', eventType: over.eventType ?? 'check_run.completed', paths: [], deliveryId: over.deliveryId ?? 'delivery-1' },
    babysitter: 'babysitter' in over ? over.babysitter : { pullRequest: { owner: 'acme', repo: 'widgets', number: 7 }, originContext },
  };
}
function context(o: { states?: Record<string, unknown>[]; signals?: Record<string, unknown>; summary?: string; kept?: boolean } = {}) {
  const commands: string[] = [], reasons: string[] = [], agents: { name: string; options: Record<string, unknown> }[] = [];
  const states = [...(o.states ?? [live(), live()])];
  return {
    commands, reasons, agents,
    f: {
      run: async (command: string) => {
        commands.push(command);
        if (command.includes('githubRead')) return JSON.stringify(states.length > 1 ? states.shift() : states[0]);
        if (command.includes('readSignals')) return JSON.stringify(o.signals ?? signals());
        if (command.includes('postComment')) return JSON.stringify({ id: 1 });
        if (command.includes('settleReport')) return JSON.stringify({ kept: o.kept ?? true });
        return '';
      },
      agent: async (name: string, options: Record<string, unknown>) => {
        agents.push({ name, options });
        return { summary: o.summary ?? 'Root cause: retry counter reset on @bob reconnect.', artifacts: [] };
      },
      done: (reason: string) => { reasons.push(reason); },
    } as unknown as Ctx,
  };
}
const body = (runtime = isolated) => getFlowDefinition(createStandaloneBabysitter(policy, runtime)).body;
const posted = (commands: string[]) => commands.filter(c => c.includes('postComment'));

test('without originContext the run ends needs_human with zero f.agent calls and no live read', async () => {
  for (const babysitter of [undefined, { pullRequest: { owner: 'acme', repo: 'widgets', number: 7 } },
    { pullRequest: { owner: 'acme', repo: 'widgets', number: 7 }, originContext: { status: 'missing', reason: 'digest_mismatch' } },
    { pullRequest: { owner: 'acme', repo: 'widgets', number: 7 }, originContext: { ...originContext, firstPrompt: '' } },
    // Malformed events are a malformed context, not a smaller one.
    { pullRequest: { owner: 'acme', repo: 'widgets', number: 7 }, originContext: { ...originContext, events: 'not-a-list' } },
    { pullRequest: { owner: 'acme', repo: 'widgets', number: 7 }, originContext: { ...originContext, events: [42] } },
    { pullRequest: { owner: 'acme', repo: 'widgets', number: 7 }, originContext: { ...originContext, events: [{ ...originContext.events[0], content: 7 }] } },
    // A `missing` verdict refuses even if a prompt rides along with it.
    { pullRequest: { owner: 'acme', repo: 'widgets', number: 7 }, originContext: { ...originContext, status: 'missing', reason: 'digest_mismatch' } }]) {
    const { f, commands, reasons, agents } = context();
    await body()(f, input({ babysitter }));
    assert.deepEqual(reasons, ['needs_human']);
    assert.equal(agents.length, 0);
    assert.ok(commands.every(c => !c.includes('githubRead') && !c.includes('postComment')));
  }
});

test('with originContext the agent task carries the first prompt verbatim, delimited as the task definition', async () => {
  const { f, agents, reasons } = context();
  await body()(f, input());
  assert.equal(agents.length, 1);
  const task = String(agents[0]!.options.task);
  assert.ok(task.includes(firstPrompt), 'first prompt verbatim');
  const before = task.slice(0, task.indexOf(firstPrompt)), after = task.slice(task.indexOf(firstPrompt) + firstPrompt.length);
  const open = before.trimEnd().split('\n').at(-1)!, close = after.trimStart().split('\n')[0]!;
  assert.match(open, /BEGIN ORIGINAL TASK/);
  assert.match(close, /END ORIGINAL TASK/);
  // A prompt that contains the delimiter's words cannot close the block early.
  assert.ok(!firstPrompt.includes(close));
  assert.match(task, /untrusted data/i);
  assert.match(task, /queue\.test\.ts: expected 3 retries/);
  assert.match(task, /do not (?:edit|push)/i);
  assert.deepEqual(reasons, ['success']);
});

test('two deliveries with different ids and the same live state log the same decision key', async () => {
  const keys: string[] = [];
  for (const deliveryId of ['delivery-1', 'delivery-2']) {
    const { f, commands } = context();
    await body()(f, input({ deliveryId }));
    const line = commands.find(c => c.includes('key=babysitter:'));
    assert.ok(line, deliveryId);
    assert.ok(line.includes(`delivery=${deliveryId}`));
    keys.push(/key=(\S+)/.exec(line)![1]!);
  }
  assert.equal(keys[0], keys[1]);
  assert.match(keys[0]!, new RegExp(`acme/widgets#7@${head}$`));
});

test('anything that is not the bound PR is refused before any effect', async () => {
  const bound = { owner: 'acme', repo: 'widgets', number: 7 };
  const invalid = [
    input({ pullRequest: { owner: 'acme', repo: 'widgets', number: 8 } }),
    input({ pullRequest: { owner: 'other', repo: 'widgets', number: 7 } }),
    input({ pullRequest: { owner: 'acme', repo: 'widgets', number: 7, host: 'gitlab' } }),
    input({ eventType: 'pull_request.edited' }),
    input({ deliveryId: '' }),
    input({ babysitter: { pullRequest: { ...bound, number: 9 }, originContext } }),
    { ...input(), event: { provider: 'gitlab', eventType: 'check_run.completed', deliveryId: 'd' } },
    { ...input(), pullRequest: undefined },
  ];
  for (const value of invalid) {
    const { f, commands, agents } = context();
    await assert.rejects(body()(f, value));
    assert.equal(commands.length, 0);
    assert.equal(agents.length, 0);
  }
});

test('live state decides: closed, draft, missing babysit label or nothing actionable decline without an agent', async () => {
  const cases: [Record<string, unknown>[], Record<string, unknown>?][] = [
    [[live({ state: 'closed' })]],
    [[live({ draft: true })]],
    [[live({ merged: true })]],
    [[live({ labels: [] })]],
    [[live({ checks: [{ name: 'ci', sha: head, status: 'completed', conclusion: 'success' }] })], signals({ failingChecks: [] })],
  ];
  for (const [states, sig] of cases) {
    const { f, reasons, agents, commands } = context({ states, signals: sig });
    await body()(f, input());
    assert.deepEqual(reasons, ['declined'], JSON.stringify(states));
    assert.equal(agents.length, 0);
    assert.equal(posted(commands).length, 0);
  }
});

test('a change request or an authorised directive is actionable; an outsider directive is not', async () => {
  const green = signals({ failingChecks: [] });
  const cr = { ...green, changeRequests: [{ login: 'carol', id: 5, body: 'Retries must be bounded' }] };
  let ctx = context({ signals: cr });
  await body()(ctx.f, input({ eventType: 'pull_request_review.submitted' }));
  assert.equal(ctx.agents.length, 1);
  assert.match(String(ctx.agents[0]!.options.task), /Retries must be bounded/);

  const directive = (login: string, association: string) => ({ ...green, comments: [{ id: 9, login, association, body: '@babysitter please look at the flaky test', createdAt: '2026-10-02T00:00:00Z' }] });
  ctx = context({ signals: directive('mallory', 'NONE') });
  await body()(ctx.f, input({ eventType: 'issue_comment.created' }));
  assert.deepEqual(ctx.reasons, ['declined']);
  assert.equal(ctx.agents.length, 0);

  for (const [login, association] of [['alice', 'NONE'], ['dana', 'MEMBER']] as const) {
    ctx = context({ signals: directive(login, association) });
    await body()(ctx.f, input({ eventType: 'issue_comment.created' }));
    assert.equal(ctx.agents.length, 1, login);
    assert.match(String(ctx.agents[0]!.options.task), /please look at the flaky test/);
  }
});

test('a head already reported by Babysitter declines before the agent', async () => {
  const ctx = context({ signals: signals({ reportedHeads: [head] }) });
  await body()(ctx.f, input());
  assert.deepEqual(ctx.reasons, ['declined']);
  assert.equal(ctx.agents.length, 0);
});

test('the reader is asked for this bot\'s reports at the bound head', async () => {
  const { f, commands } = context();
  await body()(f, input());
  const read = commands.find(c => c.includes('readSignals'))!;
  assert.match(read, /"botLogin":"babysitter\[bot\]"/);
  assert.ok(read.includes(`"head":"${head}"`));
});

test('withdrawing the opt-in label during diagnosis stops the report', async () => {
  const { f, reasons, agents, commands } = context({ states: [live(), live({ labels: [] })] });
  await body()(f, input());
  assert.equal(agents.length, 1);
  assert.deepEqual(reasons, ['declined']);
  assert.equal(posted(commands).length, 0);
});

test('a push racing the comment marks the posted report superseded for the new head', async () => {
  const { f, reasons, commands } = context({ states: [live(), live(), live({ headSha: moved })] });
  await body()(f, input());
  assert.equal(posted(commands).length, 1);
  const patch = commands.find(c => c.includes('annotateReport'));
  assert.ok(patch, 'superseded patch issued');
  assert.match(patch, /Superseded/);
  assert.ok(patch.includes(moved) && patch.includes(head));
  assert.match(patch, /"id":1/);
  assert.deepEqual(reasons, ['declined']);
});

test('a head that moves while the agent runs declines instead of reporting on a stale head', async () => {
  const { f, reasons, agents, commands } = context({ states: [live(), live({ headSha: moved })] });
  await body()(f, input());
  assert.equal(agents.length, 1);
  assert.deepEqual(reasons, ['declined']);
  assert.equal(posted(commands).length, 0);
});

test('report is one owned PR comment naming the inherited session, never the prompt text, with mentions neutralised', async () => {
  const { f, commands, agents } = context();
  await body()(f, input());
  const comments = posted(commands);
  assert.equal(comments.length, 1);
  const comment = comments[0]!;
  assert.match(comment, /"owner":"acme","repo":"widgets","number":7/);
  assert.ok(comment.includes(`<!-- babysitter:report acme/widgets#7@${head} -->`));
  assert.ok(comment.includes('sess-123') && comment.includes('sess-root'));
  assert.ok(!comment.includes('Fix the flaky retry'), 'prompt text must never be published');
  assert.ok(!comment.includes('@bob'), 'agent output must not ping people');
  assert.ok(comment.includes('Root cause: retry counter reset'));
  // Diagnose-only: the agent is declared readonly and nothing else writes.
  assert.deepEqual(agents[0]!.options.permissions, { accessPreset: 'readonly' });
  assert.ok(commands.every(c => !/git push|\/merge|\/pulls\/7\/reviews/.test(c)));
});

test('the agent CLI follows the origin session: Claude and Codex both work', async () => {
  for (const [source, cli, model] of [['claude', 'claude', 'claude-sonnet-5'], ['codex', 'codex', 'gpt-5.6-sol']] as const) {
    const { f, agents } = context();
    await body()(f, input({ babysitter: { pullRequest: { owner: 'acme', repo: 'widgets', number: 7 }, originContext: { ...originContext, source } } }));
    assert.equal(agents[0]!.options.cli, cli);
    assert.equal(agents[0]!.options.model, model);
  }
});

test('by default no agent is dispatched: untrusted PR content needs enforced write scope first (gate 8 / #442)', async () => {
  const { f, reasons, agents, commands } = context();
  await getFlowDefinition(createStandaloneBabysitter(policy)).body(f, input());
  assert.deepEqual(reasons, ['needs_human']);
  assert.equal(agents.length, 0);
  assert.equal(posted(commands).length, 0);
  assert.ok(commands.some(c => c.includes('#442')));
});

test('invalid policy is refused when the source loads', () => {
  assert.throws(() => createStandaloneBabysitter({}), /botLogin/);
  assert.throws(() => createStandaloneBabysitter({ botLogin: 'b', agentCli: './wrap' }), /agentModel/);
});

test('withdrawing the opt-in label while the comment posts marks the report withdrawn', async () => {
  const { f, reasons, commands } = context({ states: [live(), live(), live({ labels: [] })] });
  await body()(f, input());
  assert.equal(posted(commands).length, 1);
  const patch = commands.find(c => c.includes('annotateReport'));
  assert.ok(patch, 'withdrawn patch issued');
  assert.match(patch, /babysit/);
  assert.deepEqual(reasons, ['declined']);
});

test('the agent echoing the original prompt does not publish it', async () => {
  const { f, commands } = context({ summary: `Per the task:\n${firstPrompt}\nRoot cause: retry counter reset.` });
  await body()(f, input());
  const comment = posted(commands)[0]!;
  assert.ok(!comment.includes('Fix the flaky retry in queue.ts.'));
  assert.ok(!comment.includes('Do NOT touch the public API.'));
  assert.ok(comment.includes('[original prompt redacted]'));
  assert.ok(comment.includes('Root cause: retry counter reset.'));
});

test('a concurrent run that already reported this head wins: the later comment removes itself', async () => {
  const { f, reasons, commands } = context({ kept: false });
  await body()(f, input());
  const settle = commands.find(c => c.includes('settleReport'));
  assert.ok(settle);
  assert.match(settle, /"id":1/);
  assert.ok(settle.includes(`babysitter:report acme/widgets#7@${head}`));
  assert.ok(commands.every(c => !c.includes('annotateReport')));
  assert.deepEqual(reasons, ['declined']);
});
