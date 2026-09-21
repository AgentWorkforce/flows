import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addPlugin } from '../src/cli/add.js';
import { addExtensionPlugin } from '../src/cli/add-extension.js';
import { parsePluginArgs, runPluginCommand, verifyPlugins } from '../src/cli/plugin.js';
import { runCli } from '../src/cli.js';
import { validateFlowExtensionManifest } from '../src/flow-extension-manifest.js';
import { fetchGithubPlugin, resolveGithubSha } from '../src/plugin-github.js';
import { loadPlugins } from '../src/plugin-loader.js';
import { parsePluginLock, readPluginLock } from '../src/plugin-lock.js';
import { validatePluginManifest } from '../src/plugin-manifest.js';
import { canonicalPluginRef, parseCanonicalPluginRef, parsePluginSource } from '../src/plugin-source.js';
import { pluginStoreDirectory } from '../src/plugin-store.js';
import { satisfiesRange } from '../src/semver-range.js';
import { SHA_A, SHA_B, entriesFromDirectory, fakeGithub, type FakeEntry } from './fake-github.js';

const fixtureRoot = resolve('../../testdata/plugins');
const babysitter = entriesFromDirectory(join(fixtureRoot, 'extension-babysitter'), 'examples/babysitter');
const manifestJson = JSON.parse(readFileSync(join(fixtureRoot, 'extension-babysitter/flows-plugin.json'), 'utf8'));
const REF = `github:AgentWorkforce/flows@${SHA_A}#examples/babysitter`;
const versions = { sdk: '2.0.22', surface: '2.0.22' };
const now = () => new Date('2026-09-20T12:00:00Z');
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); vi.unstubAllEnvs(); });

function github(entries: FakeEntry[] = babysitter, extra: Partial<{ truncated: boolean }> = {}) {
  return fakeGithub({ 'AgentWorkforce/flows': { refs: { 'feat/babysitter-v2': SHA_A, 'v0.1.0': SHA_A, main: SHA_B }, commits: { [SHA_A]: { entries, ...extra }, [SHA_B]: { entries: [] } } } });
}
function project(config: unknown = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'plugin-ext-')); dirs.push(cwd);
  writeFileSync(join(cwd, 'flows.json'), JSON.stringify(config));
  const messages: string[] = [];
  const io = { stdout: (s: string) => messages.push(s), stderr: (s: string) => messages.push(s) };
  return { cwd, io, messages, text: () => messages.join('\n') };
}
function withManifest(patch: (m: Record<string, unknown>) => unknown): FakeEntry[] {
  return babysitter.map(e => e.path.endsWith('flows-plugin.json') ? { ...e, data: Buffer.from(JSON.stringify(patch(structuredClone(manifestJson)))) } : e);
}

describe('plugin source references', () => {
  it('parses the three accepted spellings to one shape', () => {
    const expected = { host: 'github', owner: 'AgentWorkforce', repo: 'flows', ref: 'feat/babysitter-v2', path: 'examples/babysitter' };
    expect(parsePluginSource('github:AgentWorkforce/flows@feat/babysitter-v2#examples/babysitter')).toEqual(expected);
    expect(parsePluginSource('https://github.com/AgentWorkforce/flows/tree/v0.1.0/examples/babysitter')).toEqual({ ...expected, ref: 'v0.1.0' });
    expect(parsePluginSource('https://github.com/AgentWorkforce/flows.git/blob/v0.1.0/examples/babysitter/')).toEqual({ ...expected, ref: 'v0.1.0' });
    expect(parsePluginSource('github:o/r@main')).toMatchObject({ path: '' });
    // The URL form cannot tell a slash in the ref from a path segment; that is
    // what the github: form is for. Documented, not guessed.
    expect(parsePluginSource('https://github.com/AgentWorkforce/flows/tree/feat/babysitter-v2/examples/babysitter')).toMatchObject({ ref: 'feat', path: 'babysitter-v2/examples/babysitter' });
  });
  it.each([
    'github:o/r@main#../etc', 'github:o/r@main#a/../b', 'github:o/r@main#/abs', 'github:o/r@../x', 'github:o/r@main#a\\b',
    'https://github.com/o/r/tree/main/x?token=1', 'https://user:pw@github.com/o/r/tree/main/x', 'https://gitlab.com/o/r/tree/main/x',
    'github:o/r', 'github:o/r@main#examples/flows-plugin.json', 'github:-bad/r@main', 'github:o/r@main.lock',
    'https://github.com/o/r/tree/main/%E0%A4%A',
  ])('refuses %s', input => {
    expect(() => parsePluginSource(input)).toThrow(expect.objectContaining({ code: 'plugin_source_invalid' }));
  });
  it('persists only the canonical sha form', () => {
    expect(canonicalPluginRef({ host: 'github', owner: 'o', repo: 'r', ref: SHA_A, sha: SHA_A, path: '' })).toBe(`github:o/r@${SHA_A}`);
    expect(parseCanonicalPluginRef(REF).sha).toBe(SHA_A);
    expect(() => parseCanonicalPluginRef('github:o/r@main#x')).toThrow(expect.objectContaining({ code: 'plugin_source_invalid' }));
    expect(() => parseCanonicalPluginRef(`https://github.com/o/r/tree/${SHA_A}/x`)).toThrow(expect.objectContaining({ code: 'plugin_source_invalid' }));
  });
});

describe('semver ranges', () => {
  it.each([
    ['2.0.22', '^2.0.22', true], ['2.9.0', '^2.0.22', true], ['3.0.0', '^2.0.22', false], ['2.0.21', '^2.0.22', false],
    ['2.0.30', '~2.0.22', true], ['2.1.0', '~2.0.22', false], ['5.0.0', '>=2.0.0', true], ['2.5.0', '>=2.0.0 <2.5.0', false],
    ['2.0.22', '2.0.22', true], ['2.0.23', '2.0.22', false], ['0.0.9', '*', true], ['0.1.5', '^0.1.0', true], ['0.2.0', '^0.1.0', false],
    ['2.0.22', 'latest', false], ['x', '*', false],
    ['1.0.0-alpha.10', '>=1.0.0-alpha.2', true], ['1.0.0-alpha.2', '>=1.0.0-alpha.10', false],
  ])('%s satisfies %s → %s', (version, range, ok) => { expect(satisfiesRange(version, range)).toBe(ok); });
});

describe('flows add <github ref>', () => {
  it('resolves a branch to its commit, materializes, and records flows.json plus the lockfile', async () => {
    const gh = github(); const p = project({ cli: 'claude' });
    expect(await addPlugin('github:AgentWorkforce/flows@feat/babysitter-v2#examples/babysitter', p.io, { cwd: p.cwd, extension: { fetch: gh.fetch, now, versions } })).toBe(0);
    const config = JSON.parse(readFileSync(join(p.cwd, 'flows.json'), 'utf8'));
    expect(config).toEqual({ cli: 'claude', plugins: [REF] });
    const lock = readPluginLock(p.cwd);
    expect(lock.plugins).toHaveLength(1);
    const [entry] = lock.plugins;
    expect(entry).toMatchObject({ name: 'babysitter', kind: 'flow-extension', version: '0.1.0', order: 1, resolvedAt: '2026-09-20T12:00:00.000Z', source: { host: 'github', owner: 'AgentWorkforce', repo: 'flows', sha: SHA_A, path: 'examples/babysitter' } });
    expect(entry!.digest).toMatch(/^[0-9a-f]{64}$/);
    const store = pluginStoreDirectory(p.cwd, 'babysitter', entry!.digest);
    expect(existsSync(join(store, 'flows-plugin.json'))).toBe(true);
    expect(existsSync(join(store, 'babysitter.flow.ts'))).toBe(true);
    expect(existsSync(join(store, 'manifest.json'))).toBe(true);
    expect(p.text()).toContain(`Added babysitter@0.1.0 (flow-extension) from ${REF}`);
    expect(p.text()).toContain('events: github pull_request[opened,synchronize,reopened,closed]; github pull_request_review[submitted,dismissed]; github check_run[completed]; github issue_comment[created]');
    expect(p.text()).toContain('writes (declared, unenforced): github:pull_request:comment');
    expect(p.text()).toContain('recorded in flows.json and flows.lock.json');
    expect(gh.calls.some(url => url.includes('/commits/feat%2Fbabysitter-v2'))).toBe(true);
    // A tag naming the same commit is a no-op re-add: no duplicate declaration, same lock entry.
    expect(await addPlugin('https://github.com/AgentWorkforce/flows/tree/v0.1.0/examples/babysitter', p.io, { cwd: p.cwd, extension: { fetch: gh.fetch, now, versions } })).toBe(0);
    expect(JSON.parse(readFileSync(join(p.cwd, 'flows.json'), 'utf8')).plugins).toEqual([REF]);
    expect(readPluginLock(p.cwd)).toEqual(lock);
    // And a sha input is accepted as-is.
    expect(await addPlugin(REF, p.io, { cwd: p.cwd, extension: { fetch: gh.fetch, now, versions } })).toBe(0);
  });
  it('keeps the digest stable across identical installs and distinct across content changes', async () => {
    const gh = github(); const a = project(); const b = project();
    await addExtensionPlugin(REF, a.io, { cwd: a.cwd, fetch: gh.fetch, now, versions });
    await addExtensionPlugin(REF, b.io, { cwd: b.cwd, fetch: gh.fetch, now, versions });
    expect(readPluginLock(a.cwd)).toEqual(readPluginLock(b.cwd));
    const changed = github(withManifest(m => ({ ...m, description: 'changed' })));
    const c = project();
    await addExtensionPlugin(REF, c.io, { cwd: c.cwd, fetch: changed.fetch, now, versions });
    expect(readPluginLock(c.cwd).plugins[0]!.digest).not.toBe(readPluginLock(a.cwd).plugins[0]!.digest);
  });
  it.each([
    ['github:AgentWorkforce/flows@nope#examples/babysitter', 'plugin_source_unresolved'],
    ['github:AgentWorkforce/flows@main#examples/babysitter', 'plugin_source_unresolved'],
    ['github:AgentWorkforce/flows@feat/babysitter-v2#examples', 'plugin_manifest_missing'],
    [`github:AgentWorkforce/flows@${SHA_B}#examples/babysitter`, 'plugin_source_unresolved'],
    ['github:AgentWorkforce/flows@feat/babysitter-v2#../x', 'plugin_source_invalid'],
  ])('refuses %s with %s and writes nothing', async (input, code) => {
    const gh = github(); const p = project();
    expect(await addPlugin(input, p.io, { cwd: p.cwd, extension: { fetch: gh.fetch, now, versions } })).toBe(2);
    expect(p.text()).toContain(`REFUSED [${code}]`);
    expect(JSON.parse(readFileSync(join(p.cwd, 'flows.json'), 'utf8'))).toEqual({});
    expect(existsSync(join(p.cwd, 'flows.lock.json'))).toBe(false);
    expect(existsSync(join(p.cwd, '.flows'))).toBe(false);
  });
  it('refuses a plugin whose compat excludes this runtime', async () => {
    const gh = github(); const p = project();
    expect(await addExtensionPlugin(REF, p.io, { cwd: p.cwd, fetch: gh.fetch, now, versions: { sdk: '2.0.22', surface: '3.0.0' } })).toBe(2);
    expect(p.text()).toContain('REFUSED [plugin_incompatible] babysitter requires surface ^2.0.22; this runtime has 3.0.0.');
  });
  it('refuses a manifest whose declared source is not where it was fetched from', async () => {
    const gh = github(withManifest(m => ({ ...m, source: { host: 'github', owner: 'someone', repo: 'else', path: 'examples/babysitter' } })));
    const p = project();
    expect(await addExtensionPlugin(REF, p.io, { cwd: p.cwd, fetch: gh.fetch, now, versions })).toBe(2);
    expect(p.text()).toContain('REFUSED [plugin_source_drift]');
  });
  it('refuses a second source under an already-installed name', async () => {
    const gh = github(); const p = project();
    await addExtensionPlugin(REF, p.io, { cwd: p.cwd, fetch: gh.fetch, now, versions });
    gh.repos['other/fork'] = { refs: { main: SHA_A }, commits: { [SHA_A]: { entries: babysitter } } };
    expect(await addExtensionPlugin(`github:other/fork@main#examples/babysitter`, p.io, { cwd: p.cwd, fetch: gh.fetch, now, versions })).toBe(2);
    expect(p.text()).toContain('already installed from AgentWorkforce/flows');
  });
});

describe('bounded, verified fetches', () => {
  const source = { host: 'github' as const, owner: 'AgentWorkforce', repo: 'flows', ref: SHA_A, sha: SHA_A, path: 'examples/babysitter' };
  const plus = (entry: FakeEntry) => [...babysitter, entry];
  it.each([
    ['a symlink', plus({ path: 'examples/babysitter/link', data: Buffer.from('x'), mode: '120000' }), 'plugin_path_invalid'],
    ['a submodule', plus({ path: 'examples/babysitter/vendor', type: 'commit', mode: '160000' }), 'plugin_path_invalid'],
    ['a traversal path', plus({ path: 'examples/babysitter/a/../b', data: Buffer.from('x') }), 'plugin_path_invalid'],
    ['a backslash path', plus({ path: 'examples/babysitter/a\\b', data: Buffer.from('x') }), 'plugin_path_invalid'],
    ['an oversize file', plus({ path: 'examples/babysitter/big.bin', data: Buffer.alloc(256_001) }), 'plugin_too_large'],
    ['a byte-count mismatch', plus({ path: 'examples/babysitter/drift.txt', data: Buffer.from('abc'), size: 2 }), 'plugin_source_drift'],
  ])('refuses %s', async (_, entries, code) => {
    await expect(fetchGithubPlugin(source, github(entries).fetch)).rejects.toMatchObject({ code });
  });
  it('refuses a plugin that exceeds the total byte budget', async () => {
    const entries = [...babysitter, ...Array.from({ length: 9 }, (_, i) => ({ path: `examples/babysitter/part-${i}.bin`, data: Buffer.alloc(250_000) }))];
    await expect(fetchGithubPlugin(source, github(entries).fetch)).rejects.toMatchObject({ code: 'plugin_too_large' });
  });
  it('refuses a truncated tree listing rather than installing a partial plugin', async () => {
    await expect(fetchGithubPlugin(source, github(babysitter, { truncated: true }).fetch)).rejects.toMatchObject({ code: 'plugin_fetch_failed', message: expect.stringContaining('truncated') });
  });
  it('reports a private or missing repository as unresolved, never as a transport error', async () => {
    await expect(resolveGithubSha({ ...source, ref: 'main', owner: 'private', repo: 'repo' }, github().fetch)).rejects.toMatchObject({ code: 'plugin_source_unresolved' });
    const failing = async () => { throw new Error('ECONNRESET'); };
    await expect(resolveGithubSha(source, failing)).rejects.toMatchObject({ code: 'plugin_fetch_failed' });
  });
});

describe('schema-2 manifest validation', () => {
  it('accepts the worked Babysitter manifest and freezes it', () => {
    const m = validateFlowExtensionManifest(manifestJson);
    expect(m).toMatchObject({ schema: 2, kind: 'flow-extension', name: 'babysitter', entry: 'babysitter.flow.ts', extends: { handlers: true, hooks: [] } });
    expect(m.triggers).toHaveLength(4);
    expect(Object.isFrozen(m) && Object.isFrozen(m.permissions) && Object.isFrozen(m.triggers)).toBe(true);
  });
  it.each([
    ['an event the surface registry cannot lower', (m: Record<string, unknown>) => ({ ...m, triggers: [{ provider: 'github', event: 'pull_request', actions: ['ready_for_review'] }] }), 'plugin_event_unroutable'],
    ['labeled/unlabeled, which the registry lacks', (m: Record<string, unknown>) => ({ ...m, triggers: [{ provider: 'github', event: 'pull_request', actions: ['labeled', 'unlabeled'] }] }), 'plugin_event_unroutable'],
    ['an unknown provider', (m: Record<string, unknown>) => ({ ...m, triggers: [{ provider: 'nope', event: 'x', actions: [] }] }), 'plugin_event_unroutable'],
    ['an unknown kind', (m: Record<string, unknown>) => ({ ...m, kind: 'banana' }), 'plugin_kind_invalid'],
    ['schema 1 with the extension kind', (m: Record<string, unknown>) => ({ ...m, schema: 1 }), 'plugin_manifest_invalid'],
    ['verbs on a flow extension', (m: Record<string, unknown>) => ({ ...m, verbs: [{ namespace: 'x', method: 'y', lowersTo: 'effect', args: {} }] }), 'plugin_manifest_invalid'],
    ['an unknown top-level field', (m: Record<string, unknown>) => ({ ...m, extra: 1 }), 'plugin_manifest_invalid'],
    ['a helper- name', (m: Record<string, unknown>) => ({ ...m, name: 'helper-x' }), 'plugin_manifest_invalid'],
    ['a non-semver version', (m: Record<string, unknown>) => ({ ...m, version: 'v1' }), 'plugin_manifest_invalid'],
    ['a malformed compat range', (m: Record<string, unknown>) => ({ ...m, compat: { ...(m.compat as object), surface: 'latest' } }), 'plugin_manifest_invalid'],
    ['a traversal entry', (m: Record<string, unknown>) => ({ ...m, entry: '../x.flow.ts' }), 'plugin_manifest_invalid'],
    ['neither handlers nor hooks', (m: Record<string, unknown>) => ({ ...m, extends: { handlers: false, hooks: [] } }), 'plugin_manifest_invalid'],
    ['an unknown harness', (m: Record<string, unknown>) => ({ ...m, permissions: { ...(m.permissions as object), harnesses: ['cursor'] } }), 'plugin_manifest_invalid'],
    ['a malformed write class', (m: Record<string, unknown>) => ({ ...m, permissions: { ...(m.permissions as object), writes: ['github'] } }), 'plugin_manifest_invalid'],
    ['a non-positive budget', (m: Record<string, unknown>) => ({ ...m, permissions: { ...(m.permissions as object), budget: { dollars: 0 } } }), 'plugin_manifest_invalid'],
    ['a config that is not a JSON Schema', (m: Record<string, unknown>) => ({ ...m, config: { type: 'not-a-type' } }), 'plugin_manifest_invalid'],
    ['a missing preflight', (m: Record<string, unknown>) => { const { preflight, ...rest } = m; void preflight; return rest; }, 'plugin_preflight_missing'],
  ])('refuses %s', (_, patch, code) => {
    expect(() => validateFlowExtensionManifest(patch(structuredClone(manifestJson)))).toThrow(expect.objectContaining({ code }));
  });
  it('keeps the helper validator helper-only and the extension validator extension-only', () => {
    expect(() => validatePluginManifest(manifestJson)).toThrow(expect.objectContaining({ code: 'plugin_kind_invalid' }));
    const helper = JSON.parse(readFileSync(join(fixtureRoot, 'helper-datadog/flows-plugin.json'), 'utf8'));
    expect(validatePluginManifest(helper).name).toBe('helper-datadog');
    expect(validatePluginManifest({ ...helper, kind: 'helper', schema: 1 }).name).toBe('helper-datadog');
    expect(() => validatePluginManifest({ ...helper, schema: 2 })).toThrow(expect.objectContaining({ code: 'plugin_manifest_invalid' }));
    expect(() => validateFlowExtensionManifest(helper)).toThrow(expect.objectContaining({ code: 'plugin_kind_invalid' }));
  });
});

describe('flows plugin list / verify', () => {
  async function installed() {
    const gh = github(); const p = project();
    expect(await addExtensionPlugin(REF, p.io, { cwd: p.cwd, fetch: gh.fetch, now, versions })).toBe(0);
    p.messages.length = 0;
    return { gh, p, digest: readPluginLock(p.cwd).plugins[0]!.digest };
  }
  it('lists in composition order and verifies locally and remotely', async () => {
    const { gh, p, digest } = await installed();
    expect(await runPluginCommand({ command: 'plugin', sub: 'list', json: false }, p.io, { cwd: p.cwd })).toBe(0);
    expect(p.text()).toBe(`1. babysitter@0.1.0  ${REF}  sha256:${digest}`);
    p.messages.length = 0;
    expect(await runPluginCommand({ command: 'plugin', sub: 'list', json: true }, p.io, { cwd: p.cwd })).toBe(0);
    expect(JSON.parse(p.text()).plugins[0]).toMatchObject({ name: 'babysitter', ref: REF, digest });
    p.messages.length = 0;
    expect(await runPluginCommand({ command: 'plugin', sub: 'verify', json: false, offline: true }, p.io, { cwd: p.cwd })).toBe(0);
    expect(p.text()).toContain('remote skipped');
    p.messages.length = 0;
    expect(await runPluginCommand({ command: 'plugin', sub: 'verify', json: true, offline: false }, p.io, { cwd: p.cwd, fetch: gh.fetch })).toBe(0);
    expect(JSON.parse(p.text())).toEqual({ ok: true, plugins: [{ name: 'babysitter', ref: REF, digest, remote: 'verified' }] });
  });
  it('refuses when GitHub serves different bytes at the pinned commit', async () => {
    const { p } = await installed();
    const drifted = github(withManifest(m => ({ ...m, description: 'rewritten history' })));
    await expect(verifyPlugins(p.cwd, { offline: false, fetch: drifted.fetch })).rejects.toMatchObject({ code: 'plugin_source_drift', message: expect.stringContaining('GitHub now serves digest') });
    expect(await runPluginCommand({ command: 'plugin', sub: 'verify', json: false, offline: false }, p.io, { cwd: p.cwd, fetch: drifted.fetch })).toBe(2);
    expect(p.text()).toContain('REFUSED [plugin_source_drift]');
  });
  it.each([
    ['an edited file', (store: string) => writeFileSync(join(store, 'babysitter.flow.ts'), '// tampered')],
    ['a deleted file', (store: string) => rmSync(join(store, 'babysitter.flow.ts'))],
    ['an added file', (store: string) => writeFileSync(join(store, 'extra.ts'), '')],
    ['a symlink in place of a file', (store: string) => { rmSync(join(store, 'README.md')); symlinkSync('/etc/hostname', join(store, 'README.md')); }],
    ['an edited manifest', (store: string) => writeFileSync(join(store, 'manifest.json'), '[]')],
  ])('refuses the local store after %s', async (_, tamper) => {
    const { p, digest } = await installed();
    tamper(pluginStoreDirectory(p.cwd, 'babysitter', digest));
    await expect(verifyPlugins(p.cwd, { offline: true })).rejects.toMatchObject({ code: 'plugin_source_drift' });
  });
  it('refuses when flows.json and the lockfile disagree', async () => {
    const { p } = await installed();
    writeFileSync(join(p.cwd, 'flows.json'), JSON.stringify({ plugins: [] }));
    await expect(verifyPlugins(p.cwd, { offline: true })).rejects.toMatchObject({ code: 'plugin_lock_invalid', message: expect.stringContaining('does not declare') });
    writeFileSync(join(p.cwd, 'flows.json'), JSON.stringify({ plugins: [REF, `github:o/r@${SHA_B}`] }));
    await expect(verifyPlugins(p.cwd, { offline: true })).rejects.toMatchObject({ code: 'plugin_lock_invalid', message: expect.stringContaining('no entry') });
  });
  it('refuses a malformed lockfile', () => {
    expect(() => parsePluginLock({ version: 1, plugins: [] })).toThrow(expect.objectContaining({ code: 'plugin_lock_invalid' }));
    const entry = { name: 'x', kind: 'flow-extension', version: '1.0.0', source: { host: 'github', owner: 'o', repo: 'r', sha: SHA_A, path: '' }, digest: 'f'.repeat(64), manifestSha256: 'f'.repeat(64), order: 2, resolvedAt: '2026-09-20T00:00:00Z' };
    expect(() => parsePluginLock({ version: 2, plugins: [entry] })).toThrow(expect.objectContaining({ code: 'plugin_lock_invalid', message: expect.stringContaining('plugins[0]') }));
    expect(parsePluginLock({ version: 2, plugins: [{ ...entry, order: 1 }] }).plugins[0]!.order).toBe(1);
    expect(() => parsePluginLock({ version: 2, plugins: [{ ...entry, order: 1 }, { ...entry, order: 2 }] })).toThrow(expect.objectContaining({ message: expect.stringContaining('twice') }));
  });
});

describe('flows plugin remove / update', () => {
  async function installed(entries: FakeEntry[] = babysitter) {
    const gh = github(entries); const p = project();
    expect(await addExtensionPlugin(REF, p.io, { cwd: p.cwd, fetch: gh.fetch, now, versions })).toBe(0);
    p.messages.length = 0;
    return { gh, p, digest: readPluginLock(p.cwd).plugins[0]!.digest };
  }
  it('drops the declaration, rebuilds lock order, and deletes the store directory', async () => {
    const sitter = babysitter.map(e => e.path.endsWith('flows-plugin.json')
      ? { ...e, path: e.path.replace('examples/babysitter', 'examples/sitter'), data: Buffer.from(JSON.stringify({ ...manifestJson, name: 'sitter' })) }
      : { ...e, path: e.path.replace('examples/babysitter', 'examples/sitter') });
    const gh = fakeGithub({
      'AgentWorkforce/flows': {
        refs: { 'feat/babysitter-v2': SHA_A, main: SHA_A },
        commits: { [SHA_A]: { entries: [...babysitter, ...sitter] } },
      },
    });
    const p = project();
    expect(await addExtensionPlugin(REF, p.io, { cwd: p.cwd, fetch: gh.fetch, now, versions })).toBe(0);
    const sitterRef = `github:AgentWorkforce/flows@${SHA_A}#examples/sitter`;
    expect(await addExtensionPlugin(sitterRef, p.io, { cwd: p.cwd, fetch: gh.fetch, now, versions })).toBe(0);
    const before = readPluginLock(p.cwd);
    expect(before.plugins.map(e => [e.order, e.name])).toEqual([[1, 'babysitter'], [2, 'sitter']]);
    const babysitterDir = pluginStoreDirectory(p.cwd, 'babysitter', before.plugins[0]!.digest);
    const sitterDir = pluginStoreDirectory(p.cwd, 'sitter', before.plugins[1]!.digest);
    p.messages.length = 0;
    expect(await runPluginCommand({ command: 'plugin', sub: 'remove', json: false, name: 'babysitter' }, p.io, { cwd: p.cwd })).toBe(0);
    expect(p.text()).toContain(`Removed babysitter@0.1.0  ${REF}`);
    expect(JSON.parse(readFileSync(join(p.cwd, 'flows.json'), 'utf8')).plugins).toEqual([sitterRef]);
    const after = readPluginLock(p.cwd);
    expect(after.plugins.map(e => [e.order, e.name])).toEqual([[1, 'sitter']]);
    expect(existsSync(babysitterDir)).toBe(false);
    expect(existsSync(sitterDir)).toBe(true);
  });
  it('refuses to remove a name that is not installed', async () => {
    const { p } = await installed();
    expect(await runPluginCommand({ command: 'plugin', sub: 'remove', json: false, name: 'nope' }, p.io, { cwd: p.cwd })).toBe(2);
    expect(p.text()).toContain('REFUSED [plugin_manifest_invalid] No flow-extension plugin named nope.');
    expect(JSON.parse(readFileSync(join(p.cwd, 'flows.json'), 'utf8')).plugins).toEqual([REF]);
  });
  it('shows the permissions/events/budget diff and writes nothing without --yes', async () => {
    const { p, digest } = await installed();
    const updated = github(withManifest(m => ({
      ...m,
      version: '0.2.0',
      permissions: { ...(m.permissions as object), writes: ['github:pull_request:comment', 'github:issue:comment'], budget: { dollars: 12, wallclock: '1h' } },
    })));
    updated.repos['AgentWorkforce/flows']!.commits[SHA_B] = updated.repos['AgentWorkforce/flows']!.commits[SHA_A]!;
    updated.repos['AgentWorkforce/flows']!.refs.main = SHA_B;
    const to = `github:AgentWorkforce/flows@${SHA_B}#examples/babysitter`;
    expect(await runPluginCommand({ command: 'plugin', sub: 'update', json: false, yes: false, name: 'babysitter', to }, p.io, {
      cwd: p.cwd, fetch: updated.fetch, now, versions,
    })).toBe(2);
    expect(p.text()).toContain(`Update babysitter  ${REF} → ${to}`);
    expect(p.text()).toContain('version: 0.1.0 → 0.2.0');
    expect(p.text()).toContain('+github:issue:comment');
    expect(p.text()).toContain('budget: $8 / 45m → $12 / 1h');
    expect(p.text()).toContain('REFUSED [plugin_manifest_invalid] Re-run with --yes to apply this update.');
    expect(JSON.parse(readFileSync(join(p.cwd, 'flows.json'), 'utf8')).plugins).toEqual([REF]);
    expect(readPluginLock(p.cwd).plugins[0]!.digest).toBe(digest);
    expect(existsSync(pluginStoreDirectory(p.cwd, 'babysitter', digest))).toBe(true);
  });
  it('applies --to with --yes, rewrites store/lock/flows.json, and drops the old store', async () => {
    const { p, digest } = await installed();
    const updated = github(withManifest(m => ({ ...m, version: '0.2.0', description: 'next' })));
    updated.repos['AgentWorkforce/flows']!.commits[SHA_B] = updated.repos['AgentWorkforce/flows']!.commits[SHA_A]!;
    updated.repos['AgentWorkforce/flows']!.refs.main = SHA_B;
    const to = `github:AgentWorkforce/flows@main#examples/babysitter`;
    const canonical = `github:AgentWorkforce/flows@${SHA_B}#examples/babysitter`;
    p.messages.length = 0;
    expect(await runPluginCommand({ command: 'plugin', sub: 'update', json: false, yes: true, name: 'babysitter', to }, p.io, {
      cwd: p.cwd, fetch: updated.fetch, now, versions,
    })).toBe(0);
    const lock = readPluginLock(p.cwd);
    expect(lock.plugins).toHaveLength(1);
    expect(lock.plugins[0]).toMatchObject({ name: 'babysitter', version: '0.2.0', order: 1, source: { sha: SHA_B } });
    expect(lock.plugins[0]!.digest).not.toBe(digest);
    expect(JSON.parse(readFileSync(join(p.cwd, 'flows.json'), 'utf8')).plugins).toEqual([canonical]);
    expect(existsSync(pluginStoreDirectory(p.cwd, 'babysitter', digest))).toBe(false);
    expect(existsSync(pluginStoreDirectory(p.cwd, 'babysitter', lock.plugins[0]!.digest))).toBe(true);
    expect(p.text()).toContain(`Updated babysitter  ${canonical}`);
  });
  it('reports already-at when re-resolving the locked commit', async () => {
    const { gh, p, digest } = await installed();
    expect(await runPluginCommand({ command: 'plugin', sub: 'update', json: true, yes: false, name: undefined, to: undefined }, p.io, {
      cwd: p.cwd, fetch: gh.fetch, now, versions,
    })).toBe(0);
    expect(JSON.parse(p.text())).toMatchObject({ ok: true, plugins: [{ name: 'babysitter', changed: false, digest }] });
  });
  it('emits the permissions diff in JSON without --yes and does not rewrite the lock', async () => {
    const { p, digest } = await installed();
    const updated = github(withManifest(m => ({ ...m, version: '0.2.0' })));
    updated.repos['AgentWorkforce/flows']!.commits[SHA_B] = updated.repos['AgentWorkforce/flows']!.commits[SHA_A]!;
    const to = `github:AgentWorkforce/flows@${SHA_B}#examples/babysitter`;
    p.messages.length = 0;
    expect(await runPluginCommand({ command: 'plugin', sub: 'update', json: true, yes: false, name: 'babysitter', to }, p.io, {
      cwd: p.cwd, fetch: updated.fetch, now, versions,
    })).toBe(2);
    expect(JSON.parse(p.messages.find(line => line.startsWith('{'))!)).toMatchObject({ ok: false, applied: false, code: 'plugin_manifest_invalid', plugins: [{ name: 'babysitter', changed: true }] });
    expect(readPluginLock(p.cwd).plugins[0]!.digest).toBe(digest);
  });
  it('parses the new subcommands and refuses a malformed invocation', () => {
    expect(parsePluginArgs(['remove', 'babysitter'])).toEqual({ command: 'plugin', sub: 'remove', json: false, name: 'babysitter' });
    expect(parsePluginArgs(['update', '--yes'])).toEqual({ command: 'plugin', sub: 'update', json: false, yes: true, name: undefined, to: undefined });
    expect(parsePluginArgs(['update', 'babysitter', '--to', 'github:o/r@main#x', '--yes', '--json']))
      .toEqual({ command: 'plugin', sub: 'update', json: true, yes: true, name: 'babysitter', to: 'github:o/r@main#x' });
    expect(parsePluginArgs(['remove'])).toBeUndefined();
    expect(parsePluginArgs(['update', '--to'])).toBeUndefined();
    expect(parsePluginArgs(['update', '--yes', '--yes'])).toBeUndefined();
  });
});

describe('legacy helper plugins are untouched', () => {
  it('never contacts GitHub for a helper name and leaves the helper path to npm', async () => {
    const gh = github(); const p = project();
    const install = vi.fn(() => { throw { stderr: 'offline' }; });
    expect(await addPlugin('helper-datadog', p.io, { cwd: p.cwd, install, extension: { fetch: gh.fetch } })).toBe(2);
    expect(install).toHaveBeenCalledWith('@flows/helper-datadog', p.cwd);
    expect(gh.calls).toEqual([]);
    expect(p.text()).toContain('plugin_install_failed');
  });
  it('keeps the helper loader helper-only: extension entries are neither helpers nor unlisted packages', async () => {
    const gh = github(); const p = project();
    await addExtensionPlugin(REF, p.io, { cwd: p.cwd, fetch: gh.fetch, now, versions });
    // Extensions are composed by the authored flow loader (flow-extension-compose.test.ts); here they are simply not helpers.
    expect(await loadPlugins(p.cwd)).toEqual([]);
    vi.stubEnv('DATADOG_API_KEY', 'test');
    cpSync(join(fixtureRoot, 'helper-datadog'), join(p.cwd, 'node_modules/@flows/helper-datadog'), { recursive: true });
    const config = JSON.parse(readFileSync(join(p.cwd, 'flows.json'), 'utf8'));
    writeFileSync(join(p.cwd, 'flows.json'), JSON.stringify({ ...config, plugins: ['helper-datadog', ...config.plugins] }));
    expect((await loadPlugins(p.cwd)).map(plugin => plugin.manifest.name)).toEqual(['helper-datadog']);
    expect(readPluginLock(p.cwd).plugins.map(e => [e.order, e.name])).toEqual([[1, 'babysitter']]);
  });
  it('dispatches through the CLI: add refuses a bad reference offline, plugin list and verify run', async () => {
    const p = project();
    expect(await runCli(['add', 'github:o/r@main#../x'], p.io)).toBe(2);
    expect(p.text()).toContain('REFUSED [plugin_source_invalid]');
    const previous = process.cwd();
    process.chdir(p.cwd);
    try {
      p.messages.length = 0;
      expect(await runCli(['plugin', 'list'], p.io)).toBe(0);
      expect(p.text()).toBe('No flow-extension plugins installed.');
      p.messages.length = 0;
      expect(await runCli(['plugin', 'verify', '--offline', '--json'], p.io)).toBe(0);
      expect(JSON.parse(p.text())).toEqual({ ok: true, plugins: [] });
      expect(await runCli(['plugin', 'nope'], p.io)).toBe(2);
    } finally { process.chdir(previous); }
  });
});
