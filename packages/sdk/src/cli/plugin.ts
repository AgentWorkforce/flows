import type { CliIo } from '../cli.js';
import { fetchGithubPlugin, type FetchLike } from '../plugin-github.js';
import { lockedPlugins, readPluginLock, reconcileDeclaredExtensions, type PluginLockEntry } from '../plugin-lock.js';
import { findPluginProject } from '../plugin-loader.js';
import { PluginError } from '../plugin-manifest.js';
import { pluginStoreDirectory, verifyStoredPlugin } from '../plugin-store.js';

export type PluginArgs =
  | { command: 'plugin'; sub: 'list'; json: boolean }
  | { command: 'plugin'; sub: 'verify'; json: boolean; offline: boolean };

/** `flows plugin list [--json]` · `flows plugin verify [--json] [--offline]` */
export function parsePluginArgs(args: readonly string[]): PluginArgs | undefined {
  const [sub, ...rest] = args;
  if (sub !== 'list' && sub !== 'verify') return undefined;
  let json = false;
  let offline = false;
  for (const arg of rest) {
    if (arg === '--json' && !json) json = true;
    else if (arg === '--offline' && !offline && sub === 'verify') offline = true;
    else return undefined;
  }
  return sub === 'list' ? { command: 'plugin', sub, json } : { command: 'plugin', sub, json, offline };
}

/**
 * Cross-check the three records that must agree: `flows.json.plugins`
 * (declaration), `flows.lock.json` (provenance), and `.flows/plugins` (bytes).
 * With the network, the pinned commit is re-fetched and re-hashed too.
 */
export async function verifyPlugins(root: string, options: { offline: boolean; fetch?: FetchLike }): Promise<{ entry: PluginLockEntry; ref: string; directory: string; remote: 'verified' | 'skipped' }[]> {
  const results = [];
  for (const { ref, entry, source } of reconcileDeclaredExtensions(root)) {
    const directory = pluginStoreDirectory(root, entry.name, entry.digest);
    await verifyStoredPlugin(directory, entry.digest);
    let remote: 'verified' | 'skipped' = 'skipped';
    if (!options.offline) {
      const fetched = await fetchGithubPlugin(source, options.fetch);
      if (fetched.digest !== entry.digest) throw new PluginError('plugin_source_drift', `${ref}: GitHub now serves digest ${fetched.digest}, lockfile has ${entry.digest}.`);
      remote = 'verified';
    }
    results.push({ entry, ref, directory, remote });
  }
  return results;
}

export async function runPluginCommand(parsed: PluginArgs, io: CliIo, options: { cwd?: string; fetch?: FetchLike } = {}): Promise<0 | 2> {
  try {
    const root = findPluginProject(options.cwd ?? process.cwd());
    if (!root) throw new PluginError('plugin_manifest_invalid', 'flows plugin requires a project with flows.json.');
    if (parsed.sub === 'list') {
      const plugins = lockedPlugins(readPluginLock(root));
      if (parsed.json) { io.stdout(JSON.stringify({ plugins: plugins.map(p => ({ ...p.entry, ref: p.ref })) })); return 0; }
      if (plugins.length === 0) { io.stdout('No flow-extension plugins installed.'); return 0; }
      for (const { entry, ref } of plugins) io.stdout(`${entry.order}. ${entry.name}@${entry.version}  ${ref}  sha256:${entry.digest}`);
      return 0;
    }
    const results = await verifyPlugins(root, { offline: parsed.offline, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
    if (parsed.json) { io.stdout(JSON.stringify({ ok: true, plugins: results.map(r => ({ name: r.entry.name, ref: r.ref, digest: r.entry.digest, remote: r.remote })) })); return 0; }
    for (const r of results) io.stdout(`OK ${r.entry.name}@${r.entry.version}  ${r.ref}  local digest matches lockfile; remote ${r.remote}`);
    if (results.length === 0) io.stdout('No flow-extension plugins to verify.');
    return 0;
  } catch (error) {
    const refusal = error instanceof PluginError ? error : new PluginError('plugin_manifest_invalid', (error as Error).message);
    if (parsed.json) io.stdout(JSON.stringify({ ok: false, code: refusal.code, message: refusal.message }));
    io.stderr(`REFUSED [${refusal.code}] ${refusal.message}`);
    return 2;
  }
}
