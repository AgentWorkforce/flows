import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Ajv } from 'ajv';
import type { Step } from '@relayflows/surface';
import { snapshotJsonValue } from './json-value.js';
import { assertSupportedPlugin, PluginError, pluginPackageName, validatePluginManifest, type PluginManifest, type PluginVerb } from './plugin-manifest.js';

export interface LoadedPlugin { readonly directory: string; readonly manifest: PluginManifest }
export function findPluginProject(start: string): string | undefined {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, 'flows.json'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
export function readPlugin(directory: string, packageName: string): LoadedPlugin {
  const path = join(directory, 'flows-plugin.json');
  if (!existsSync(path)) throw new PluginError('plugin_manifest_missing', `${packageName} has no flows-plugin.json.`);
  let input: unknown;
  try { input = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new PluginError('plugin_manifest_invalid', `${packageName} manifest is unreadable or invalid JSON.`); }
  const manifest = validatePluginManifest(input, packageName);
  assertSupportedPlugin(manifest);
  return Object.freeze({ directory, manifest });
}
export async function probePlugin(plugin: LoadedPlugin, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  for (const credential of plugin.manifest.preflight.credentials) {
    if (!env[credential]?.trim()) throw new PluginError('plugin_credential_missing', `${plugin.manifest.name} requires ${credential}.`);
  }
  for (const server of plugin.manifest.preflight.servers) {
    try {
      const response = await fetch(server, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      await response.body?.cancel();
      if (!response.ok) throw new Error('unsuccessful response');
    } catch { throw new PluginError('plugin_server_unreachable', `${plugin.manifest.name} cannot reach ${server}.`); }
  }
}
export async function loadPlugins(start: string): Promise<readonly LoadedPlugin[]> {
  const root = findPluginProject(start);
  if (root === undefined) return Object.freeze([]);
  let config: { plugins?: unknown };
  try { config = JSON.parse(readFileSync(join(root, 'flows.json'), 'utf8')); }
  catch { throw new PluginError('plugin_manifest_invalid', 'Invalid flows.json.'); }
  if (config === null || typeof config !== 'object' || (config.plugins !== undefined && (!Array.isArray(config.plugins) || !config.plugins.every(p => typeof p === 'string')))) {
    throw new PluginError('plugin_manifest_invalid', 'flows.json plugins must be package names.');
  }
  const scope = join(root, 'node_modules/@flows');
  const names = new Set<string>((config.plugins as string[] | undefined)?.map(pluginPackageName));
  if (existsSync(scope)) for (const name of readdirSync(scope).sort()) if (name.startsWith('helper-')) names.add(pluginPackageName(name));
  const plugins = [...names].sort().map(name => readPlugin(join(root, 'node_modules', name), name));
  const namespaces = new Set<string>();
  for (const plugin of plugins) {
    for (const namespace of new Set(plugin.manifest.verbs.map(v => v.namespace))) {
      if (namespaces.has(namespace)) throw new PluginError('plugin_manifest_invalid', `Duplicate plugin namespace ${namespace}.`);
      namespaces.add(namespace);
    }
    await probePlugin(plugin);
    if (!existsSync(join(plugin.directory, 'src/index.js'))) throw new PluginError('plugin_manifest_invalid', `${plugin.manifest.name} requires src/index.js.`);
  }
  return Object.freeze(plugins);
}
export function pluginHelpers(plugins: readonly LoadedPlugin[], invoke: (plugin: LoadedPlugin, verb: PluginVerb, args: unknown) => Step<unknown>): Record<string, unknown> {
  const helpers: Record<string, Record<string, (args: unknown) => Step<unknown>>> = Object.create(null);
  const ajv = new Ajv({ strict: false });
  for (const plugin of plugins) for (const verb of plugin.manifest.verbs) {
    const validate = ajv.compile(verb.args);
    const namespace = helpers[verb.namespace] ??= Object.create(null);
    namespace[verb.method] = args => {
      const snapshot = snapshotJsonValue(args, `f.${verb.namespace}.${verb.method} arguments`);
      if (!validate(snapshot)) throw new PluginError('plugin_manifest_invalid', `Invalid arguments for ${verb.namespace}.${verb.method}: ${ajv.errorsText(validate.errors)}`);
      return invoke(plugin, verb, snapshot);
    };
  }
  for (const helper of Object.values(helpers)) Object.freeze(helper);
  return Object.freeze(helpers);
}
export async function invokePlugin(plugin: LoadedPlugin, verb: PluginVerb, args: unknown, idempotencyKey: string): Promise<unknown> {
  const module = await import(pathToFileURL(join(plugin.directory, 'src/index.js')).href);
  if (typeof module.execute !== 'function') throw new Error('plugin_runtime_invalid: expected execute export');
  return snapshotJsonValue(await module.execute(verb.namespace, verb.method, args, Object.freeze({ idempotencyKey })), 'plugin output');
}
