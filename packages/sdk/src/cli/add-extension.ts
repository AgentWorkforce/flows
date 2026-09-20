import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CliIo } from '../cli.js';
import { sha256 } from '../bundle.js';
import { assertCompatible, runtimeVersions, type RuntimeVersions } from '../flow-extension-compat.js';
import { validateFlowExtensionManifest, type FlowExtensionManifest } from '../flow-extension-manifest.js';
import { fetchGithubPlugin, resolveGithubSha, type FetchLike, type FetchedPlugin } from '../plugin-github.js';
import { PLUGIN_LOCK_FILE, lockWithPlugin, readPluginLock, writePluginLock } from '../plugin-lock.js';
import { findPluginProject } from '../plugin-loader.js';
import { PluginError } from '../plugin-manifest.js';
import { canonicalPluginRef, parsePluginSource } from '../plugin-source.js';
import { materializePlugin } from '../plugin-store.js';

export { assertCompatible, runtimeVersions };

/** Parse and validate the manifest inside a fetched plugin, checking that any self-declared source is the one it came from. */
export function extensionManifestOf(plugin: FetchedPlugin): { manifest: FlowExtensionManifest; manifestSha256: string } {
  const file = plugin.files.find(f => f.path === 'flows-plugin.json');
  if (file === undefined) throw new PluginError('plugin_manifest_missing', 'Plugin has no flows-plugin.json.');
  let input: unknown;
  try { input = JSON.parse(file.data.toString('utf8')); }
  catch { throw new PluginError('plugin_manifest_invalid', 'flows-plugin.json is unreadable or invalid JSON.'); }
  const manifest = validateFlowExtensionManifest(input);
  const { source } = plugin;
  if (manifest.source !== undefined && (manifest.source.owner !== source.owner || manifest.source.repo !== source.repo || manifest.source.path !== source.path
    || (manifest.source.sha !== undefined && manifest.source.sha !== source.sha))) {
    throw new PluginError('plugin_source_drift', `flows-plugin.json declares source ${manifest.source.owner}/${manifest.source.repo}#${manifest.source.path}, but it was fetched from ${source.owner}/${source.repo}#${source.path}.`);
  }
  if (!plugin.files.some(f => f.path === manifest.entry)) throw new PluginError('plugin_manifest_invalid', `entry ${manifest.entry} is not in the plugin.`);
  return { manifest, manifestSha256: sha256(file.data) };
}

export function describeExtension(manifest: FlowExtensionManifest): string[] {
  const p = manifest.permissions;
  return [
    `  integrations: ${p.integrations.join(', ') || 'none'}; harnesses: ${p.harnesses.join(', ') || 'none'}; mcp: ${p.mcp.join(', ') || 'none'}`,
    `  events: ${manifest.triggers.map(t => `${t.provider} ${t.event}[${t.actions.join(',')}]`).join('; ') || 'none'}`,
    `  hooks: ${manifest.extends.hooks.join(', ') || 'none'}; handlers: ${manifest.extends.handlers ? 'yes' : 'no'}`,
    `  writes (declared, unenforced): ${p.writes.join(', ') || 'none'}`,
    `  budget: ${p.budget === undefined ? 'inherits base' : [p.budget.dollars === undefined ? '' : `$${p.budget.dollars}`, p.budget.wallclock ?? ''].filter(Boolean).join(' / ')}`,
  ];
}

export interface AddExtensionOptions {
  cwd?: string;
  fetch?: FetchLike;
  now?: () => Date;
  versions?: RuntimeVersions;
}

/**
 * `flows add github:<owner>/<repo>@<ref>#<path>` — resolve the ref to a commit,
 * fetch the plugin directory, validate its schema-2 manifest, materialize it
 * under `.flows/plugins`, and record the canonical reference in `flows.json`
 * plus the provenance in `flows.lock.json`. Runtime composition is a later
 * slice: installing records a declaration, it does not enable execution.
 */
export async function addExtensionPlugin(input: string, io: CliIo, options: AddExtensionOptions = {}): Promise<0 | 2> {
  try {
    // Parse before touching the filesystem or the network: a malformed
    // reference is refused offline, with the same code from any directory.
    const requested = parsePluginSource(input);
    const root = findPluginProject(options.cwd ?? process.cwd());
    if (!root) throw new PluginError('plugin_manifest_invalid', 'flows add requires a project with flows.json.');
    const configPath = join(root, 'flows.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!config || Array.isArray(config) || typeof config !== 'object' || (config.plugins !== undefined && (!Array.isArray(config.plugins) || !config.plugins.every((p: unknown) => typeof p === 'string')))) throw new PluginError('plugin_manifest_invalid', 'Invalid flows.json plugins list.');
    const lock = readPluginLock(root);
    const source = await resolveGithubSha(requested, options.fetch);
    const fetched = await fetchGithubPlugin(source, options.fetch);
    const { manifest, manifestSha256 } = extensionManifestOf(fetched);
    assertCompatible(manifest, options.versions ?? runtimeVersions());
    const ref = canonicalPluginRef(source);
    const declared: string[] = config.plugins ?? [];
    for (const other of lock.plugins) {
      if (other.name === manifest.name && canonicalPluginRef({ ...other.source, ref: other.source.sha }) !== ref) {
        throw new PluginError('plugin_manifest_invalid', `Plugin ${manifest.name} is already installed from ${other.source.owner}/${other.source.repo}@${other.source.sha}; remove it before installing another source under the same name.`);
      }
    }
    const { directory, digest } = await materializePlugin(root, manifest.name, fetched.files);
    if (digest !== fetched.digest) throw new PluginError('plugin_source_drift', 'Materialized digest differs from the fetched digest.');
    const plugins = declared.includes(ref) ? declared : [...declared, ref];
    const next = lockWithPlugin(lock, plugins, {
      name: manifest.name, version: manifest.version,
      source: { host: 'github', owner: source.owner, repo: source.repo, sha: source.sha, path: source.path },
      digest, manifestSha256, resolvedAt: (options.now ?? (() => new Date()))().toISOString(),
    });
    config.plugins = plugins;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    writePluginLock(root, next);
    io.stdout(`Added ${manifest.name}@${manifest.version} (flow-extension) from ${ref}`);
    io.stdout(`  digest sha256:${digest}`);
    io.stdout(`  materialized at ${directory}`);
    for (const line of describeExtension(manifest)) io.stdout(line);
    io.stdout(`  recorded in flows.json and ${PLUGIN_LOCK_FILE}; runtime composition is not yet supported (plugin_unsupported at run time)`);
    return 0;
  } catch (error) {
    const refusal = error instanceof PluginError ? error : new PluginError('plugin_manifest_invalid', (error as Error).message);
    io.stderr(`REFUSED [${refusal.code}] ${refusal.message}`);
    return 2;
  }
}
