import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { getFlowDefinition } from '@relayflows/surface/runtime';
import type { Ctx } from '@relayflows/surface';
import { createStandaloneFixer, parseOutcome } from '../fixer.ts';
import { proposeChanges, PATCH_MAX_BYTES, PATCH_MAX_FILES, PROPOSAL_MAX_BYTES, REFUSED_PATHS } from '../fix.ts';
import { nodeCommand } from '../github.ts';
import { DRIZZLE_META } from '../merge.ts';

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
        if (command.includes('restoreCheckout')) return JSON.stringify({ restored: false });
        if (command.includes('stashCheckout')) return JSON.stringify({ stashed: true });
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
      limits: { patchBytes: 36_000, files: 50, proposalBytes: 50_000, summaryChars: 4_000, refused: REFUSED_PATHS, meta: DRIZZLE_META, ...limits } });
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
    limits: { patchBytes: PATCH_MAX_BYTES, files: PATCH_MAX_FILES, proposalBytes: PROPOSAL_MAX_BYTES, refused: REFUSED_PATHS, meta: DRIZZLE_META },
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
    limits: { patchBytes: PATCH_MAX_BYTES, files: PATCH_MAX_FILES, proposalBytes: PROPOSAL_MAX_BYTES, refused: REFUSED_PATHS, meta: DRIZZLE_META },
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

test('paths git would have to quote are refused; a newline cannot split a name past the workflow rule', async () => {
  for (const name of ['.github/workflows/a\nb.yml', 'src/"quoted".ts', 'src/back\\slash.ts']) {
    const { dir, base } = repo();
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), 'x\n');
    const p = await runPropose(dir, base);
    assert.equal(p.kind, 'babysitter-refusal', JSON.stringify(name));
  }
});

test('a non-ASCII name is proposed unquoted, so Cloud parses the same path', async () => {
  const { dir, base } = repo();
  writeFileSync(join(dir, 'src/café.ts'), 'x\n');
  const p = await runPropose(dir, base);
  assert.deepEqual(p.files, ['src/café.ts']);
  assert.match(p.patch, /^diff --git a\/src\/café\.ts b\/src\/café\.ts$/m);
});

test('the fixer runs the origin session\'s own CLI with its literal pinned model', async () => {
  const { f, agents } = context();
  const codex = input();
  (codex.babysitter as any).originContext = { ...originContext, source: 'codex' };
  await body()(f, codex);
  assert.deepEqual([agents[0]!.options.cli, agents[0]!.options.model], ['codex', 'gpt-5.6-sol']);
  const claude = context();
  await body()(claude.f, input());
  assert.deepEqual([claude.agents[0]!.options.cli, claude.agents[0]!.options.model], ['claude', 'claude-sonnet-5']);
});

test('a PR checkout survives between runs: restored into the run root, stashed back after', async () => {
  const { restoreCheckout, stashCheckout } = await import('../fix.ts');
  const home = mkdtempSync(join(tmpdir(), 'babysitter-home-'));
  const runRoot = mkdtempSync(join(tmpdir(), 'babysitter-run-'));
  const pr = { owner: 'Acme', repo: 'Widgets', number: 7, home };
  const capture = async (fn: () => Promise<void>) => {
    const saved = process.stdout.write; let out = '';
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    const cwd = process.cwd(); process.chdir(runRoot);
    try { await fn(); } finally { process.stdout.write = saved; process.chdir(cwd); }
    return JSON.parse(out);
  };
  // First run: nothing cached.
  assert.deepEqual(await capture(() => restoreCheckout(pr)), { restored: false });
  // The run builds a checkout with installed dependencies, then stashes it.
  mkdirSync(join(runRoot, 'babysitter-checkout', '.git'), { recursive: true });
  mkdirSync(join(runRoot, 'babysitter-checkout', 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(runRoot, 'babysitter-checkout', 'node_modules', 'dep', 'index.js'), 'installed\n');
  assert.deepEqual(await capture(() => stashCheckout(pr)), { stashed: true });
  assert.throws(() => readFileSync(join(runRoot, 'babysitter-checkout', 'node_modules', 'dep', 'index.js')), /ENOENT/);
  // Next run (fresh run root, same sandbox home): the checkout comes back with its dependencies.
  const next = mkdtempSync(join(tmpdir(), 'babysitter-run-'));
  const cwd = process.cwd(); process.chdir(next);
  const saved = process.stdout.write; let out = '';
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  try { await restoreCheckout(pr); } finally { process.stdout.write = saved; process.chdir(cwd); }
  assert.deepEqual(JSON.parse(out), { restored: true });
  assert.equal(readFileSync(join(next, 'babysitter-checkout', 'node_modules', 'dep', 'index.js'), 'utf8'), 'installed\n');
});

test('the fixer restores the cached checkout before checking out, and stashes it even when the agent fails', async () => {
  const ok = context();
  await body()(ok.f, input());
  const order = ok.commands.map(c => ['restoreCheckout', 'checkoutHead', 'proposeChanges', 'stashCheckout'].find(n => c.includes(n))).filter(Boolean);
  assert.deepEqual(order, ['restoreCheckout', 'checkoutHead', 'proposeChanges', 'stashCheckout']);
  const failing = context();
  (failing.f as any).agent = async () => { throw new Error('agent crashed'); };
  await assert.rejects(body()(failing.f, input()), /agent crashed/);
  assert.ok(failing.commands.some(c => c.includes('stashCheckout')), 'stashed after a failure');
});

test('restore and stash lifted from the shipped artifact run under `node -e`', () => {
  const home = mkdtempSync(join(tmpdir(), 'babysitter-home-'));
  const runRoot = mkdtempSync(join(tmpdir(), 'babysitter-run-'));
  mkdirSync(join(runRoot, 'babysitter-checkout', '.git'), { recursive: true });
  const run = (name: string) => JSON.parse(execFileSync('sh', ['-c', nodeCommand({ toString: () => shippedFunction(name) } as unknown as Function,
    { owner: 'acme', repo: 'widgets', number: 7, home })], { cwd: runRoot, encoding: 'utf8' }));
  assert.deepEqual(run('stashCheckout'), { stashed: true });
  assert.deepEqual(run('restoreCheckout'), { restored: true });
});

/** Run checkoutHead as f.run would, fetching from a local repository instead of GitHub. */
async function runCheckout(runRoot: string, origin: string, head: string): Promise<any> {
  const { checkoutHead } = await import('../fix.ts');
  const saved = { write: process.stdout.write, token: process.env.GH_TOKEN, cwd: process.cwd() };
  let out = '';
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  process.env.GH_TOKEN = 'test-token';
  process.chdir(runRoot);
  try { await checkoutHead({ owner: 'acme', repo: 'widgets', head, origin }); }
  finally { process.stdout.write = saved.write; process.chdir(saved.cwd); if (saved.token === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved.token; }
  return JSON.parse(out);
}

function upstream(): { dir: string; commit: (files: Record<string, string>) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'babysitter-upstream-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'uploadpack.allowReachableSHA1InWant', 'true');
  return {
    dir,
    commit(files) {
      for (const [path, content] of Object.entries(files)) { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), content); }
      git('add', '-A'); git('commit', '-qm', 'c');
      return git('rev-parse', 'HEAD');
    },
  };
}

test('a checkout whose filesystem dropped executable bits reads as clean', async () => {
  const up = upstream();
  up.commit({ 'bin/run.sh': '#!/bin/sh\n' });
  chmodSync(join(up.dir, 'bin/run.sh'), 0o755);
  const head = up.commit({});
  const runRoot = mkdtempSync(join(tmpdir(), 'babysitter-run-'));
  await runCheckout(runRoot, up.dir, head);
  const dir = join(runRoot, 'babysitter-checkout');
  chmodSync(join(dir, 'bin/run.sh'), 0o644);
  const status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' });
  assert.equal(status, '');
});

test('a reused checkout keeps its dependencies but none of the agent\'s git state, and lands exactly on the head', async () => {
  const up = upstream();
  const first = up.commit({ '.gitignore': 'node_modules/\n', 'package.json': '{"name":"w"}\n', 'package-lock.json': '{"v":1}\n', 'src/a.ts': 'a\n' });
  const runRoot = mkdtempSync(join(tmpdir(), 'babysitter-run-'));
  assert.deepEqual(await runCheckout(runRoot, up.dir, first), { dir: join(runRoot, 'babysitter-checkout'), head: first, reused: false });
  const dir = join(runRoot, 'babysitter-checkout');
  // The previous run installed dependencies, edited a tracked file, left junk, and planted git config.
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'installed\n');
  writeFileSync(join(dir, 'src/a.ts'), 'agent edit\n');
  writeFileSync(join(dir, 'junk.txt'), 'x\n');
  const proof = join(tmpdir(), `planted-${Date.now()}`);
  writeFileSync(join(dir, '.git', 'config'), `[core]\n\tfsmonitor = sh -c 'touch ${proof}'\n`);
  const second = up.commit({ 'src/a.ts': 'b\n' });
  assert.deepEqual(await runCheckout(runRoot, up.dir, second), { dir, head: second, reused: true });
  assert.equal(readFileSync(join(dir, 'src/a.ts'), 'utf8'), 'b\n');
  assert.equal(readFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'utf8'), 'installed\n', 'dependencies survive an unchanged lockfile');
  assert.throws(() => readFileSync(join(dir, 'junk.txt')), /ENOENT/);
  assert.throws(() => readFileSync(proof), /ENOENT/, 'agent-planted git config never ran');
});

test('a dependency manifest that changed between heads drops the cached dependencies', async () => {
  const up = upstream();
  const first = up.commit({ '.gitignore': 'node_modules/\n', 'package-lock.json': '{"v":1}\n' });
  const runRoot = mkdtempSync(join(tmpdir(), 'babysitter-run-'));
  await runCheckout(runRoot, up.dir, first);
  const dir = join(runRoot, 'babysitter-checkout');
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'old\n');
  const second = up.commit({ 'package-lock.json': '{"v":2}\n' });
  await runCheckout(runRoot, up.dir, second);
  assert.throws(() => readFileSync(join(dir, 'node_modules', 'dep', 'index.js')), /ENOENT/);
});

test('a damaged cached .git is replaced, not reused', async () => {
  const up = upstream();
  const head = up.commit({ 'a.txt': 'a\n' });
  const runRoot = mkdtempSync(join(tmpdir(), 'babysitter-run-'));
  mkdirSync(join(runRoot, 'babysitter-checkout'), { recursive: true });
  writeFileSync(join(runRoot, 'babysitter-checkout', '.git'), 'gitdir: /nowhere\n');
  assert.deepEqual((await runCheckout(runRoot, up.dir, head)).head, head);
  assert.equal(readFileSync(join(runRoot, 'babysitter-checkout', 'a.txt'), 'utf8'), 'a\n');
});

test('cache moves never fail the run: an unwritable cache only means the next run starts fresh', async () => {
  const { stashCheckout } = await import('../fix.ts');
  const runRoot = mkdtempSync(join(tmpdir(), 'babysitter-run-'));
  mkdirSync(join(runRoot, 'babysitter-checkout', '.git'), { recursive: true });
  const blocker = join(mkdtempSync(join(tmpdir(), 'babysitter-home-')), 'home-is-a-file');
  writeFileSync(blocker, 'x');
  const saved = { write: process.stdout.write, cwd: process.cwd() }; let out = '';
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  process.chdir(runRoot);
  try { await stashCheckout({ owner: 'acme', repo: 'widgets', number: 7, home: blocker }); }
  finally { process.stdout.write = saved.write; process.chdir(saved.cwd); }
  assert.deepEqual(JSON.parse(out), { stashed: false });
});

test('flows check still sees the fixer\'s agent requirement', () => {
  const artifact = readFileSync(fileURLToPath(new URL('../artifacts/babysitter-fixer.flow.ts', import.meta.url)), 'utf8');
  const body = artifact.slice(artifact.indexOf('function createStandaloneFixer('));
  const fn = body.slice(0, body.indexOf('\n}\n'));
  assert.doesNotMatch(fn, /async function fixAndPropose/, 'agent calls stay in the registered body');
});

test('checkoutHead lifted from the shipped artifact runs under `node -e`', () => {
  const up = upstream();
  const head = up.commit({ 'a.txt': 'a\n' });
  const runRoot = mkdtempSync(join(tmpdir(), 'babysitter-run-'));
  const command = nodeCommand({ toString: () => shippedFunction('checkoutHead') } as unknown as Function, { owner: 'acme', repo: 'widgets', head, origin: up.dir });
  const out = JSON.parse(execFileSync('sh', ['-c', command], { cwd: runRoot, encoding: 'utf8', env: { ...process.env, GH_TOKEN: 'test-token' } }));
  assert.deepEqual([out.head, out.reused], [head, false]);
});

test('a restored PR checkout brings back its session, and a stash records the new one', async () => {
  const { restoreCheckout, stashCheckout } = await import('../fix.ts');
  const home = mkdtempSync(join(tmpdir(), 'babysitter-home-'));
  const pr = { owner: 'acme', repo: 'widgets', number: 7, home };
  const inRun = async (fn: () => Promise<void>) => {
    const runRoot = mkdtempSync(join(tmpdir(), 'babysitter-run-'));
    const saved = { write: process.stdout.write, cwd: process.cwd() }; let out = '';
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    process.chdir(runRoot);
    try { await fn(); } finally { process.stdout.write = saved.write; process.chdir(saved.cwd); }
    return { runRoot, value: JSON.parse(out) };
  };
  const first = await inRun(async () => {
    mkdirSync(join(process.cwd(), 'babysitter-checkout'));
    await stashCheckout({ ...pr, session: { cli: 'claude', sessionId: 'sess-1' } });
  });
  assert.deepEqual(first.value, { stashed: true });
  const second = await inRun(() => restoreCheckout(pr));
  assert.deepEqual(second.value, { restored: true, session: { cli: 'claude', sessionId: 'sess-1' } });
  // A run whose agent reported no session forgets the old one.
  await inRun(async () => { mkdirSync(join(process.cwd(), 'babysitter-checkout')); await stashCheckout(pr); });
  assert.deepEqual((await inRun(() => restoreCheckout(pr))).value, { restored: true });
});

function resumeContext(restored: Record<string, unknown>, agentFails?: (options: Record<string, unknown>) => boolean) {
  const ctx = context();
  (ctx.f as any).run = async (command: string) => {
    ctx.commands.push(command);
    if (command.includes('githubRead')) return JSON.stringify(live());
    if (command.includes('readSignals')) return JSON.stringify(signals);
    if (command.includes('restoreCheckout')) return JSON.stringify(restored);
    if (command.includes('checkoutHead')) return JSON.stringify({ dir: '/run/babysitter-checkout', head, reused: true });
    if (command.includes('proposeChanges')) return JSON.stringify(proposal);
    if (command.includes('stashCheckout')) return JSON.stringify({ stashed: true });
    return '';
  };
  (ctx.f as any).agent = async (name: string, options: Record<string, unknown>) => {
    ctx.agents.push({ name, options });
    if (agentFails?.(options)) throw new Error('No conversation found with session ID: sess-1');
    return { completionReason: 'success', artifacts: [], summary: '{"summary":"s","replies":[]}', sessionId: 'sess-2' };
  };
  return ctx;
}

test('a wake on a reused box resumes the previous agent session and records the new one', async () => {
  const ctx = resumeContext({ restored: true, session: { cli: 'claude', sessionId: 'sess-1' } });
  await body()(ctx.f, input());
  assert.deepEqual(ctx.reasons, ['success']);
  assert.equal(ctx.agents[0]!.options.resume, 'sess-1');
  assert.match(ctx.commands.find(c => c.includes('stashCheckout'))!, /"session":\{"cli":"claude","sessionId":"sess-2"\}/);
});

test('a fresh box, or a session from another CLI, starts without resume', async () => {
  for (const restored of [{ restored: false }, { restored: true, session: { cli: 'codex', sessionId: 'sess-1' } }]) {
    const ctx = resumeContext(restored);
    await body()(ctx.f, input());
    assert.equal(ctx.agents[0]!.options.resume, undefined, JSON.stringify(restored));
  }
});

test('a session the CLI no longer has falls back to a fresh agent with the origin context', async () => {
  const ctx = resumeContext({ restored: true, session: { cli: 'claude', sessionId: 'sess-1' } }, options => options.resume !== undefined);
  await body()(ctx.f, input());
  assert.deepEqual(ctx.reasons, ['success']);
  assert.deepEqual(ctx.agents.map(a => [a.name, a.options.resume]), [['babysitter-fix', 'sess-1'], ['babysitter-fix-fresh', undefined]]);
  assert.match(String(ctx.agents[1]!.options.task), /BEGIN ORIGINAL TASK/);
});
