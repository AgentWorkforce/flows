import { Ajv } from 'ajv';
import { providerEventTypes } from '@relayflows/surface';
import { FLOW_HARNESSES } from './flow-requirements.js';
import { snapshotJsonValue } from './json-value.js';
import { PluginError, pluginKindOf } from './plugin-manifest.js';
import { safePath } from './bundle.js';
import { SHA, parsePluginSource, type PluginSourceInput } from './plugin-source.js';
import { isVersionRange, parseVersion } from './semver-range.js';

/**
 * Schema 2, `kind: "flow-extension"`: a plugin whose `entry` default-exports
 * `flow()` and contributes handlers, hooks, and gates to a base flow. It is the
 * same `flows-plugin.json` file and the same preflight covenant as a helper
 * plugin (RFC-0001 decision 13); only the kind decides which validator reads it.
 * Helper manifests (`kind` absent) never reach this module.
 *
 * This slice validates and records the declaration. Runtime composition is
 * refused with `plugin_unsupported` (plugin-loader.ts) until the handlers slice.
 */
export interface FlowExtensionTrigger { readonly provider: string; readonly event: string; readonly actions: readonly string[] }
export interface FlowExtensionCompat {
  readonly surface: string;
  readonly sdk: string;
  readonly base: readonly { readonly name: string; readonly version: string }[];
}
export interface FlowExtensionPermissions {
  readonly integrations: readonly string[];
  readonly harnesses: readonly string[];
  readonly mcp: readonly string[];
  /** Declared effect classes, shown for review; not enforced by this runtime (gate 8 / #442). */
  readonly writes: readonly string[];
  readonly budget?: { readonly dollars?: number; readonly wallclock?: string };
}
export interface FlowExtensionManifest {
  readonly schema: 2;
  readonly kind: 'flow-extension';
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  /** Authoring copies may omit it; `flows add` records the resolved origin in the lockfile regardless. */
  readonly source?: PluginSourceInput & { readonly sha?: string };
  readonly compat: FlowExtensionCompat;
  readonly entry: string;
  readonly extends: { readonly handlers: boolean; readonly hooks: readonly string[] };
  readonly triggers: readonly FlowExtensionTrigger[];
  readonly permissions: FlowExtensionPermissions;
  readonly preflight: { readonly credentials: readonly string[]; readonly servers: readonly string[] };
  readonly config?: Record<string, unknown>;
}

const TOP_LEVEL = new Set(['schema', 'kind', 'name', 'version', 'description', 'source', 'compat', 'entry', 'extends', 'triggers', 'gates', 'verbs', 'permissions', 'preflight', 'config']);
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WRITE_CLASS = /^[a-z0-9-]+(?::[a-z0-9_-]+)+$/;
const WALLCLOCK = /^\d+(?:ms|s|m|h|d)$/;
const MAX_DESCRIPTION = 500;
const MAX_LIST = 64;

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const invalid = (message: string): never => { throw new PluginError('plugin_manifest_invalid', message); };

function stringList(value: unknown, what: string, pattern: RegExp): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST) return invalid(`${what} must be a list of at most ${MAX_LIST} strings.`);
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !pattern.test(entry)) return invalid(`${what} has an invalid entry ${JSON.stringify(entry)}.`);
    if (out.includes(entry)) return invalid(`${what} lists ${entry} twice.`);
    out.push(entry);
  }
  return Object.freeze(out);
}

function compat(value: unknown): FlowExtensionCompat {
  if (!object(value) || Object.keys(value).some(k => !['surface', 'sdk', 'base'].includes(k))) return invalid('compat expects surface, sdk, and base.');
  for (const key of ['surface', 'sdk'] as const) {
    if (typeof value[key] !== 'string' || !isVersionRange(value[key])) return invalid(`compat.${key} must be a version range (*, x.y.z, ^x.y.z, ~x.y.z, >=x.y.z [<a.b.c]).`);
  }
  if (!Array.isArray(value.base) || value.base.length === 0 || value.base.length > MAX_LIST) return invalid('compat.base must name at least one base flow.');
  const base = value.base.map(entry => {
    if (!object(entry) || Object.keys(entry).some(k => !['name', 'version'].includes(k))
      || typeof entry.name !== 'string' || entry.name.trim().length === 0 || entry.name.length > 100
      || typeof entry.version !== 'string' || !isVersionRange(entry.version)) return invalid('compat.base entries are { name, version range }.');
    return Object.freeze({ name: entry.name, version: entry.version });
  });
  if (new Set(base.map(b => b.name)).size !== base.length) return invalid('compat.base names a base flow twice.');
  return Object.freeze({ surface: value.surface as string, sdk: value.sdk as string, base: Object.freeze(base) });
}

function triggers(value: unknown): readonly FlowExtensionTrigger[] {
  if (!Array.isArray(value) || value.length > MAX_LIST) return invalid('triggers must be a list.');
  const registry = providerEventTypes as Readonly<Record<string, readonly string[]>>;
  const seen = new Set<string>();
  return Object.freeze(value.map(entry => {
    if (!object(entry) || Object.keys(entry).some(k => !['provider', 'event', 'actions'].includes(k))
      || typeof entry.provider !== 'string' || !PROVIDER.test(entry.provider)
      || typeof entry.event !== 'string' || !IDENTIFIER.test(entry.event)) return invalid('triggers entries are { provider, event, actions }.');
    const actions = stringList(entry.actions, `triggers ${entry.provider}.${entry.event} actions`, IDENTIFIER);
    const known = registry[entry.provider];
    // Fail where ingress would: an event the surface registry cannot lower is
    // refused now, not after deployment on the first real delivery.
    if (known === undefined) throw new PluginError('plugin_event_unroutable', `Trigger provider ${entry.provider} is not in the surface event registry.`);
    const unroutable = (actions.length === 0 ? [entry.event] : actions.map(a => `${entry.event}.${a}`)).filter(type => !known.includes(type));
    if (unroutable.length > 0) throw new PluginError('plugin_event_unroutable', `Trigger ${entry.provider} ${unroutable.join(', ')} is not in the surface event registry.`);
    const key = `${entry.provider}:${entry.event}`;
    if (seen.has(key)) return invalid(`Trigger ${key} is declared twice.`);
    seen.add(key);
    return Object.freeze({ provider: entry.provider, event: entry.event, actions });
  }));
}

function permissions(value: unknown): FlowExtensionPermissions {
  if (!object(value) || Object.keys(value).some(k => !['integrations', 'harnesses', 'mcp', 'writes', 'budget'].includes(k))) {
    return invalid('permissions expects integrations, harnesses, mcp, writes, and optional budget.');
  }
  const harnesses = stringList(value.harnesses, 'permissions.harnesses', /^[a-z]+$/);
  for (const harness of harnesses) if (!(FLOW_HARNESSES as readonly string[]).includes(harness)) return invalid(`permissions.harnesses: unknown harness ${harness}.`);
  let budget: FlowExtensionPermissions['budget'];
  if (value.budget !== undefined) {
    if (!object(value.budget) || Object.keys(value.budget).some(k => !['dollars', 'wallclock'].includes(k))) return invalid('permissions.budget expects dollars and/or wallclock.');
    if (value.budget.dollars !== undefined && (typeof value.budget.dollars !== 'number' || !(value.budget.dollars > 0) || !Number.isFinite(value.budget.dollars))) return invalid('permissions.budget.dollars must be a positive number.');
    if (value.budget.wallclock !== undefined && (typeof value.budget.wallclock !== 'string' || !WALLCLOCK.test(value.budget.wallclock))) return invalid('permissions.budget.wallclock must be a duration such as 45m.');
    budget = Object.freeze({ ...(value.budget.dollars === undefined ? {} : { dollars: value.budget.dollars }), ...(value.budget.wallclock === undefined ? {} : { wallclock: value.budget.wallclock }) });
  }
  return Object.freeze({
    integrations: stringList(value.integrations, 'permissions.integrations', PROVIDER),
    harnesses,
    mcp: stringList(value.mcp, 'permissions.mcp', /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
    writes: stringList(value.writes, 'permissions.writes', WRITE_CLASS),
    ...(budget === undefined ? {} : { budget }),
  });
}

function source(value: unknown): FlowExtensionManifest['source'] {
  if (!object(value) || Object.keys(value).some(k => !['host', 'owner', 'repo', 'sha', 'path'].includes(k))
    || value.host !== 'github' || typeof value.owner !== 'string' || typeof value.repo !== 'string'
    || (value.path !== undefined && typeof value.path !== 'string')
    || (value.sha !== undefined && (typeof value.sha !== 'string' || !SHA.test(value.sha)))) {
    return invalid('source expects { host: "github", owner, repo, path, sha? }.');
  }
  const path = (value.path as string | undefined) ?? '';
  const parsed = parsePluginSource(`github:${value.owner}/${value.repo}@${(value.sha as string | undefined) ?? 'HEAD'}${path === '' ? '' : `#${path}`}`);
  return Object.freeze({ ...parsed, ...(value.sha === undefined ? {} : { sha: value.sha as string }) });
}

export function validateFlowExtensionManifest(input: unknown): FlowExtensionManifest {
  let v: unknown;
  try { v = snapshotJsonValue(input, 'plugin manifest'); }
  catch { return invalid('Plugin manifest must be JSON data.'); }
  if (!object(v)) return invalid('Expected a plugin manifest object.');
  if (pluginKindOf(v) !== 'flow-extension') throw new PluginError('plugin_kind_invalid', 'Expected kind "flow-extension".');
  if (v.schema !== 2) return invalid('A flow-extension manifest is schema 2.');
  const unknown = Object.keys(v).filter(k => !TOP_LEVEL.has(k));
  if (unknown.length > 0) return invalid(`Unknown manifest fields: ${unknown.join(', ')}.`);
  if (!Object.hasOwn(v, 'preflight')) throw new PluginError('plugin_preflight_missing', 'Plugin must declare preflight.');
  if (typeof v.name !== 'string' || !NAME.test(v.name) || v.name.startsWith('helper-')) return invalid('name must be lowercase kebab-case and must not start with helper-.');
  if (typeof v.version !== 'string' || parseVersion(v.version) === undefined) return invalid('version must be semver x.y.z.');
  if (v.description !== undefined && (typeof v.description !== 'string' || v.description.length > MAX_DESCRIPTION)) return invalid(`description must be a string of at most ${MAX_DESCRIPTION} characters.`);
  if (typeof v.entry !== 'string' || !v.entry.endsWith('.flow.ts') || !safePath(v.entry)) return invalid('entry must be a plugin-relative .flow.ts path.');
  if (!object(v.extends) || Object.keys(v.extends).some(k => !['handlers', 'hooks', 'verbs', 'gates'].includes(k)) || typeof v.extends.handlers !== 'boolean') return invalid('extends expects { handlers: boolean, hooks: [] }.');
  const hooks = stringList(v.extends.hooks ?? [], 'extends.hooks', NAME);
  for (const [field, at] of [['verbs', v.extends.verbs], ['gates', v.extends.gates], ['verbs', v.verbs], ['gates', v.gates]] as const) {
    if (at !== undefined && (!Array.isArray(at) || at.length > 0)) return invalid(`A flow extension declares no ${field}; ship a helper plugin beside it.`);
  }
  if (!v.extends.handlers && hooks.length === 0) return invalid('A flow extension must contribute handlers or at least one hook.');
  if (!object(v.preflight) || Object.keys(v.preflight).some(k => !['credentials', 'servers'].includes(k))) return invalid('Preflight requires credentials and servers arrays.');
  const credentials = stringList(v.preflight.credentials, 'preflight.credentials', IDENTIFIER);
  const servers = stringList(v.preflight.servers, 'preflight.servers', /^https?:\/\/\S+$/);
  for (const server of servers) {
    try { if (!['http:', 'https:'].includes(new URL(server).protocol)) return invalid('Servers must be HTTP(S) URLs.'); }
    catch { return invalid('Servers must be HTTP(S) URLs.'); }
  }
  let config: Record<string, unknown> | undefined;
  if (v.config !== undefined) {
    if (!object(v.config)) return invalid('config must be a JSON Schema object.');
    try { new Ajv({ strict: false }).compile(v.config); } catch { return invalid('config is not a valid JSON Schema.'); }
    config = v.config;
  }
  return Object.freeze({
    schema: 2, kind: 'flow-extension', name: v.name, version: v.version,
    ...(v.description === undefined ? {} : { description: v.description }),
    ...(v.source === undefined ? {} : { source: source(v.source) }),
    compat: compat(v.compat), entry: v.entry,
    extends: Object.freeze({ handlers: v.extends.handlers, hooks }),
    triggers: triggers(v.triggers ?? []),
    permissions: permissions(v.permissions),
    preflight: Object.freeze({ credentials, servers }),
    ...(config === undefined ? {} : { config }),
  });
}
