import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { flow } from '@relayflows/surface';
import { afterEach, expect, it, vi } from 'vitest';
import { loadPlugins, pluginHelpers, probePlugin, readPlugin } from '../src/plugin-loader.js';
import { validatePluginManifest } from '../src/plugin-manifest.js';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { JournalClient } from '../src/journal-client.js';
import { socketPathFor } from '../src/daemon-connection.js';
const fixture = resolve('../../testdata/plugins/helper-datadog');
const manifest = JSON.parse(readFileSync(join(fixture, 'flows-plugin.json'), 'utf8'));
const dirs: string[] = []; const children: ChildProcess[] = []; const clients: JournalClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach(c => c.close());
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
  dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); vi.unstubAllEnvs(); vi.restoreAllMocks();
});
function project() {
  const root = mkdtempSync(join(tmpdir(), 'plugin-load-')); dirs.push(root);
  writeFileSync(join(root, 'flows.json'), JSON.stringify({ plugins: ['@flows/helper-datadog'] }));
  cpSync(fixture, join(root, 'node_modules/@flows/helper-datadog'), { recursive: true }); return root;
}
it.each([{}, { plugins: [] }])('rejects an installed helper without an explicit declaration: %j', async config => {
  const root = project();
  writeFileSync(join(root, 'flows.json'), JSON.stringify(config));
  vi.stubEnv('DATADOG_API_KEY', '');
  await expect(loadPlugins(root)).rejects.toMatchObject({ code: 'plugin_unlisted' });
});
it('rejects an extra installed helper before probing the declared plugins', async () => {
  const root = project();
  cpSync(fixture, join(root, 'node_modules/@flows/helper-extra'), { recursive: true });
  vi.stubEnv('DATADOG_API_KEY', '');
  await expect(loadPlugins(root)).rejects.toMatchObject({ code: 'plugin_unlisted', message: expect.stringContaining('@flows/helper-extra') });
});
it('loads explicitly declared helpers using either supported package name spelling', async () => {
  const root = project();
  vi.stubEnv('DATADOG_API_KEY', 'test');
  for (const name of ['helper-datadog', '@flows/helper-datadog']) {
    writeFileSync(join(root, 'flows.json'), JSON.stringify({ plugins: [name] }));
    expect((await loadPlugins(root)).map(plugin => plugin.manifest.name)).toEqual([manifest.name]);
  }
});
it('freezes manifest and refuses unknown primitives and missing preflight', () => {
  expect(Object.isFrozen(validatePluginManifest(manifest).verbs[0]!.args)).toBe(true);
  expect(() => validatePluginManifest({ ...manifest, verbs: [{ ...manifest.verbs[0], lowersTo: 'new-word' }] })).toThrow('Unknown primitive');
  const { preflight, ...rest } = manifest; expect(() => validatePluginManifest(rest)).toThrow('declare preflight');
  expect(() => validatePluginManifest({ ...manifest, verbs: [{ ...manifest.verbs[0], namespace: 'run' }] })).toThrow('reserved');
});
it('checks credentials and server reachability', async () => {
  const plugin = readPlugin(fixture, '@flows/helper-datadog');
  await expect(probePlugin(plugin, {})).rejects.toMatchObject({ code: 'plugin_credential_missing' });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  const withServer = { ...plugin, manifest: validatePluginManifest({ ...manifest, preflight: { credentials: [], servers: ['https://example.invalid/health'] } }) };
  await expect(probePlugin(withServer)).rejects.toMatchObject({ code: 'plugin_server_unreachable' });
});
it('snapshots and validates inputs before invoking', async () => {
  vi.stubEnv('DATADOG_API_KEY', 'test'); const plugins = await loadPlugins(project()); const invoke = vi.fn();
  const helpers = pluginHelpers(plugins, invoke) as any; const args = { metric: 'cpu' };
  helpers.datadog.query(args); args.metric = 'mutated';
  expect(invoke.mock.calls[0]![2]).toEqual({ metric: 'cpu' }); expect(Object.isFrozen(invoke.mock.calls[0]![2])).toBe(true);
  expect(() => helpers.datadog.query({ metric: 1 })).toThrow('Invalid arguments');
});
it('refuses before evaluating the body or contacting the journal', async () => {
  vi.stubEnv('DATADOG_API_KEY', ''); const body = vi.fn(async f => f.done('success'));
  await expect(executeAuthoredFlow(flow('refusal', body), new JournalClient('/no-socket'), undefined, { flowPath: join(project(), 'flow.ts') })).rejects.toMatchObject({ report: { diagnostics: expect.arrayContaining([expect.objectContaining({ kind: 'plugin_credential_missing' })]) } });
  expect(body).not.toHaveBeenCalled();
});
it('journals plugin effect input and receipt through the daemon', async () => {
  vi.stubEnv('DATADOG_API_KEY', 'test'); const root = project(); const dataDir = join(root, 'data');
  const worktreeKey = spawnSync('cksum', { input: realpathSync(resolve('../..')), encoding: 'utf8' }).stdout.trim().split(' ')[0]!;
  const target = process.env.CARGO_TARGET_DIR ?? join(process.env.RELAYFLOWS_TOOLCHAIN_HOME ?? join(homedir(), '.relayflows-toolchain'), 'target', worktreeKey);
  const binary = process.env.RELAYFLOWD_BIN ?? join(target, 'debug/relayflowd');
  const child = spawn(binary!, ['--data-dir', dataDir, 'serve'], { stdio: 'ignore' }); children.push(child);
  let client!: JournalClient;
  for (let n = 0; ; n++) {
    client = new JournalClient(socketPathFor(dataDir), { connectTimeoutMs: 100 });
    try { await client.connect(); await client.hello('plugin-test'); clients.push(client); break; }
    catch (error) { client.close(); if (n === 99) throw error; await new Promise(r => setTimeout(r, 20)); }
  }
  let receipt: unknown;
  const result = await executeAuthoredFlow(flow('plugin', async f => { receipt = await (f as any).datadog.query({ metric: 'cpu' }); f.done('success'); }), client, undefined, { flowPath: join(root, 'flow.ts') });
  expect(receipt).toMatchObject({ metric: 'cpu', value: 42 }); const step = result.journalSteps[0]!;
  const entries = (await client.journalRead(step.runId, 1)).entries as any[];
  expect(entries.filter(e => e.entry_type === 'effect.confirmed')).toHaveLength(1);
  expect(entries.find(e => e.entry_type === 'step.completed')).toMatchObject({ payload: { completionReason: 'success', output: { type: 'effect', input: { metric: 'cpu' }, output: { value: 42 } } } });
}, 15000);
