/**
 * `f.gitlab` carries comments and discussions only, where `f.github` carries
 * issues, pull requests and the rest. The catalog says so, and every layer an
 * author can reach the gap through says so too — statically at check time, and
 * at the call site for a name only computable at runtime.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { flow, type Ctx } from '@relayflows/surface';
import { createHelpers } from '@relayflows/surface/runtime';
import { checkProviderHelpers } from '../src/slack-preflight.js';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { JournalClient } from '../src/journal-client.js';
import { runCli } from '../src/cli.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const mountKeys = ['RELAYFILE_MOUNT_PATH', 'WORKSPACE_ROOT', 'WORKFORCE_SANDBOX_ROOT', 'RELAYFILE_MOUNT_ROOT', 'RELAYFILE_ROOT'];
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temporary() { const dir = mkdtempSync(join(tmpdir(), 'gitlab-partial-')); dirs.push(dir); return dir; }

const unavailable = 'f.gitlab.issues is unavailable; available resources: comments, discussions.'
  + ' Comments and discussions only. Issue list/read/create and merge-request'
  + ' list/read/create are unavailable through f.gitlab.';
/** A mount and mock that would satisfy every other provider question. */
function satisfied() {
  const dir = temporary();
  mkdirSync(join(dir, 'gitlab'));
  mkdirSync(join(dir, 'github'));
  vi.stubEnv('RELAYFILE_MOUNT_PATH', dir);
  vi.stubEnv('RELAYFLOWS_GITLAB_MOCK', '1');
  vi.stubEnv('RELAYFLOWS_GITHUB_MOCK', '1');
}
const refusal = (body: Function) => checkProviderHelpers({ body }).diagnostics
  .filter(d => d.severity === 'refusal');
/** A body whose `toString` is the given source verbatim, untouched by this file's transform. */
const fromSource = (source: string): Function => new Function(`return ${source};`)() as Function;

it('refuses a gitlab resource the helper does not carry, naming the ones it does', () => {
  satisfied();
  expect(refusal(async (f: any) => { await f.gitlab.issues.list({ projectPath: 'g/p' }); }))
    .toEqual([{ severity: 'refusal', kind: 'helper_provider.unsupported', message: unavailable }]);
});

it('reads the access however it is written: brackets, spacing, and a renamed context parameter', () => {
  satisfied();
  for (const body of [
    async (f: any) => { await f['gitlab']['issues'].list({}); },
    async (f: any) => { await f . gitlab . issues . list({}); },
    async (ctx: any) => { await ctx.gitlab.issues.list({}); },
    function (f: any) { return f.gitlab.issues; },
  ]) expect(refusal(body), body.toString()).toHaveLength(1);
  expect(refusal(async (f: any) => { await f.gitlab['mergeRequests'].write({}, {}); })[0]?.message)
    .toContain('f.gitlab.mergeRequests is unavailable; available resources: comments, discussions.');
});

it('refuses before the mount question and regardless of mock mode', () => {
  // Installing a mount cannot conjure a writeback route no client carries, so
  // `mount_required` would send the author to fix the wrong thing.
  for (const key of [...mountKeys, 'RELAYFLOWS_GITLAB_MOCK']) vi.stubEnv(key, '');
  const unmounted = refusal(async (f: any) => { await f.gitlab.issues.list({}); });
  expect(unmounted.map(d => d.kind)).toEqual(['helper_provider.unsupported']);
  expect(unmounted[0]?.message).toBe(unavailable);
  satisfied();
  expect(refusal(async (f: any) => { await f.gitlab.issues.list({}); })[0]?.message).toBe(unavailable);
});

it('accepts the resources gitlab does carry, and leaves github alone', () => {
  satisfied();
  expect(checkProviderHelpers({ body: async (f: Ctx) => {
    await f.gitlab.comments.write({ projectPath: 'g/p', issueIid: '1', slug: 's' }, { text: 'hi' });
    await f.gitlab.discussions.list({ projectPath: 'g/p', issueIid: '1', slug: 's' });
  } }).ok).toBe(true);
  expect(checkProviderHelpers({ body: async (f: any) => {
    await f.github.issues.list({ owner: 'o', repo: 'r' });
    await f.github.pullRequests?.list?.({ owner: 'o', repo: 'r' });
  } }).ok).toBe(true);
});

it('admits every member the guarded helper still resolves', () => {
  satisfied();
  // The runtime guard refuses only what the bound object does not have, so
  // inherited object behaviour, `then` and `toJSON` all still resolve. Static
  // inspection has to admit exactly those, or `flows check` rejects feature
  // detection that runs.
  const gitlab = createHelpers(() => { throw new Error('a refusal must not dispatch'); })
    .gitlab as unknown as Record<string, any>;
  expect(gitlab.hasOwnProperty('comments')).toBe(true);
  expect(gitlab.toJSON).toBeUndefined();
  expect(gitlab.then).toBeUndefined();
  expect(String(gitlab)).toBe('[object Object]');
  for (const body of [
    (f: any) => f.gitlab.hasOwnProperty('comments'),
    (f: any) => f.gitlab.toJSON,
    (f: any) => f.gitlab.then,
    (f: any) => f.gitlab.toString(),
    (f: any) => f.gitlab['propertyIsEnumerable']('discussions'),
  ]) expect(refusal(body), body.toString()).toEqual([]);
});

it('does not read a regex literal as an access, and still reads a division as code', () => {
  satisfied();
  // `/f.gitlab.issues/` inspects text; it reaches no helper at all.
  expect(refusal((f: any) => /f.gitlab.issues/.test(String(f.gitlab.comments)))).toEqual([]);
  expect(refusal((f: any) => { if (f) /f.gitlab.mergeRequests/.test('x'); return f.gitlab.discussions; })).toEqual([]);
  // A `/` that opens no literal is arithmetic, and the access after it stands.
  const divided = (f: any) => { const half = 10 / 2; return [f.gitlab.issues, half]; };
  expect(refusal(divided)[0]?.message).toBe(unavailable);
});

it('declines to judge a body that binds the context parameter name again', () => {
  satisfied();
  // Renaming a local callback parameter cannot decide whether a flow is
  // admitted; an inner `f` is a record here, not the flow context. Built from
  // source text because this file's own transform renames a shadowed binding,
  // which would leave nothing shadowed for preflight to read.
  for (const source of [
    '(f) => [{ gitlab: { issues: [] } }].map(f => f.gitlab.issues)',
    '(f) => [{ gitlab: { issues: [] } }].map(function (f) { return f.gitlab.issues; })',
    '(f) => { const rows = [{ gitlab: { issues: 1 } }]; for (const f of rows) void f.gitlab.issues; }',
    '(f) => { try { void f; } catch (f) { void f.gitlab.issues; } }',
    '(f) => { f = { gitlab: { issues: 1 } }; return f.gitlab.issues; }',
  ]) expect(refusal(fromSource(source)), source).toEqual([]);
  // The unshadowed body each is distinguished from still refuses.
  expect(refusal(fromSource('(f) => f.gitlab.issues'))[0]?.message).toBe(unavailable);
});

it('declines to judge destructured declarations and method parameters too', () => {
  satisfied();
  // `const { f } = …` and `read(f) { … }` bind the name without a form the
  // simple-declaration or keyword-parameter rules can see. Both bodies here
  // return 42 without touching a GitLab helper, so refusing either would be
  // the scanner deciding admission on a renamed local — the finding this
  // test pins closed.
  for (const source of [
    '(f) => { { const { f } = { f: { gitlab: { issues: 42 } } }; return f.gitlab.issues; } }',
    '(f) => { { const [f] = [{ gitlab: { issues: 42 } }]; return f.gitlab.issues; } }',
    '(f) => ({ read(f) { return f.gitlab.issues; } }).read({ gitlab: { issues: 42 } })',
    '(f) => new class { read(f) { return f.gitlab.issues; } }().read({ gitlab: { issues: 42 } })',
    '(f) => ({ read({ f }) { return f.gitlab.issues; } }).read({ f: { gitlab: { issues: 42 } } })',
  ]) expect(refusal(fromSource(source)), source).toEqual([]);
  // A control clause is not a parameter list: `if (f) {` binds nothing, so a
  // plain access under it still refuses.
  expect(refusal(fromSource('(f) => { if (f) { return f.gitlab.issues; } }'))[0]?.message)
    .toBe(unavailable);
});

it('does not read a comment or a string literal as an access', () => {
  satisfied();
  // The body is read from `toString`, never executed; text that looks like an
  // access but is not code must not refuse a correct flow.
  const commented = async (f: Ctx) => {
    // f.gitlab.issues.list({}) is what an author might reach for first.
    const sample = 'f.gitlab.mergeRequests.write';
    const template = `see ${'f.gitlab.issues'} instead`;
    await f.gitlab.comments.write({ projectPath: 'g/p', issueIid: '1', slug: 's' }, { text: sample + template });
  };
  expect(checkProviderHelpers({ body: commented })).toMatchObject({ ok: true, diagnostics: [] });
});

it('refuses a computed member at the call site, as a typed helper_provider.unsupported', async () => {
  satisfied();
  let reached = false;
  const handle = flow('gitlab-dynamic', async f => {
    const resource = ['iss', 'ues'].join('');
    reached = true;
    await (f as any).gitlab[resource].list({ projectPath: 'g/p' });
    f.done('success');
  });
  // Static inspection cannot decide a computed name, so this one is the
  // runtime guard's: it must still refuse with the same code and wording.
  expect(checkProviderHelpers({ body: handle as unknown as Function }).ok).toBe(true);
  await expect(executeAuthoredFlow(handle, new JournalClient('/must-not-connect')))
    .rejects.toMatchObject({ code: 'helper_provider.unsupported', message: `helper_provider.unsupported: ${unavailable}` });
  expect(reached).toBe(true);
});

it('words the static refusal exactly as the surface words the runtime guard', async () => {
  satisfied();
  // The SDK cannot import the surface's wording function: this source is
  // installed against a PUBLISHED surface, and a named import the pinned
  // version has not shipped fails the module at load, before preflight can
  // run. The two wordings are pinned equal here instead, against whichever
  // surface this SDK actually resolves.
  const runtime = await import('@relayflows/surface/runtime') as {
    unsupportedHelperMemberMessage?: (provider: string, member: string, available: readonly string[]) => string;
  };
  const wording = runtime.unsupportedHelperMemberMessage;
  expect(wording?.('gitlab', 'issues', ['comments', 'discussions']) ?? unavailable).toBe(unavailable);
  expect(refusal(async (f: any) => { await f.gitlab.issues.list({}); })[0]?.message).toBe(unavailable);
});

it('leaves an unrelated body failure exactly as the body threw it', async () => {
  satisfied();
  const handle = flow('gitlab-unrelated', async f => {
    void f;
    throw new TypeError('authored code broke on its own');
  });
  await expect(executeAuthoredFlow(handle, new JournalClient('/must-not-connect')))
    .rejects.toThrow(new TypeError('authored code broke on its own'));
});

it('reports the refusal from `flows check` on an authored flow file', async () => {
  satisfied();
  const dir = temporary();
  mkdirSync(join(dir, 'node_modules/@relayflows'), { recursive: true });
  symlinkSync(join(root, 'packages/sdk/node_modules/@relayflows/surface'), join(dir, 'node_modules/@relayflows/surface'));
  const surface = JSON.stringify(join(root, 'packages/sdk/node_modules/@relayflows/surface/dist/index.js'));
  const fixture = join(dir, 'gitlab-triage.flow.ts');
  writeFileSync(fixture, `import { flow } from ${surface};\n`
    + `export default flow('gitlab-triage', async (f: any) => {\n`
    + `  const open = await f.gitlab.issues.list({ projectPath: 'g/p' });\n`
    + `  await f.gitlab.mergeRequests.write({ projectPath: 'g/p' }, { title: String(open) });\n`
    + `  f.done('success');\n});\n`);
  const output: string[] = [];
  expect(await runCli(['check', '--json', fixture], { stdout: line => output.push(line), stderr: line => output.push(line) })).toBe(2);
  expect(output.join('')).toContain('helper_provider.unsupported');
  expect(output.join('')).toContain('f.gitlab.issues is unavailable; available resources: comments, discussions.');
}, 30_000);
