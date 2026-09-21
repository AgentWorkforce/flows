import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAuthoredFlow } from '../src/authored-flow-loader.js';
import { deployToCloud, parseTriggerSource } from '../src/cloud-deploy.js';
import { collectExtensionSubmissions } from '../src/flow-extension-submit.js';
import { addExtensionPlugin } from '../src/cli/add-extension.js';
import { checkAuthoredTriggers } from '../src/cli/check-triggers.js';
import { runCli } from '../src/cli.js';
import { readPluginLock } from '../src/plugin-lock.js';
import { loadPlugins } from '../src/plugin-loader.js';
import { pluginStoreDirectory } from '../src/plugin-store.js';
import { preflightProviderTriggers } from '../src/provider-trigger-contract.js';
import { SHA_A, SHA_B, entriesFromDirectory, fakeGithub, type FakeEntry } from './fake-github.js';

const fixtureRoot = resolve('../../testdata/plugins');
const babysitter = entriesFromDirectory(join(fixtureRoot, 'extension-babysitter'), 'examples/babysitter');
const manifestJson = JSON.parse(readFileSync(join(fixtureRoot, 'extension-babysitter/flows-plugin.json'), 'utf8'));
const REF = `github:AgentWorkforce/flows@${SHA_A}#examples/babysitter`;
const versions = { sdk: '2.0.22', surface: '2.0.22' };
const now = () => new Date('2026-09-20T12:00:00Z');
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true }));
});

const BASE = `
  import { flow, github } from '@relayflows/surface';
  export default flow('software-factory', { budget: { dollars: 10, wallclock: '1h' } }, async f => { f.done('success'); })
    .on(github.issues({ action: 'opened' }), async f => { f.done('success'); });
`;

/** A project the way an operator has one: flows.json, the base flow, and a resolvable surface. */
function project(base = BASE) {
  const cwd = mkdtempSync(join(tmpdir(), 'flow-compose-')); dirs.push(cwd);
  mkdirSync(join(cwd, 'node_modules/@relayflows'), { recursive: true });
  symlinkSync(resolve('node_modules/@relayflows/surface'), join(cwd, 'node_modules/@relayflows/surface'));
  writeFileSync(join(cwd, 'package.json'), '{"type":"module"}');
  writeFileSync(join(cwd, 'flows.json'), JSON.stringify({ cli: 'claude', executors: ['github'] }));
  writeFileSync(join(cwd, 'software-factory.flow.ts'), base);
  const messages: string[] = [];
  const io = { stdout: (s: string) => messages.push(s), stderr: (s: string) => messages.push(s) };
  return { cwd, io, messages, text: () => messages.join('\n'), flow: join(cwd, 'software-factory.flow.ts') };
}
function repo(entries: FakeEntry[]) {
  return fakeGithub({ 'AgentWorkforce/flows': { refs: { main: SHA_A }, commits: { [SHA_A]: { entries } } } }).fetch;
}
function variant(patch: (m: Record<string, unknown>) => unknown, entry?: string): FakeEntry[] {
  return babysitter.map(e => {
    if (e.path.endsWith('flows-plugin.json')) return { ...e, data: Buffer.from(JSON.stringify(patch(structuredClone(manifestJson)))) };
    if (entry !== undefined && e.path.endsWith('babysitter.flow.ts')) return { ...e, data: Buffer.from(entry) };
    return e;
  });
}
async function install(p: ReturnType<typeof project>, entries: FakeEntry[] = babysitter, ref = REF, fetch = repo(entries)) {
  expect(await addExtensionPlugin(ref, p.io, { cwd: p.cwd, fetch, now, versions })).toBe(0);
  p.messages.length = 0;
}
const subscriptions = (loaded: Awaited<ReturnType<typeof loadAuthoredFlow>>) =>
  loaded.getDefinition(loaded.handle).handlers.map(h => {
    const f = h.trigger.kind === 'webhook' ? h.trigger.filter as { type: string; payload?: { action?: string } } : undefined;
    return f === undefined ? h.trigger.kind : `${f.type}${f.payload?.action === undefined ? '' : `.${f.payload.action}`}`;
  });

describe('composing flow extensions onto a base flow', () => {
  it('appends the Babysitter handler surface after the base, in lock order, without touching the base definition', async () => {
    const p = project();
    await install(p);
    const loaded = await loadAuthoredFlow(p.flow, { versions });
    expect(loaded.extensions.map(e => ({ name: e.name, ref: e.ref, handlers: e.handlers.length }))).toEqual([{ name: 'babysitter', ref: REF, handlers: 8 }]);
    expect(subscriptions(loaded)).toEqual([
      'issues.opened',
      'pull_request.opened', 'pull_request.synchronize', 'pull_request.reopened', 'pull_request.closed',
      'pull_request_review.submitted', 'pull_request_review.dismissed', 'check_run.completed', 'issue_comment.created',
    ]);
    const composed = loaded.getDefinition(loaded.handle);
    expect(Object.isFrozen(composed) && Object.isFrozen(composed.handlers)).toBe(true);
    // The base's own definition, as its surface copy holds it, is unchanged.
    expect(loaded.graph[0]!.getDefinition(loaded.handle).handlers).toHaveLength(1);
    expect(composed.name).toBe('software-factory');
    expect(composed.header).toBe(loaded.graph[0]!.getDefinition(loaded.handle).header);
    expect(loaded.graph.map(node => node.handle.name)).toEqual(['software-factory', 'babysitter']);
    // Compare canonical paths: the loader realpaths the root (macOS tmpdir is a
    // symlink, /var → /private/var), and the store path derives from that root.
    expect(realpathSync(loaded.graph[1]!.path)).toBe(realpathSync(join(pluginStoreDirectory(p.cwd, 'babysitter', loaded.extensions[0]!.digest), 'babysitter.flow.ts')));
    // Every composed subscription is one the surface registry can lower.
    expect(preflightProviderTriggers(composed.handlers.map(h => h.trigger))).toEqual([]);
    // The extension's own handle is not the root: asking for its definition goes to the surface, not the composition.
    expect(loaded.getDefinition(loaded.extensions[0]!.handle).handlers).toHaveLength(8);
    // Its graph node resolves through the accessor its own entry import returned, not the root's.
    const node = loaded.graph[1]!;
    expect(node.getDefinition).toBe(loaded.extensions[0]!.getDefinition);
    expect(node.getDefinition(node.handle).name).toBe('babysitter');
    expect(node.getDefinition(node.handle).handlers).toHaveLength(8);
  });
  it('loads the root alone with extensions: none, and helper loading ignores extension entries', async () => {
    const p = project();
    await install(p);
    const alone = await loadAuthoredFlow(p.flow, { extensions: 'none' });
    expect(alone.extensions).toEqual([]);
    expect(subscriptions(alone)).toEqual(['issues.opened']);
    expect(await loadPlugins(p.cwd)).toEqual([]);
  });
  it('composes two extensions in declaration order, and the order is the lockfile order', async () => {
    const second = variant(m => ({ ...m, name: 'second', triggers: [{ provider: 'github', event: 'issues', actions: ['closed'] }] }),
      "import { flow, github } from '@relayflows/surface';\nexport default flow('second', async f => { f.done('success'); }).on(github.issues({ action: 'closed' }), async f => { f.done('success'); });\n")
      .map(e => ({ ...e, path: e.path.replace('examples/babysitter', 'examples/second') }));
    const fetch = fakeGithub({ 'AgentWorkforce/flows': { refs: { main: SHA_A }, commits: { [SHA_A]: { entries: babysitter }, [SHA_B]: { entries: second } } } }).fetch;
    const SECOND = `github:AgentWorkforce/flows@${SHA_B}#examples/second`;
    const forward = project();
    await install(forward, babysitter, REF, fetch);
    await install(forward, second, SECOND, fetch);
    expect(readPluginLock(forward.cwd).plugins.map(e => [e.order, e.name])).toEqual([[1, 'babysitter'], [2, 'second']]);
    const loadedForward = await loadAuthoredFlow(forward.flow, { versions });
    expect(loadedForward.extensions.map(e => e.name)).toEqual(['babysitter', 'second']);
    expect(subscriptions(loadedForward).at(-1)).toBe('issues.closed');
    const reverse = project();
    await install(reverse, second, SECOND, fetch);
    await install(reverse, babysitter, REF, fetch);
    const loadedReverse = await loadAuthoredFlow(reverse.flow, { versions });
    expect(loadedReverse.extensions.map(e => e.name)).toEqual(['second', 'babysitter']);
    expect(subscriptions(loadedReverse).slice(0, 2)).toEqual(['issues.opened', 'issues.closed']);
  });
  it('flows check reports the composition and keeps the composed triggers deliverable', async () => {
    const p = project();
    await install(p);
    const { report } = await checkAuthoredTriggers(p.flow);
    expect(report.ok).toBe(true);
    expect(report.extensions).toEqual([{ name: 'babysitter', version: '0.1.0', ref: REF, digest: expect.stringMatching(/^[0-9a-f]{64}$/), handlers: 8, hooks: [] }]);
    expect(report.requirements?.integrations.map(i => i.provider)).toContain('github');
    expect(report.requirements?.harnessUses).toContainEqual({ harness: 'claude', detail: 'plugin "babysitter"' });
    expect(await runCli(['check', p.flow], p.io)).toBe(0);
    expect(p.text()).toContain(`EXTENSION babysitter@0.1.0 ${REF} sha256:`);
    expect(p.text()).toContain('8 handler(s) composed after the base flow');
    const loaded = await loadAuthoredFlow(p.flow, { versions });
    const submissions = await collectExtensionSubmissions(loaded);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({ name: 'babysitter', ref: REF });
    expect(submissions[0]!.files.some(f => f.path === 'babysitter.flow.ts' && f.encoding === 'utf8')).toBe(true);
    expect(submissions[0]!.files.reduce((n, f) => n + f.bytes, 0)).toBeGreaterThan(0);
  });
  it('flows check probes extension preflight before reporting the project healthy', async () => {
    const p = project();
    await install(p, variant(m => ({
      ...m,
      preflight: { credentials: ['FLOWS_TEST_MISSING_EXTENSION_CREDENTIAL'], servers: [] },
    })));
    const { report } = await checkAuthoredTriggers(p.flow);
    expect(report.ok).toBe(false);
    expect(report.diagnostics[0]).toMatchObject({
      kind: 'plugin_credential_missing',
      message: expect.stringContaining('FLOWS_TEST_MISSING_EXTENSION_CREDENTIAL'),
    });
    const loaded = await loadAuthoredFlow(p.flow, { versions });
    await expect(collectExtensionSubmissions(loaded)).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('FLOWS_TEST_MISSING_EXTENSION_CREDENTIAL'),
    });
  });
  it('uses extension permissions for hosted deploy preflight and the deploy body', async () => {
    const p = project();
    await install(p, variant(m => ({
      ...m,
      permissions: { ...(m.permissions as object), integrations: ['linear'], harnesses: ['codex'], mcp: ['filesystem'] },
      preflight: { credentials: [], servers: [] },
    })));
    const calls: Array<{ path: string; body: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      if (path === '/api/v1/auth/whoami') {
        return new Response(JSON.stringify({ currentWorkspace: { id: 'ws-1' } }), { status: 200 });
      }
      if (path.endsWith('/integrations/github/status')) return new Response('{"ready":true}', { status: 200 });
      if (path.endsWith('/integrations/linear/status')) return new Response('{"ready":false}', { status: 200 });
      if (path === '/api/v1/flows/deploy') {
        return new Response(JSON.stringify({ agentId: 'agent-1', status: 'draft' }), { status: 201 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubEnv('FLOWS_CLOUD_URL', 'https://cloud-contract.example');
    vi.stubEnv('FLOWS_CLOUD_TOKEN', 'test-token');
    const input = {
      path: p.flow, repository: { owner: 'AgentWorkforce', name: 'flows' },
      sources: [parseTriggerSource('github')], approver: 'reviewer',
    };
    await expect(deployToCloud(input)).rejects.toMatchObject({
      code: 'integration_not_connected', message: expect.stringContaining('plugin "babysitter"'),
    });
    expect(calls.some(call => call.path === '/api/v1/flows/deploy')).toBe(false);

    const deployed = await deployToCloud({ ...input, draft: true });
    const body = calls.findLast(call => call.path === '/api/v1/flows/deploy')!.body;
    expect(body).toMatchObject({
      requirements: { integrations: ['github', 'linear'], harnesses: ['codex'], mcp: ['filesystem'] },
    });
    expect(deployed.requirements).toMatchObject({
      integrations: [
        { provider: 'github', from: 'source' },
        { provider: 'linear', from: 'extension', detail: 'plugin "babysitter"' },
      ],
      harnesses: ['codex'], mcp: ['filesystem'],
    });
  });
});

describe('composition fails closed', () => {
  it('refuses a tampered store before importing the entry', async () => {
    const p = project();
    await install(p);
    const store = pluginStoreDirectory(p.cwd, 'babysitter', readPluginLock(p.cwd).plugins[0]!.digest);
    writeFileSync(join(store, 'babysitter.flow.ts'), "throw new Error('the entry must not be imported before the digest check');");
    await expect(loadAuthoredFlow(p.flow, { versions })).rejects.toMatchObject({ code: 'plugin_source_drift' });
    const { report } = await checkAuthoredTriggers(p.flow);
    expect(report.ok).toBe(false);
    expect(report.diagnostics[0]).toMatchObject({ kind: 'plugin_source_drift' });
  });
  it('refuses when flows.json and the lockfile disagree', async () => {
    const p = project();
    await install(p);
    writeFileSync(join(p.cwd, 'flows.lock.json'), JSON.stringify({ version: 2, plugins: [] }));
    await expect(loadAuthoredFlow(p.flow, { versions })).rejects.toMatchObject({ code: 'plugin_lock_invalid' });
  });
  it('refuses a runtime the extension declares itself incompatible with', async () => {
    const p = project();
    await install(p);
    await expect(loadAuthoredFlow(p.flow, { versions: { sdk: '2.0.22', surface: '3.0.0' } })).rejects.toMatchObject({ code: 'plugin_incompatible', message: expect.stringContaining('requires surface ^2.0.22') });
  });
  it.each([
    ['a base flow it does not extend', (m: Record<string, unknown>) => ({ ...m, compat: { ...(m.compat as object), base: [{ name: 'other-flow', version: '*' }] } }), 'plugin_incompatible', 'not "software-factory"'],
    ['a base version range the unversioned base cannot satisfy', (m: Record<string, unknown>) => ({ ...m, compat: { ...(m.compat as object), base: [{ name: 'software-factory', version: '^1.0.0' }] } }), 'plugin_incompatible', 'declares no version'],
    ['a budget ceiling above the base', (m: Record<string, unknown>) => ({ ...m, permissions: { ...(m.permissions as object), budget: { dollars: 11 } } }), 'plugin_incompatible', 'above the base flow'],
    ['a wallclock ceiling above the base', (m: Record<string, unknown>) => ({ ...m, permissions: { ...(m.permissions as object), budget: { wallclock: '2h' } } }), 'plugin_incompatible', 'wallclock ceiling'],
  ])('refuses %s', async (_, patch, code, message) => {
    const p = project();
    await install(p, variant(patch));
    await expect(loadAuthoredFlow(p.flow, { versions })).rejects.toMatchObject({ code, message: expect.stringContaining(message) });
  });
  const HOOK_ENTRY = "import { flow, github } from '@relayflows/surface';\nexport const hooks = { 'merge-gate': async () => true };\nexport default flow('babysitter', async f => { f.done('success'); }).on(github.pull_request('opened'), async f => { f.done('success'); });\n";
  it('refuses a hook export that the manifest does not declare', async () => {
    const p = project();
    await install(p, variant(m => m, HOOK_ENTRY));
    await expect(loadAuthoredFlow(p.flow, { versions })).rejects.toMatchObject({
      code: 'plugin_manifest_invalid', message: expect.stringContaining('does not match exported hooks'),
    });
  });
  it('refuses a hook the base header does not declare', async () => {
    const p = project();
    await install(p, variant(m => ({ ...m, extends: { handlers: true, hooks: ['merge-gate'] } }), HOOK_ENTRY));
    await expect(loadAuthoredFlow(p.flow, { versions })).rejects.toMatchObject({
      code: 'plugin_incompatible', message: expect.stringContaining('hook merge-gate is not declared'),
    });
  });
  it('composes a declared hook when the base header names it and reads header.version for compat', async () => {
    const p = project(`
      import { flow, github } from '@relayflows/surface';
      export default flow('software-factory', { version: '2.0.22', hooks: ['merge-gate'], budget: { dollars: 10, wallclock: '1h' } }, async f => { f.done('success'); })
        .on(github.issues({ action: 'opened' }), async f => { f.done('success'); });
    `);
    await install(p, variant(m => ({
      ...m,
      extends: { handlers: true, hooks: ['merge-gate'] },
      compat: { ...(m.compat as object), base: [{ name: 'software-factory', version: '^2.0.0' }] },
    }), HOOK_ENTRY));
    const loaded = await loadAuthoredFlow(p.flow, { versions });
    expect(Object.keys(loaded.extensions[0]!.hooks)).toEqual(['merge-gate']);
    expect(loaded.getDefinition(loaded.handle).header).toMatchObject({ version: '2.0.22', hooks: ['merge-gate'] });
  });
  it.each([
    ['an entry subscribing beyond its manifest', undefined,
      "import { flow, github } from '@relayflows/surface';\nexport default flow('babysitter', async f => { f.done('success'); }).on(github.pull_request('opened'), async f => { f.done('success'); }).on(github.pull_request('labeled'), async f => { f.done('success'); });\n",
      'plugin_manifest_invalid', 'subscribes to github pull_request.labeled'],
    ['an entry with a schedule handler', undefined,
      "import { flow, schedule } from '@relayflows/surface';\nexport default flow('babysitter', async f => { f.done('success'); }).on(schedule.every('1h'), async f => { f.done('success'); });\n",
      'plugin_unsupported', 'schedule trigger'],
    ['an entry with a generic webhook handler', undefined,
      "import { flow, webhook } from '@relayflows/surface';\nexport default flow('babysitter', async f => { f.done('success'); }).on(webhook('deploys', { provider: 'aws' }), async f => { f.done('success'); });\n",
      'plugin_manifest_invalid', 'not a provider subscription'],
    ['an entry that declares no handlers although the manifest says it does', undefined,
      "import { flow } from '@relayflows/surface';\nexport default flow('babysitter', async f => { f.done('success'); });\n",
      'plugin_manifest_invalid', 'declares no .on() handlers'],
    ['an entry that uses the use: header', undefined,
      "import { flow, github } from '@relayflows/surface';\nexport default flow('babysitter', { use: ['./other.flow.ts'] }, async f => { f.done('success'); }).on(github.pull_request('opened'), async f => { f.done('success'); });\n",
      'plugin_unsupported', 'entry header use'],
    ['an entry that does not default-export flow()', undefined,
      "export default { name: 'forged' };\n",
      'plugin_manifest_invalid', 'did not load'],
  ])('refuses %s', async (_, __, entry, code, message) => {
    const p = project();
    await install(p, variant(m => m, entry));
    await expect(loadAuthoredFlow(p.flow, { versions })).rejects.toMatchObject({ code, message: expect.stringContaining(message) });
  });
  it('never composes an event the surface registry cannot lower, even if an entry asks for it', async () => {
    // The manifest gate refuses ready_for_review at install; an entry alone cannot smuggle it past the manifest.
    const p = project();
    const entries = variant(m => m, "import { flow, github } from '@relayflows/surface';\nexport default flow('babysitter', async f => { f.done('success'); }).on(github.pull_request('ready_for_review'), async f => { f.done('success'); });\n");
    await install(p, entries);
    await expect(loadAuthoredFlow(p.flow, { versions })).rejects.toMatchObject({ code: 'plugin_manifest_invalid', message: expect.stringContaining('pull_request.ready_for_review') });
  });
});
