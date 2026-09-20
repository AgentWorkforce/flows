import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AuthoredFlowDefinition, FlowHandle } from './authored-flow.js';
import { sha256 } from './bundle.js';
import { assertBaseCompatible, assertCompatible, runtimeVersions, type RuntimeVersions } from './flow-extension-compat.js';
import { validateFlowExtensionManifest, type FlowExtensionManifest } from './flow-extension-manifest.js';
import { findPluginProject } from './plugin-loader.js';
import { reconcileDeclaredExtensions, type PluginLockEntry } from './plugin-lock.js';
import { PluginError } from './plugin-manifest.js';
import { pluginStoreDirectory, verifyStoredPlugin } from './plugin-store.js';

/**
 * Compose schema-2 flow extensions onto a base authored flow.
 *
 * Order of operations is the security argument, so it is fixed:
 *   1. `flows.json.plugins` and `flows.lock.json` must agree (declaration ⇔
 *      provenance, same order);
 *   2. the materialized store is re-hashed against the lock's digest and the
 *      manifest bytes against the lock's manifest hash — nothing under
 *      `.flows/plugins` is read as code before this passes;
 *   3. the manifest is validated, its compat checked against the runtime and
 *      the base flow, and anything this slice does not compose (hooks, `use`,
 *      schedule triggers, non-provider webhooks) is refused;
 *   4. only then is the entry imported, and its handlers are checked against
 *      the manifest's declared triggers — an entry cannot subscribe to more
 *      than it declared.
 * Extensions compose after the base, in lock order; nothing replaces,
 * reorders, or widens a base handler.
 */
type TriggerHandler = AuthoredFlowDefinition['handlers'][number];

export interface LoadedFlowExtension {
  readonly name: string;
  readonly version: string;
  readonly ref: string;
  readonly digest: string;
  readonly directory: string;
  readonly entryPath: string;
  readonly manifest: FlowExtensionManifest;
  readonly handle: FlowHandle;
  /** Bound to the surface copy the entry itself imported; the base's accessor cannot see this handle's WeakMap entry. */
  readonly getDefinition: ImportedFlow<unknown>['getDefinition'];
  readonly handlers: readonly TriggerHandler[];
}

export interface ImportedFlow<Authority> {
  readonly handle: FlowHandle;
  readonly getDefinition: <Input = unknown>(handle: FlowHandle) => AuthoredFlowDefinition<Input>;
  readonly surfaceAuthority: Authority;
}

export interface LoadFlowExtensionsOptions<Authority> {
  readonly importFlow: (path: string) => Promise<ImportedFlow<Authority>>;
  readonly sameAuthority: (a: Authority, b: Authority) => boolean;
  readonly versions?: RuntimeVersions;
}

const EXTENSION_HEADER_FIELDS = new Set(['budget', 'tools']);

function unsupported(name: string, what: string): never {
  throw new PluginError('plugin_unsupported', `${name}: ${what} is not composed by this release.`);
}

/** The `{provider, event, action?}` a provider subscription lowers to, or undefined for anything else. */
function subscriptionOf(handler: TriggerHandler): { provider: string; event: string; action?: string } | undefined {
  const trigger = handler.trigger;
  if (trigger.kind !== 'webhook' || trigger.filter === undefined) return undefined;
  const { provider, type, payload } = trigger.filter as { provider?: unknown; type?: unknown; payload?: unknown };
  if (typeof provider !== 'string' || provider !== trigger.name || typeof type !== 'string') return undefined;
  const action = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as { action?: unknown }).action : undefined;
  if (action !== undefined && typeof action !== 'string') return undefined;
  return action === undefined ? { provider, event: type } : { provider, event: type, action };
}

function assertDeclaredSubscription(name: string, manifest: FlowExtensionManifest, handler: TriggerHandler, index: number): void {
  const subscription = subscriptionOf(handler);
  if (handler.trigger.kind === 'schedule') unsupported(name, `handler ${index} (a schedule trigger)`);
  if (subscription === undefined) {
    throw new PluginError('plugin_manifest_invalid', `${name}: handler ${index} is not a provider subscription; extension handlers must be provider triggers declared in flows-plugin.json.`);
  }
  const declared = manifest.triggers.find(t => t.provider === subscription.provider && t.event === subscription.event);
  const covered = declared !== undefined && (subscription.action === undefined ? declared.actions.length === 0 : declared.actions.includes(subscription.action));
  if (!covered) {
    const spelled = `${subscription.provider} ${subscription.event}${subscription.action === undefined ? '' : `.${subscription.action}`}`;
    throw new PluginError('plugin_manifest_invalid', `${name}: handler ${index} subscribes to ${spelled}, which flows-plugin.json does not declare in triggers.`);
  }
}

async function loadOne<Authority>(
  root: string, lock: PluginLockEntry, ref: string,
  base: { readonly definition: AuthoredFlowDefinition; readonly surfaceAuthority: Authority },
  options: LoadFlowExtensionsOptions<Authority>,
): Promise<LoadedFlowExtension> {
  const directory = pluginStoreDirectory(root, lock.name, lock.digest);
  await verifyStoredPlugin(directory, lock.digest);
  const manifestBytes = readFileSync(join(directory, 'flows-plugin.json'));
  if (sha256(manifestBytes) !== lock.manifestSha256) throw new PluginError('plugin_source_drift', `${ref}: flows-plugin.json differs from the lockfile's manifest hash.`);
  let input: unknown;
  try { input = JSON.parse(manifestBytes.toString('utf8')); }
  catch { throw new PluginError('plugin_manifest_invalid', `${ref}: flows-plugin.json is not valid JSON.`); }
  const manifest = validateFlowExtensionManifest(input);
  if (manifest.name !== lock.name || manifest.version !== lock.version) throw new PluginError('plugin_source_drift', `${ref}: manifest names ${manifest.name}@${manifest.version}, lockfile has ${lock.name}@${lock.version}.`);
  assertCompatible(manifest, options.versions ?? runtimeVersions());
  assertBaseCompatible(manifest, { name: base.definition.name });
  if (manifest.extends.hooks.length > 0) unsupported(manifest.name, `hooks (${manifest.extends.hooks.join(', ')})`);
  const baseBudget = base.definition.header.budget;
  const ceiling = manifest.permissions.budget;
  if (ceiling?.dollars !== undefined && typeof baseBudget === 'object' && baseBudget.dollars !== undefined && ceiling.dollars > baseBudget.dollars) {
    throw new PluginError('plugin_incompatible', `${manifest.name} declares a $${ceiling.dollars} budget ceiling above the base flow's $${baseBudget.dollars}.`);
  }
  const entryPath = join(directory, manifest.entry);
  let imported: ImportedFlow<Authority>;
  try { imported = await options.importFlow(entryPath); }
  catch (error) { throw new PluginError('plugin_manifest_invalid', `${ref}: entry ${manifest.entry} did not load: ${error instanceof Error ? error.message : String(error)}`); }
  if (!options.sameAuthority(imported.surfaceAuthority, base.surfaceAuthority)) {
    throw new PluginError('plugin_incompatible', `${manifest.name}: entry resolves a different @relayflows/surface than the base flow.`);
  }
  const definition = imported.getDefinition(imported.handle);
  const foreign = Object.keys(definition.header).filter(key => !EXTENSION_HEADER_FIELDS.has(key));
  if (foreign.length > 0) unsupported(manifest.name, `entry header ${foreign.join(', ')}`);
  if (manifest.extends.handlers && definition.handlers.length === 0) {
    throw new PluginError('plugin_manifest_invalid', `${manifest.name}: extends.handlers is true but ${manifest.entry} declares no .on() handlers.`);
  }
  if (!manifest.extends.handlers && definition.handlers.length > 0) {
    throw new PluginError('plugin_manifest_invalid', `${manifest.name}: ${manifest.entry} declares handlers but extends.handlers is false.`);
  }
  definition.handlers.forEach((handler, index) => assertDeclaredSubscription(manifest.name, manifest, handler, index));
  return Object.freeze({
    name: manifest.name, version: manifest.version, ref, digest: lock.digest, directory, entryPath, manifest,
    handle: imported.handle, getDefinition: imported.getDefinition, handlers: Object.freeze([...definition.handlers]),
  });
}

/** Extensions declared by the project that owns `flowPath`, verified and loaded in lock order; empty when none are declared. */
export async function loadFlowExtensions<Authority>(
  flowPath: string,
  base: { readonly definition: AuthoredFlowDefinition; readonly surfaceAuthority: Authority },
  options: LoadFlowExtensionsOptions<Authority>,
): Promise<readonly LoadedFlowExtension[]> {
  const root = findPluginProject(dirname(flowPath));
  if (root === undefined) return Object.freeze([]);
  const declared = reconcileDeclaredExtensions(root);
  const loaded: LoadedFlowExtension[] = [];
  for (const { ref, entry } of declared) loaded.push(await loadOne(root, entry, ref, base, options));
  return Object.freeze(loaded);
}

/** The base definition with extension handlers appended in lock order; the base's own fields are untouched. */
export function composeDefinition<Input>(base: AuthoredFlowDefinition<Input>, extensions: readonly LoadedFlowExtension[]): AuthoredFlowDefinition<Input> {
  if (extensions.length === 0) return base;
  return Object.freeze({
    ...base,
    handlers: Object.freeze([...base.handlers, ...extensions.flatMap(extension => extension.handlers)]),
  });
}
