import { dirname, join } from 'node:path';
import type { Ctx } from '@relayflows/surface';
import type { AuthoredFlowDefinition, FlowHandle } from './authored-flow.js';
import { sha256 } from './bundle.js';
import { assertBaseCompatible, assertCompatible, runtimeVersions, type RuntimeVersions } from './flow-extension-compat.js';
import { validateFlowExtensionManifest, type FlowExtensionManifest } from './flow-extension-manifest.js';
import { findPluginProject } from './plugin-loader.js';
import { reconcileDeclaredExtensions, type PluginLockEntry } from './plugin-lock.js';
import { PluginError } from './plugin-manifest.js';
import { pluginStoreDirectory, readStoredPluginFiles } from './plugin-store.js';

const JSON_PARSE = JSON.parse;
const ARRAY_IS_ARRAY = Array.isArray;
const JSON_STRINGIFY = JSON.stringify;
const OBJECT_FREEZE = Object.freeze;
const REGEXP_TEST = RegExp.prototype.test;
const STRING_SPLIT = Function.prototype.call.bind(String.prototype.split) as (
  value: string,
  separator: string | RegExp,
) => string[];

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
 *      schedule triggers, non-provider webhooks, gates) is refused;
 *   4. only then is the entry imported, and its handlers are checked against
 *      the manifest's declared triggers — an entry cannot subscribe to more
 *      than it declared.
 * Extensions compose after the base, in lock order; nothing replaces,
 * reorders, or widens a base handler.
 */
type TriggerHandler = AuthoredFlowDefinition['handlers'][number];

export type FlowHook = (f: Ctx, input: unknown) => Promise<boolean>;

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
  readonly hooks: Readonly<Record<string, FlowHook>>;
}

export interface ImportedFlow<Authority> {
  readonly handle: FlowHandle;
  readonly getDefinition: <Input = unknown>(handle: FlowHandle) => AuthoredFlowDefinition<Input>;
  readonly surfaceAuthority: Authority;
  readonly hooks: Readonly<Record<string, FlowHook>>;
}

export interface LoadFlowExtensionsOptions<Authority> {
  readonly importFlow: (path: string) => Promise<ImportedFlow<Authority>>;
  readonly sameAuthority: (a: Authority, b: Authority) => boolean;
  readonly versions?: RuntimeVersions;
}

const EXTENSION_HEADER_FIELDS = new Set(['budget', 'tools']);
const WALLCLOCK_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

function wallclockMs(value: string): number | undefined {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value);
  if (!match) return undefined;
  const unit = match[2] as keyof typeof WALLCLOCK_MS;
  return Number(match[1]) * WALLCLOCK_MS[unit];
}

/** Credentials and servers declared on a flow-extension, probed before the base body starts. */
export async function probeFlowExtension(manifest: FlowExtensionManifest, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  for (const credential of manifest.preflight.credentials) {
    if (!env[credential]?.trim()) throw new PluginError('plugin_credential_missing', `${manifest.name} requires ${credential}.`);
  }
  for (const server of manifest.preflight.servers) {
    try {
      const response = await fetch(server, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      await response.body?.cancel();
      if (!response.ok) throw new Error('unsuccessful response');
    } catch { throw new PluginError('plugin_server_unreachable', `${manifest.name} cannot reach ${server}.`); }
  }
}

function unsupported(name: string, what: string): never {
  throw new PluginError('plugin_unsupported', `${name}: ${what} is not composed by this release.`);
}

/** The `{provider, event, action?}` a provider subscription lowers to, or undefined for anything else. */
function subscriptionOf(handler: TriggerHandler): { provider: string; event: string; action?: string } | undefined {
  const trigger = handler.trigger;
  if (trigger.kind !== 'webhook' || trigger.filter === undefined) return undefined;
  const { provider, type, payload } = trigger.filter as { provider?: unknown; type?: unknown; payload?: unknown };
  if (typeof provider !== 'string' || provider !== trigger.name || typeof type !== 'string') return undefined;
  const action = typeof payload === 'object' && payload !== null && !ARRAY_IS_ARRAY(payload) ? (payload as { action?: unknown }).action : undefined;
  if (action !== undefined && typeof action !== 'string') return undefined;
  return action === undefined ? { provider, event: type } : { provider, event: type, action };
}

/**
 * Server-authenticated integration delivery metadata. This is executor
 * authority, not authored input: a caller must derive it from its verified
 * delivery record and pass it out of band. User-controlled `input.event`
 * objects never become this value.
 */
const HOSTED_EXTENSION_DISPATCH_AUTHORITY = Symbol('hosted-extension-dispatch-authority');

export type HostedExtensionDispatch = {
  readonly [HOSTED_EXTENSION_DISPATCH_AUTHORITY]: true;
  readonly provenance: 'integration-watch';
  readonly provider: string;
  readonly eventType: string;
  readonly deliveryId: string;
};

export type HostedEventIdentity = { readonly provider: string; readonly event: string; readonly action?: string };
const DISPATCH_PROVIDER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DISPATCH_EVENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DISPATCH_DELIVERY = /^[A-Za-z0-9_.:-]{1,200}$/;

function hostedEventIdentity(dispatch: unknown): HostedEventIdentity {
  if (typeof dispatch !== 'object' || dispatch === null || ARRAY_IS_ARRAY(dispatch)) {
    throw new PluginError('plugin_event_unroutable', 'Hosted extension dispatch authority is malformed.');
  }
  const { provenance, provider, eventType, deliveryId } = dispatch as Partial<HostedExtensionDispatch>;
  if ((dispatch as Partial<HostedExtensionDispatch>)[HOSTED_EXTENSION_DISPATCH_AUTHORITY] !== true
    || provenance !== 'integration-watch'
    || typeof provider !== 'string' || !REGEXP_TEST.call(DISPATCH_PROVIDER, provider)
    || typeof deliveryId !== 'string' || !REGEXP_TEST.call(DISPATCH_DELIVERY, deliveryId)
    || typeof eventType !== 'string') {
    throw new PluginError('plugin_event_unroutable', 'Hosted extension dispatch authority is malformed.');
  }
  const parts = STRING_SPLIT(eventType, '.');
  let valid = parts.length === 1 || parts.length === 2;
  for (let index = 0; valid && index < parts.length; index += 1) {
    valid = REGEXP_TEST.call(DISPATCH_EVENT, parts[index]!);
  }
  if (!valid) {
    throw new PluginError('plugin_event_unroutable', `Hosted extension event ${JSON_STRINGIFY(eventType)} is malformed.`);
  }
  return parts.length === 1
    ? { provider, event: parts[0]! }
    : { provider, event: parts[0]!, action: parts[1]! };
}

/** Validate and project branded host authority without making it serializable. */
export function hostedExtensionDispatchIdentity(dispatch: unknown): HostedEventIdentity {
  return OBJECT_FREEZE(hostedEventIdentity(dispatch));
}

/**
 * Brand metadata only after the host has authenticated the integration
 * delivery. The symbol is deliberately not serializable, so copying a direct
 * run's JSON into executor options cannot mint dispatch authority.
 */
export function hostedExtensionDispatchFromVerifiedDelivery(
  delivery: Omit<HostedExtensionDispatch, typeof HOSTED_EXTENSION_DISPATCH_AUTHORITY | 'provenance'>,
): HostedExtensionDispatch {
  const dispatch = OBJECT_FREEZE({
    [HOSTED_EXTENSION_DISPATCH_AUTHORITY]: true as const,
    provenance: 'integration-watch' as const,
    ...delivery,
  });
  hostedEventIdentity(dispatch);
  return dispatch;
}

/**
 * Resolve a server-authenticated delivery to one extension handler. Authored
 * input is deliberately absent from this API: direct runs may contain any
 * JSON shape and cannot opt themselves into extension execution. Overlapping
 * subscriptions fail closed, including a generic event handler overlapping
 * an action-specific handler.
 */
export function extensionHandlerForHostedDispatch(
  dispatch: unknown,
  extensions: readonly Pick<LoadedFlowExtension, 'name' | 'handlers'>[],
): { readonly extension: Pick<LoadedFlowExtension, 'name' | 'handlers'>; readonly handler: TriggerHandler } | undefined {
  if (dispatch === undefined) return undefined;
  const identity = hostedEventIdentity(dispatch);
  const matches: Array<{
    extension: Pick<LoadedFlowExtension, 'name' | 'handlers'>;
    handler: TriggerHandler;
  }> = [];
  for (let extensionIndex = 0; extensionIndex < extensions.length; extensionIndex += 1) {
    const extension = extensions[extensionIndex]!;
    for (let handlerIndex = 0; handlerIndex < extension.handlers.length; handlerIndex += 1) {
      const handler = extension.handlers[handlerIndex]!;
      const subscription = subscriptionOf(handler);
      if (subscription === undefined || subscription.provider !== identity.provider
        || subscription.event !== identity.event) continue;
      if (subscription.action !== undefined && subscription.action !== identity.action) continue;
      matches[matches.length] = { extension, handler };
    }
  }
  if (matches.length > 1) {
    let matchingNames = '';
    for (let index = 0; index < matches.length; index += 1) {
      matchingNames += `${index === 0 ? '' : ', '}${matches[index]!.extension.name}`;
    }
    throw new PluginError(
      'plugin_event_ambiguous',
      `Hosted event ${identity.provider}.${identity.event}${identity.action === undefined ? '' : `.${identity.action}`} matches multiple extension handlers (${matchingNames}).`,
    );
  }
  return matches[0];
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
  const stored = await readStoredPluginFiles(directory, lock.digest);
  const manifestBytes = stored.find(file => file.path === 'flows-plugin.json')?.data;
  if (manifestBytes === undefined) throw new PluginError('plugin_source_drift', `${ref}: flows-plugin.json is missing.`);
  if (sha256(manifestBytes) !== lock.manifestSha256) throw new PluginError('plugin_source_drift', `${ref}: flows-plugin.json differs from the lockfile's manifest hash.`);
  let input: unknown;
  try { input = JSON_PARSE(manifestBytes.toString('utf8')); }
  catch { throw new PluginError('plugin_manifest_invalid', `${ref}: flows-plugin.json is not valid JSON.`); }
  const manifest = validateFlowExtensionManifest(input);
  if (manifest.name !== lock.name || manifest.version !== lock.version) throw new PluginError('plugin_source_drift', `${ref}: manifest names ${manifest.name}@${manifest.version}, lockfile has ${lock.name}@${lock.version}.`);
  assertCompatible(manifest, options.versions ?? runtimeVersions());
  assertBaseCompatible(manifest, { name: base.definition.name, version: base.definition.header.version });
  const baseBudget = base.definition.header.budget;
  const ceiling = manifest.permissions.budget;
  if (ceiling?.dollars !== undefined && typeof baseBudget === 'object' && baseBudget.dollars !== undefined && ceiling.dollars > baseBudget.dollars) {
    throw new PluginError('plugin_incompatible', `${manifest.name} declares a $${ceiling.dollars} budget ceiling above the base flow's $${baseBudget.dollars}.`);
  }
  if (ceiling?.wallclock !== undefined && typeof baseBudget === 'object' && baseBudget.wallclock !== undefined) {
    const pluginMs = wallclockMs(ceiling.wallclock);
    const baseMs = wallclockMs(baseBudget.wallclock);
    if (pluginMs !== undefined && baseMs !== undefined && pluginMs > baseMs) {
      throw new PluginError('plugin_incompatible', `${manifest.name} declares a ${ceiling.wallclock} wallclock ceiling above the base flow's ${baseBudget.wallclock}.`);
    }
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
  const hooks = imported.hooks;
  const exported = Object.keys(hooks).sort();
  const declared = [...manifest.extends.hooks].sort();
  if (exported.join('\0') !== declared.join('\0')) {
    throw new PluginError('plugin_manifest_invalid', `${manifest.name}: extends.hooks [${manifest.extends.hooks.join(', ')}] does not match exported hooks [${exported.join(', ')}].`);
  }
  const baseHooks = base.definition.header.hooks ?? [];
  for (const hook of manifest.extends.hooks) {
    if (!baseHooks.includes(hook)) {
      throw new PluginError('plugin_incompatible', `${manifest.name}: hook ${hook} is not declared by the base flow.`);
    }
  }
  return Object.freeze({
    name: manifest.name, version: manifest.version, ref, digest: lock.digest, directory, entryPath, manifest,
    handle: imported.handle, getDefinition: imported.getDefinition, handlers: Object.freeze([...definition.handlers]),
    hooks,
  });
}

export function parseHooksExport(module: Record<string, unknown>, name: string): Readonly<Record<string, FlowHook>> {
  const exported = module['hooks'];
  if (exported === undefined) return Object.freeze({});
  if (typeof exported !== 'object' || exported === null || Array.isArray(exported)) {
    throw new PluginError('plugin_manifest_invalid', `${name}: hooks export must be a record of functions.`);
  }
  const hooks: Record<string, FlowHook> = {};
  for (const [key, value] of Object.entries(exported)) {
    if (typeof value !== 'function') {
      throw new PluginError('plugin_manifest_invalid', `${name}: hooks.${key} is not a function.`);
    }
    hooks[key] = value as FlowHook;
  }
  return Object.freeze(hooks);
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
