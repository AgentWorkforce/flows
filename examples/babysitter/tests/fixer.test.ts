import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { getFlowDefinition } from '@relayflows/surface/runtime';
import type { Ctx } from '@relayflows/surface';
import { createStandaloneFixer, parseOutcome } from '../fixer.ts';
import { proposeChanges, PATCH_MAX_BYTES, PATCH_MAX_FILES, PROPOSAL_MAX_BYTES, REFUSED_PATHS } from '../fix.ts';
import { nodeCommand } from '../github.ts';

const head = 'b'.repeat(40);
const moved = 'f'.repeat(40);
const policy = { botLogin: 'babysitter[bot]' };
const isolated = { enforcedAgentWriteScope: true };
const firstPrompt = 'Fix the flaky retry in queue.ts.\nDo NOT touch the public API at all please.';
const originContext = { status: 'ok', source: 'claude', sessionId: 'sess-123', rootSessionId: 'sess-root', firstPrompt, events: [] };
const live = (over: Record<string, unknown> = {}) => ({
  state: 'open', merged: false, draft: false, headSha: head, baseSha: 'c'.repeat(40), headRepo: 'acme/widgets',
  headRef: 'work', author: 'alice', labels: ['babysit'], mergeable: true, mergeState: 'clean', checks: [], reviews: [],
  requestedReviewers: [], ...over,
});
const feedback = [
  { kind: 'inline', id: 11, login: 'coderabbitai[bot]', body: 'Possible null dereference', path: 'src/queue.ts', line: 42, thread: 11, createdAt: '2026-10-05T00:00:00Z' },
  { kind: 'review', id: 12, login: 'dana', body: 'Please add a regression test', createdAt: '2026-10-05T00:01:00Z' },
];
const signals = { headSha: head, failingChecks: [], changeRequests: [], comments: [], reviewFeedback: feedback, reported: false };
const input = () => ({
  pullRequest: { owner: 'acme', repo: 'widgets', number: 7, headSha: head },
  event: { provider: 'github', eventType: 'pull_request_review.submitted', paths: [], deliveryId: 'delivery-1' },
  babysitter: { pullRequest: { owner: 'acme', repo: 'widgets', number: 7, headSha: head }, originContext },
});
const proposal = { kind: 'babysitter-proposal', schemaVersion: 1, baseHead: head, files: ['src/queue.ts'], patch: 'diff --git a/src/queue.ts b/src/queue.ts\n' };

function context(o: { states?: Record<string, unknown>[]; summary?: string; proposed?: Record<string, unknown> } = {}) {
  const commands: string[] = [], reasons: string[] = [], agents: { name: string; options: Record<string, unknown> }[] = [];
  const states = [...(o.states ?? [live(), live()])];
  return {
    commands, reasons, agents,
    f: {
      run: async (command: string) => {
        commands.push(command);
        if (command.includes('githubRead')) return JSON.stringify(states.length > 1 ? states.shift() : states[0]);
        if (command.includes('readSignals')) return JSON.stringify(signals);
        if (command.includes('checkoutHead')) return JSON.stringify({ dir: '/run/babysitter-checkout', head, reused: false });
        if (command.includes('proposeChanges')) return JSON.stringify(o.proposed ?? proposal);
        return '';
      },
      agent: async (name: string, options: Record<string, unknown>) => {
        agents.push({ name, options });
        return { completionReason: 'success', artifacts: [], summary: o.summary ?? JSON.stringify({
          summary: 'Guarded `job` before use. Quoting: Fix the flaky retry in queue.ts.',
          replies: [{ id: 11, body: 'Fixed: guarded `job`, thanks @dana' }, { id: 12, body: 'not a thread' }, { id: 99, body: 'unknown' }, { id: 11, body: 'dup' }],
        }) };
      },
      done: (reason: string) => { reasons.push(reason); },
    } as unknown as Ctx,
  };
}
const body = (runtime = isolated) => getFlowDefinition(createStandaloneFixer(policy, runtime)).body;
const proposeCommand = (commands: string[]) => commands.find(c => c.includes('proposeChanges'));

test('the fixer checks out the bound head, runs one agent there with fix rules, and journals one proposal', async () => {
  const { f, commands, reasons, agents } = context();
  await body()(f, input());
  assert.deepEqual(reasons, ['success']);
  assert.equal(agents.length, 1);
  assert.equal(agents[0]!.name, 'babysitter-fix');
  assert.equal(agents[0]!.options.cwd, '/run/babysitter-checkout');
  assert.match(String(agents[0]!.options.task), /Fix what changed\./);
  assert.match(String(agents[0]!.options.task), /Review comment #11 by coderabbitai\[bot\]/);
  assert.ok(commands.findIndex(c => c.includes('checkoutHead')) < commands.findIndex(c => c.includes('proposeChanges')));
  assert.ok(commands.find(c => c.includes('checkoutHead'))!.includes(`"head":"${head}"`));
});

test('the fixer never writes to GitHub itself: no push, merge, review, or comment calls', async () => {
  const { f, commands } = context();
  await body()(f, input());
  for (const command of commands) {
    assert.doesNotMatch(command, /git push|\/merge|\/reviews['"`]?\s*,\s*\{\s*method|postComment|method: 'POST'|method: 'PATCH'|method: 'PUT'/, command.slice(0, 80));
  }
});

test('thread replies go only to inline feedback this run was woken by, once each, marked and neutralised', async () => {
  const { f, commands } = context();
  await body()(f, input());
  const command = proposeCommand(commands)!;
  const replies = JSON.parse(command.slice(command.indexOf('"replies":') + 10, command.indexOf(']', command.indexOf('"replies":')) + 1));
  assert.deepEqual(replies.map((r: any) => r.commentId), [11]);
  assert.match(replies[0].body, /^<!-- babysitter:reply acme\/widgets#7@b{40} -->\n/);
  assert.match(replies[0].body, /@​dana/);
  assert.ok(!command.includes('Fix the flaky retry in queue.ts.'), 'origin prompt never enters the proposal');
});

test('a head that moves while fixing declines without a proposal', async () => {
  const { f, commands, reasons } = context({ states: [live(), live({ headSha: moved })] });
  await body()(f, input());
  assert.deepEqual(reasons, ['declined']);
  assert.equal(proposeCommand(commands), undefined);
});

test('a refused proposal ends needs_human', async () => {
  const { f, reasons } = context({ proposed: { kind: 'babysitter-refusal', reason: 'changes refused paths: .github/workflows/ci.yml' } });
  await body()(f, input());
  assert.deepEqual(reasons, ['needs_human']);
});

test('by default the fixer dispatches no agent and checks nothing out (gate 8 / #442)', async () => {
  const { f, commands, reasons, agents } = context();
  await getFlowDefinition(createStandaloneFixer(policy)).body(f, input());
  assert.deepEqual(reasons, ['needs_human']);
  assert.equal(agents.length, 0);
  assert.ok(commands.every(c => !c.includes('checkoutHead')));
});

test('the agent outcome is read from a JSON message, a fenced JSON block, or falls back to prose', () => {
  assert.deepEqual(parseOutcome('{"summary":"s","replies":[{"id":1,"body":"b"},{"id":"x","body":"b"}]}'), { summary: 's', replies: [{ id: 1, body: 'b' }] });
  assert.deepEqual(parseOutcome('Done.\n```json\n{"summary":"s2","replies":[]}\n```\n'), { summary: 's2', replies: [] });
  assert.deepEqual(parseOutcome('just prose'), { summary: 'just prose', replies: [] });
});

/** Run the proposal script as f.run would, against a real repository. */
async function runPropose(dir: string, base: string, limits: Partial<{ patchBytes: number; files: number }> = {}): Promise<any> {
  const saved = process.stdout.write; let out = '';
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  try {
    await proposeChanges({ dir, head: base, pullRequest: { owner: 'acme', repo: 'widgets', number: 7 }, summary: 's', replies: [],
      limits: { patchBytes: 36_000, files: 50, proposalBytes: 50_000, refused: REFUSED_PATHS, ...limits } });
  } finally { process.stdout.write = saved; }
  return JSON.parse(out);
}
function repo(): { dir: string; base: string; git: (...a: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'babysitter-fix-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8' }).trim();
  git('init', '-q');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/queue.ts'), 'export const retries = 1;\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  return { dir, base: git('rev-parse', 'HEAD'), git };
}

test('a real proposal covers edits, new files and the agent\'s own commits, all against the bound head', async () => {
  const { dir, base, git } = repo();
  writeFileSync(join(dir, 'src/queue.ts'), 'export const retries = 3;\n');
  git('commit', '-qam', 'agent committed anyway');
  writeFileSync(join(dir, 'src/new.test.ts'), 'test\n');
  const p = await runPropose(dir, base);
  assert.equal(p.kind, 'babysitter-proposal');
  assert.equal(p.baseHead, base);
  assert.deepEqual(p.files, ['src/new.test.ts', 'src/queue.ts']);
  assert.match(p.patch, /-export const retries = 1;\n\+export const retries = 3;/);
  assert.match(p.patch, /new file mode/);
});

test('workflow, secret, oversized and too-wide proposals are refused whole', async () => {
  for (const [path, limits] of [
    ['.github/workflows/ci.yml', {}], ['.env', {}], ['config/.env.production', {}], ['deploy/server.pem', {}], ['.npmrc', {}],
    ['secrets/token.txt', {}], ['src/big.ts', { patchBytes: 10 }], ['src/a.ts', { files: 0 }],
  ] as const) {
    const { dir, base } = repo();
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), 'x\n');
    const p = await runPropose(dir, base, limits);
    assert.equal(p.kind, 'babysitter-refusal', path);
  }
});

test('an untouched checkout proposes an empty patch (replies and summary may still publish)', async () => {
  const { dir, base } = repo();
  const p = await runPropose(dir, base);
  assert.deepEqual([p.kind, p.files, p.patch], ['babysitter-proposal', [], '']);
});

test('the proposal script runs as f.run runs it: a stringified `node -e` command in a shell', () => {
  const { dir, base } = repo();
  writeFileSync(join(dir, 'src/queue.ts'), 'export const retries = 3;\n');
  const command = nodeCommand(proposeChanges, {
    dir, head: base, pullRequest: { owner: 'acme', repo: 'widgets', number: 7 }, summary: "it's fixed", replies: [{ commentId: 11, body: 'done' }],
    limits: { patchBytes: PATCH_MAX_BYTES, files: PATCH_MAX_FILES, proposalBytes: PROPOSAL_MAX_BYTES, refused: REFUSED_PATHS },
  });
  const p = JSON.parse(execFileSync('sh', ['-c', command], { encoding: 'utf8' }));
  assert.deepEqual([p.kind, p.files, p.summary, p.replies], ['babysitter-proposal', ['src/queue.ts'], "it's fixed", [{ commentId: 11, body: 'done' }]]);
});

/** A function's source as it ships: lifted out of the bundled artifact by brace matching. */
function shippedFunction(name: string): string {
  const artifact = readFileSync(fileURLToPath(new URL('../artifacts/babysitter-fixer.flow.ts', import.meta.url)), 'utf8');
  const start = artifact.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} ships in the artifact`);
  let depth = 0;
  for (let i = artifact.indexOf('{', artifact.indexOf(')', start)); i < artifact.length; i++) {
    if (artifact[i] === '{') depth++;
    if (artifact[i] === '}' && --depth === 0) return artifact.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

test('the proposal script lifted from the shipped artifact runs under `node -e`', () => {
  const { dir, base } = repo();
  writeFileSync(join(dir, 'src/queue.ts'), 'export const retries = 3;\n');
  const fn = { toString: () => shippedFunction('proposeChanges') } as unknown as Function;
  const command = nodeCommand(fn, {
    dir, head: base, pullRequest: { owner: 'acme', repo: 'widgets', number: 7 }, summary: 's', replies: [],
    limits: { patchBytes: PATCH_MAX_BYTES, files: PATCH_MAX_FILES, proposalBytes: PROPOSAL_MAX_BYTES, refused: REFUSED_PATHS },
  });
  const p = JSON.parse(execFileSync('sh', ['-c', command], { encoding: 'utf8' }));
  assert.deepEqual([p.kind, p.files], ['babysitter-proposal', ['src/queue.ts']]);
});

test('the proposal never runs code the agent planted in the checkout\'s git config, and its diff format is fixed', async () => {
  const { dir, base, git } = repo();
  const proof = join(dir, '..', `pwned-${Date.now()}`);
  // An agent can write .git/config: an external diff, a clean filter, a hook,
  // and diff prefixes that would change the patch Cloud parses.
  git('config', 'diff.external', `sh -c 'touch ${proof}-diff'`);
  git('config', 'filter.x.clean', `sh -c 'touch ${proof}-filter; cat'`);
  git('config', 'diff.noprefix', 'true');
  git('config', 'diff.mnemonicPrefix', 'true');
  writeFileSync(join(dir, '.gitattributes'), '* filter=x\n');
  mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch ${proof}-hook\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'src/queue.ts'), 'export const retries = 3;\n');
  const p = await runPropose(dir, base);
  assert.equal(p.kind, 'babysitter-proposal');
  assert.match(p.patch, /^diff --git a\/\.gitattributes b\/\.gitattributes$/m);
  assert.match(p.patch, /^--- a\/src\/queue\.ts$/m);
  assert.match(p.patch, /^\+\+\+ b\/src\/queue\.ts$/m);
  for (const suffix of ['-diff', '-filter', '-hook']) {
    assert.throws(() => readFileSync(`${proof}${suffix}`), /ENOENT/, `planted ${suffix} ran`);
  }
});
