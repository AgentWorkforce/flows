import assert from 'node:assert/strict';
import test from 'node:test';
import type { Ctx, AgentOptions, AgentResult } from '@relayflows/surface';
import { issueSwarm, parseInput, shellWord, parseReview } from '../issue-swarm.flow.ts';

const head = 'a'.repeat(40);
const result = (summary: unknown = {}, agentName?: string): AgentResult => ({ completionReason: 'success', summary: JSON.stringify(summary), artifacts: [], agentName });
function fake() {
  const events: string[] = [];
  const agents: Array<{ name: string; options: AgentOptions }> = [];
  const messages: Array<{ name: string; text: string; timeout: unknown }> = [];
  const done: Array<{ reason: string; detail: string }> = [];
  const issues = [1, 2, 3].map(number => ({ number, title: `Issue ${number}`, body: 'Task', url: `https://github.com/acme/widgets/issues/${number}` }));
  const x = {
    events, agents, messages, done, issues, tick: 0, failCreate: 0, failRelease: '', dirty: 0, failAgent: 0, failedCheck: false,
    reviewNoGo: 0, malformedReview: false, head, unknownMerge: false, unresolved: false, pushOnFix: false, messageTimeout: false,
    repo: 'acme/widgets', origin: 'acme/widgets',
  };
  const f = {
    run: async (command: string) => {
      events.push(command);
      if (command.startsWith('command -v')) return '';
      if (command === 'gh repo view --json nameWithOwner,defaultBranchRef') return JSON.stringify({ nameWithOwner: x.repo, defaultBranchRef: { name: 'main' } });
      if (command.startsWith('gh repo view "')) return x.origin;
      if (command.startsWith('gh issue list')) return JSON.stringify(issues);
      if (command.startsWith('git fetch')) return 'b'.repeat(40);
      if (command.startsWith('mkdir')) return '/repo/.relayflow/issue-swarm.abc123';
      if (command.startsWith('git worktree add')) {
        if (x.failCreate && command.includes(`/issue-${x.failCreate}'`)) throw Error('worktree creation failed');
        return '';
      }
      if (command.startsWith('gh pr list')) return JSON.stringify([{ number: Number(/\/issue-(\d+)'/.exec(command)![1]) + 10 }]);
      if (command.startsWith('node -e')) {
        const pr = Number(/,([0-9]+)\)\.then\(value/.exec(command)![1]);
        return JSON.stringify({ number: pr, state: 'open', merged: false, draft: false, headSha: x.head, headRef: `issue-swarm.abc123/issue-${pr - 10}`, headRepo: 'acme/widgets', body: `Fixes #${pr - 10}`, mergeable: x.unknownMerge ? null : true, mergeState: x.unknownMerge ? 'unknown' : 'clean', checks: x.failedCheck ? [{ name: 'tests', sha: x.head, status: 'completed', conclusion: 'failure' }] : [], unresolved: x.unresolved ? [{ id: 'thread-1', comments: ['fix it'] }] : [], changesRequested: [] });
      }
      if (command === 'node -p Date.now()') return String(x.tick);
      if (command.startsWith('sleep ')) { x.tick += Number(command.slice(6)) * 1000; return ''; }
      if (command.startsWith('if [ -e')) {
        if (x.dirty && command.includes(`/issue-${x.dirty}'`)) throw Error('worktree has uncommitted changes');
        return '';
      }
      if (command.startsWith('rmdir')) return '';
      throw Error(`Unexpected command ${command}`);
    },
    agent: async (name: string, options: AgentOptions) => {
      events.push(`agent:${name}`); agents.push({ name, options });
      if (name.startsWith('implement')) {
        if (name === `implement-${x.failAgent}`) throw Error('implementation failed');
        return result({}, `live-${name}`);
      }
      if (x.malformedReview) return result({ verdict: 'maybe' });
      const noGo = Number(/review-\d+-(\d+)-/.exec(name)![1]) <= x.reviewNoGo;
      return result({ verdict: noGo ? 'NO-GO' : 'GO', headSha: x.head, findings: noGo ? ['missing regression test'] : [] });
    },
    message: async (name: string, text: string, options: { timeout: unknown }) => {
      events.push(`message:${name}`); messages.push({ name, text, timeout: options.timeout });
      x.failedCheck = false; x.unresolved = false;
      if (x.pushOnFix) x.head = 'c'.repeat(40);
      if (x.messageTimeout) return { ...result({}, name), completionReason: 'timeout' };
      return result({}, name);
    },
    release: async (name: string) => {
      events.push(`release:${name}`);
      if (name === x.failRelease) throw Error('release failed');
    },
    done: (reason: string, options: { detail: string }) => done.push({ reason, detail: options.detail }),
  } as unknown as Ctx;
  return { ...x, get state() { return x; }, f };
}

test('count bounds parallel issues; three broker reviewers per PR; releases before removing worktrees', async () => {
  const x = fake();
  await issueSwarm(x.f, { label: 'agent', count: 2 });
  assert.equal(x.done[0]?.reason, 'success');
  assert.equal(x.agents.filter(a => a.name.startsWith('implement')).length, 2);
  assert.equal(x.agents.filter(a => a.name.startsWith('review')).length, 6);
  for (const { name, options } of x.agents) {
    assert.equal(options.transport, 'broker');
    assert.deepEqual(options.skills, [name.startsWith('implement') ? 'pr-comments' : 'adversarial-review']);
    assert.equal(options.keepAlive, name.startsWith('implement'));
  }
  for (const n of [1, 2]) {
    const release = x.events.indexOf(`release:live-implement-${n}`);
    const remove = x.events.findIndex(e => e.startsWith('if [ -e') && e.includes(`/issue-${n}'`));
    assert.ok(release > 0 && remove > release);
  }
  assert.ok(x.events.every(e => !/gh pr merge|git worktree remove --force/.test(e)));
});

test('NO-GO findings go to the same implementer, followed by fresh review', async () => {
  const x = fake(); x.state.reviewNoGo = 1;
  await issueSwarm(x.f, { label: 'agent', count: 1, reviewRounds: 2 });
  assert.equal(x.done[0]?.reason, 'success');
  assert.equal(x.messages.length, 1);
  assert.equal(x.messages[0]?.name, 'live-implement-1');
  assert.match(x.messages[0]!.text, /missing regression test/);
  assert.equal(x.agents.filter(a => a.name.startsWith('review')).length, 6);
});

test('monitor sends CI and review-thread repairs, then captures fresh state', async () => {
  const x = fake(); x.state.failedCheck = true; x.state.unresolved = true;
  await issueSwarm(x.f, { label: 'agent', count: 1, monitorMinutes: 1 });
  assert.equal(x.done[0]?.reason, 'success');
  assert.match(x.messages[0]!.text, /check tests: completed\/failure/);
  assert.match(x.messages[0]!.text, /unresolved thread thread-1/);
  assert.equal(x.messages[0]?.timeout, 60_000);
});

test('monitor fixes that push a new head trigger all three reviewers again', async () => {
  const x = fake(); x.state.failedCheck = true; x.state.pushOnFix = true;
  await issueSwarm(x.f, { label: 'agent', count: 1, monitorMinutes: 2 });
  assert.equal(x.done[0]?.reason, 'success');
  assert.equal(x.agents.filter(a => a.name.startsWith('review')).length, 6);
  assert.ok(x.agents.filter(a => a.name.startsWith('review-1-2')).every(a => a.options.task.includes('c'.repeat(40))));
  assert.equal(x.messages.length, 1);
});

test('a timed out message ends with human attention and releases its implementer', async () => {
  const x = fake(); x.state.failedCheck = true; x.state.messageTimeout = true;
  await issueSwarm(x.f, { label: 'agent', count: 1, monitorMinutes: 1 });
  assert.equal(x.done[0]?.reason, 'needs_human');
  assert.match(x.done[0]!.detail, /timeout/);
  assert.ok(x.events.includes('release:live-implement-1'));
});

test('a new head cannot inherit GO after the last review pass', async () => {
  const x = fake(); x.state.failedCheck = true; x.state.pushOnFix = true;
  await issueSwarm(x.f, { label: 'agent', count: 1, reviewRounds: 1, monitorMinutes: 1 });
  assert.equal(x.done[0]?.reason, 'needs_human');
  assert.match(x.done[0]!.detail, /lacks adversarial GO/);
});

test('review exhaustion and unknown mergeability cannot become success at deadline', async () => {
  const x = fake(); x.state.reviewNoGo = 5; x.state.unknownMerge = true;
  await issueSwarm(x.f, { label: 'agent', count: 1, reviewRounds: 2, monitorMinutes: 1 });
  assert.equal(x.done[0]?.reason, 'needs_human');
  assert.equal(x.messages.length, 1);
  assert.equal(x.agents.filter(a => a.name.startsWith('review')).length, 6);
  assert.equal(x.state.tick, 60_000);
  assert.match(x.done[0]!.detail, /lacks adversarial GO/);
});

test('zero monitor budget captures status but sends no monitor repair', async () => {
  const x = fake(); x.state.failedCheck = true;
  await issueSwarm(x.f, { label: 'agent', count: 1, monitorMinutes: 0 });
  assert.equal(x.done[0]?.reason, 'needs_human');
  assert.equal(x.messages.length, 0);
});

test('a failed lane waits for peers and still releases each returned session', async () => {
  const x = fake(); x.state.failAgent = 1;
  await issueSwarm(x.f, { label: 'agent', count: 2 });
  assert.equal(x.done[0]?.reason, 'needs_human');
  assert.ok(x.events.includes('release:live-implement-2'));
  assert.ok(x.events.indexOf('release:live-implement-2') > x.events.lastIndexOf('agent:review-2-1-code-structure'));
});

test('worktree creation failure still cleans up the successful sibling lane', async () => {
  const x = fake(); x.state.failCreate = 1;
  await issueSwarm(x.f, { label: 'agent', count: 2 });
  assert.equal(x.done[0]?.reason, 'needs_human');
  assert.ok(!x.agents.some(a => a.name === 'implement-1'));
  assert.ok(x.events.includes('release:live-implement-2'));
});

test('malformed reviewer result releases implementers and cannot produce GO', async () => {
  const x = fake(); x.state.malformedReview = true;
  await issueSwarm(x.f, { label: 'agent', count: 1 });
  assert.equal(x.done[0]?.reason, 'needs_human');
  assert.ok(x.events.includes('release:live-implement-1'));
});

test('release failures preserve that worktree and do not skip other cleanup', async () => {
  const x = fake(); x.state.failRelease = 'live-implement-1';
  await issueSwarm(x.f, { label: 'agent', count: 2 });
  assert.equal(x.done[0]?.reason, 'needs_human');
  assert.ok(!x.events.some(e => e.startsWith('if [ -e') && e.includes('/issue-1')));
  assert.ok(x.events.some(e => e.startsWith('if [ -e') && e.includes('/issue-2')));
  assert.match(x.done[0]!.detail, /release failed/);
});

test('dirty worktree is preserved and cleanup error reported', async () => {
  const x = fake(); x.state.dirty = 1;
  await issueSwarm(x.f, { label: 'agent', count: 1 });
  assert.equal(x.done[0]?.reason, 'needs_human');
  assert.match(x.done[0]!.detail, /uncommitted changes/);
  assert.ok(!x.events.some(e => e.startsWith('rmdir')));
});

test('empty issue list allocates no agents or worktrees', async () => {
  const x = fake(); x.issues.length = 0;
  await issueSwarm(x.f, { label: 'agent' });
  assert.equal(x.done[0]?.reason, 'success');
  assert.equal(x.agents.length, 0);
  assert.ok(!x.events.some(e => e.startsWith('mkdir')));
});

test('invalid input fails before effects; label shell metacharacters stay quoted', async () => {
  const x = fake();
  await issueSwarm(x.f, { label: 'agent', count: 0 });
  assert.equal(x.events.length, 0);
  assert.equal(x.done[0]?.reason, 'needs_human');
  assert.throws(() => parseInput({ label: '', reviewRounds: 0 }), /label/);
  assert.throws(() => parseInput({ label: 'agent', monitorMinutes: -1 }), /monitorMinutes/);
  assert.equal(shellWord("x'$(touch /tmp/unwanted)"), "'x'\\''$(touch /tmp/unwanted)'");
});

test('explicit foreign repo and a mismatched origin fail before allocating worktrees', async () => {
  for (const mismatch of ['input', 'origin']) {
    const x = fake();
    if (mismatch === 'origin') x.state.origin = 'foreign/widgets';
    await issueSwarm(x.f, { label: 'agent', ...(mismatch === 'input' ? { repo: 'foreign/widgets' } : {}) });
    assert.equal(x.done[0]?.reason, 'needs_human');
    assert.equal(x.agents.length, 0);
    assert.ok(!x.events.some(e => e.startsWith('mkdir')));
  }
});

test('malformed, stale and contradictory verdicts fail closed', () => {
  for (const review of [{ verdict: 'GO', headSha: 'b'.repeat(40), findings: [] }, { verdict: 'GO', headSha: head, findings: ['bug'] }, { verdict: 'NO-GO', headSha: head, findings: [] }]) {
    assert.throws(() => parseReview(result(review), head), /Review requires/);
  }
  assert.throws(() => parseReview({ ...result(), completionReason: 'timeout' }, head), /timeout/);
});
