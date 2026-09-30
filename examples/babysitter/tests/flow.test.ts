import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BABYSITTER_FLOW_DIRECTORY,
  assertReviewerPairReady,
  babysit,
  generatedModelForCli,
  requiredReviewerModel,
  reviewerExecutableFrom as modernReviewerExecutableFrom,
} from '../babysitter.flow.ts';
import {
  LEGACY_REVIEWER_FLOW_DIRECTORY,
  assertReviewerPairReady as assertLegacyReviewerPairReady,
  requiredReviewerModel as requiredLegacyReviewerModel,
  reviewer as legacyReviewer,
  reviewerExecutableFrom,
} from '../legacy/pr-reviewer.flow.ts';
import { mergeExact } from '../github.ts';
import { parseInput } from '../input.ts';
import type { Ctx } from '@relayflows/surface';
import { getFlowDefinition } from '@relayflows/surface/runtime';
const sha = 'a'.repeat(40);
const config = { owner: 'acme', repo: 'widgets', number: 7, testCommand: 'npm test', botLogin: 'babysitter[bot]', merge: true, approvers: ['alice'], organizations: ['acme'], reviewAuthors: [], skipLabels: [], requiredChecks: ['unit'] };
const state = { state: 'open', merged: false, draft: false, headSha: sha, baseSha: 'b'.repeat(40), headRepo: 'acme/widgets', author: 'author', labels: [], mergeable: true, mergeState: 'clean', checks: [{ name: 'unit', sha, status: 'completed', conclusion: 'success' }], reviews: [{ login: 'alice', sha, state: 'APPROVED', id: 1 }], requestedReviewers: [] };
function context(
  live: unknown = state,
  probe: unknown = { exists: true, supported: true, authenticated: true, modelAvailable: true },
  captureAgent = false,
) {
  const commands: string[] = [], reasons: string[] = [], merges: string[] = [];
  const runOptions: unknown[] = [];
  const agentCalls: Array<{ cli?: string; model?: string }> = [];
  let agents = 0;
  const f = { run: async (command: string, options?: unknown) => {
    commands.push(command);
    runOptions.push(options);
    if (command.includes('--probe-cli')) {
      const requested = command.match(/--probe-cli '([^']+)'/)?.[1] ?? '';
      const executable = requested.startsWith('/') ? requested : `/usr/bin/${requested}`;
      return JSON.stringify({ ...(probe as object), executable });
    }
    if (command.startsWith('curl ') && command.includes('/check-runs?')) return '{"check_runs":[]}';
    if (command.startsWith('curl ') && command.includes('/status')) return '{"statuses":[]}';
    if (command.startsWith('curl ') && command.includes('/reviews?')) return JSON.stringify([
      { user: { login: 'alice' }, state: 'APPROVED', commit_id: sha, submitted_at: '2026-09-28T00:00:00Z' },
    ]);
    if (command.startsWith('curl ') && command.includes('api.github.com/repos/acme/widgets/pulls/7')) return JSON.stringify({
      state: 'open', draft: false, mergeable: true, mergeable_state: 'clean', head: { sha }, labels: [],
    });
    return command.startsWith('node -e') ? JSON.stringify(live) : '';
  }, done: (reason: string) => { reasons.push(reason); }, agent: (_label: string, options: { cli?: string; model?: string }) => {
    agents++;
    agentCalls.push(options);
    if (!captureAgent) throw new Error('unsafe agent dispatch');
    return { gate: async () => { throw new Error('captured agent dispatch'); } };
  },
  github: { mergePullRequest: async (input: { sha: string }) => { merges.push(input.sha); return { merged: true }; } } } as unknown as Ctx;
  return { f, commands, runOptions, reasons, merges, agentCalls, agents: () => agents };
}
test('only registered direct-probe providers receive generated model pins', () => {
  assert.deepEqual(
    ['claude', 'codex', 'cursor-agent', 'grok', '/opt/custom-wrapper'].map(generatedModelForCli),
    ['claude-sonnet-5', 'gpt-5.6-sol', undefined, undefined, undefined],
  );
});
test('provider executable basenames retain generated model defaults', () => {
  assert.equal(generatedModelForCli('/usr/local/bin/codex'), 'gpt-5.6-sol');
  assert.equal(generatedModelForCli('./tools/claude.exe'), 'claude-sonnet-5');
  assert.throws(() => requiredReviewerModel('/usr/local/bin/cursor-agent'), /requires reviewerModel/);
  assert.throws(() => requiredReviewerModel('/usr/local/bin/grok'), /requires reviewerModel/);
  assert.throws(() => requiredLegacyReviewerModel('/usr/local/bin/cursor-agent'), /requires reviewerModel/);
  assert.throws(() => parseInput({ ...config, reviewerCli: '/usr/local/bin/grok' }), /requires reviewerModel/);
});
test('custom reviewer wrappers require and preserve an explicit model', () => {
  assert.equal(requiredReviewerModel(' claude '), 'claude-sonnet-5');
  assert.equal(requiredLegacyReviewerModel(' claude '), 'claude-sonnet-5');
  assert.throws(() => requiredReviewerModel('/opt/custom-wrapper'), /requires reviewerModel/);
  assert.equal(requiredReviewerModel('/opt/custom-wrapper', ' custom-model '), 'custom-model');
  assert.throws(() => requiredReviewerModel('claude', '   '), /non-empty string/);
  assert.throws(() => requiredReviewerModel('/opt/custom-wrapper', 'bad\nmodel'), /control characters/);
  assert.throws(() => requiredLegacyReviewerModel('/opt/custom-wrapper'), /requires reviewerModel/);
  assert.equal(requiredLegacyReviewerModel('/opt/custom-wrapper', ' legacy-model '), 'legacy-model');
  assert.throws(() => requiredLegacyReviewerModel('/opt/custom-wrapper', 'bad\nmodel'), /control characters/);
  assert.throws(() => requiredLegacyReviewerModel(' '), /non-empty/);
  assert.throws(() => requiredLegacyReviewerModel('claude', ' '), /non-empty/);
  assert.throws(() => parseInput({ ...config, reviewerCli: '/opt/custom-wrapper' }), /requires reviewerModel/);
  assert.equal(parseInput({ ...config, reviewerCli: '/opt/custom-wrapper', reviewerModel: ' exact-model ' }).reviewerModel, 'exact-model');
  assert.throws(() => parseInput({ ...config, reviewerCli: 'bad\ncli', reviewerModel: 'exact-model' }), /control characters/);
  assert.throws(() => parseInput({ ...config, reviewerCli: '/opt/custom-wrapper', reviewerModel: 'bad\nmodel' }), /control characters/);
});
test('legacy reviewer binds slash-relative wrappers before probing and dispatch', () => {
  assert.equal(reviewerExecutableFrom('./tools/reviewer', '/tmp/flow root'), '/tmp/flow root/tools/reviewer');
  assert.equal(reviewerExecutableFrom('/opt/reviewer', '/tmp/flow root'), '/opt/reviewer');
  assert.equal(reviewerExecutableFrom('claude', '/tmp/flow root'), 'claude');
});
test('modern reviewer binds slash-relative wrappers before probing and dispatch', () => {
  assert.equal(modernReviewerExecutableFrom('./tools/reviewer', '/tmp/flow root'), '/tmp/flow root/tools/reviewer');
  assert.equal(modernReviewerExecutableFrom('/opt/reviewer', '/tmp/flow root'), '/opt/reviewer');
  assert.equal(modernReviewerExecutableFrom('claude', '/tmp/flow root'), 'claude');
});
test('legacy reviewer probes and dispatches the same resolved wrapper', async () => {
  const body = getFlowDefinition(legacyReviewer).body;
  const x = context(state, undefined, true);
  await assert.rejects(
    body(x.f, {
      owner: 'acme', repo: 'widgets', number: 7, approvers: '',
      reviewerCli: './tools/reviewer', reviewerModel: 'exact-model',
    }),
    /captured agent dispatch/,
  );
  const executable = reviewerExecutableFrom('./tools/reviewer', LEGACY_REVIEWER_FLOW_DIRECTORY);
  assert.match(x.commands[0]!, new RegExp(executable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(x.agentCalls[0]?.cli, executable);
  assert.equal(x.agentCalls[0]?.model, 'exact-model');
});
test('legacy reviewer dispatches the absolute executable bound by the probe', async () => {
  const body = getFlowDefinition(legacyReviewer).body;
  const x = context(state, undefined, true);
  await assert.rejects(
    body(x.f, { owner: 'acme', repo: 'widgets', number: 7, approvers: '', reviewerCli: 'claude' }),
    /captured agent dispatch/,
  );
  assert.equal(x.agentCalls[0]?.cli, '/usr/bin/claude');
  assert.equal(x.agentCalls[0]?.model, 'claude-sonnet-5');
});
test('blank legacy reviewer overrides fail before GitHub or repository effects', async () => {
  const body = getFlowDefinition(legacyReviewer).body;
  for (const override of [{ reviewerCli: ' ' }, { reviewerModel: ' ' }]) {
    const x = context();
    await assert.rejects(
      body(x.f, { owner: 'acme', repo: 'widgets', number: 7, approvers: '', ...override }),
      /non-empty/,
    );
    assert.equal(x.commands.length, 0);
    assert.equal(x.agents(), 0);
  }
});
test('unavailable legacy reviewer pair fails before GitHub or repository effects', async () => {
  const body = getFlowDefinition(legacyReviewer).body;
  const x = context(state, {
    exists: true, supported: true, authenticated: true, modelAvailable: false,
  });
  await assert.rejects(
    body(x.f, {
      owner: 'acme', repo: 'widgets', number: 7, approvers: '',
      reviewerCli: 'claude', reviewerModel: 'unavailable-exact-model',
    }),
    /Reviewer model "unavailable-exact-model" is unavailable through "claude"/,
  );
  assert.equal(x.commands.length, 1);
  assert.match(x.commands[0]!, /--probe-cli/);
  assert.match(x.commands[0]!, /'claude' 'unavailable-exact-model'/);
  assert.doesNotMatch(x.commands[0]!, /command -v flows|cli-probe\.js|curl|git fetch|git checkout|\.workforce/);
  assert.equal(x.agents(), 0);
});
test('modern reviewer readiness fails closed before capture commands are possible', async () => {
  const x = context(state, {
    exists: true, supported: true, authenticated: true, modelAvailable: false,
  });
  await assert.rejects(
    assertReviewerPairReady(x.f, 'claude', 'unavailable-exact-model', BABYSITTER_FLOW_DIRECTORY),
    /Reviewer model "unavailable-exact-model" is unavailable through "claude"/,
  );
  assert.equal(x.commands.length, 1);
  assert.match(x.commands[0]!, /--probe-cli/);
  assert.match(x.commands[0]!, /'claude' 'unavailable-exact-model'/);
  assert.match(x.commands[0]!, new RegExp(BABYSITTER_FLOW_DIRECTORY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(x.commands.every(command => !/mktemp|git clone|git fetch/.test(command)));
  assert.equal(x.agents(), 0);
});
test('modern reviewer readiness returns the absolute executable selected by the probe', async () => {
  const x = context();
  assert.equal(
    await assertReviewerPairReady(x.f, 'claude', 'claude-sonnet-5', BABYSITTER_FLOW_DIRECTORY),
    '/usr/bin/claude',
  );
  assert.deepEqual(x.runOptions, [{ timeout: '2m' }]);
});
test('reviewer probes use the stable authored CLI instead of a temporary Node payload', async () => {
  const previous = process.env.FLOWS_AUTHORED_CLI;
  process.env.FLOWS_AUTHORED_CLI = '/opt/flows-stable';
  try {
    for (const [ready, directory] of [
      [assertReviewerPairReady, BABYSITTER_FLOW_DIRECTORY],
      [assertLegacyReviewerPairReady, LEGACY_REVIEWER_FLOW_DIRECTORY],
    ] as const) {
      const x = context();
      await ready(x.f, 'claude', 'claude-sonnet-5', directory);
      assert.match(x.commands[0]!, /^'\/opt\/flows-stable' --probe-cli /);
      assert.doesNotMatch(x.commands[0]!, /flows-authored-node-|runner\.mjs/);
      assert.deepEqual(x.runOptions, [{ timeout: '2m' }]);
    }
  } finally {
    if (previous === undefined) delete process.env.FLOWS_AUTHORED_CLI;
    else process.env.FLOWS_AUTHORED_CLI = previous;
  }
});
test('approval-only legacy wakes do not probe an unused reviewer pair', async () => {
  const body = getFlowDefinition(legacyReviewer).body;
  const x = context(state, {
    exists: true, supported: true, authenticated: true, modelAvailable: false,
  });
  await body(x.f, {
    owner: 'acme', repo: 'widgets', number: 7, approvers: 'alice',
    reviewerCli: '/opt/custom-wrapper',
    event: { review: { state: 'approved', user: { login: 'alice' }, commit_id: sha } },
  });
  assert.deepEqual(x.reasons, ['success']);
  assert.deepEqual(x.merges, [sha]);
  assert.ok(x.commands.every(command => !command.includes('--probe-cli')));
  assert.equal(x.agents(), 0);
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
test('live-head review/check wakes evaluate merge but do not simulate an unavailable receipt', async () => {
  for (const event of [
    { action: 'submitted', repository: { full_name: 'acme/widgets' }, pull_request: { number: 7, head: { sha } }, review: { state: 'approved' } },
    { action: 'dismissed', repository: { full_name: 'acme/widgets' }, pull_request: { number: 7, head: { sha } }, review: { state: 'dismissed' } },
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
test('merge transport sends the bound live SHA and fails if provider does not confirm', async () => {
  const commands: string[] = [];
  const f = { run: async (command: string) => { commands.push(command); return '{"merged":true}'; } } as unknown as Ctx;
  await mergeExact(f, config, sha);
  assert.ok(commands[0]!.includes(`"sha":"${sha}"`)); assert.ok(commands[0]!.includes('/pulls/7/merge'));
  await assert.rejects(mergeExact({ run: async () => '{"merged":false}' } as unknown as Ctx, config, sha), /did not confirm/);
});
test('live-head end-to-end review and merge acceptance remains RED', { todo: 'Requires enforced agent scopes and durable fenced publication; the passing merge transport unit test is not end-to-end acceptance' }, async () => {
  const x = context(); await babysit(x.f, config);
  assert.deepEqual(x.reasons, ['success']);
});
