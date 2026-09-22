import { safePath } from './bundle.js';
import type {
  FlowExtensionCompat,
  FlowExtensionManifest,
  FlowExtensionPermissions,
  FlowExtensionTrigger,
} from './flow-extension-manifest.js';
import { snapshotJsonValue } from './json-value.js';
import { frozenHostedPromiseValue } from './hosted-promise-safety.js';
import { PluginError } from './plugin-manifest.js';

const ARRAY_IS_ARRAY = Array.isArray;
const NUMBER_IS_FINITE = Number.isFinite;
const OBJECT_CREATE = Object.create;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_KEYS = Object.keys;
const REGEXP_TEST = Function.prototype.call.bind(RegExp.prototype.test) as (
  regexp: RegExp,
  value: string,
) => boolean;
const STRING_ENDS_WITH = Function.prototype.call.bind(String.prototype.endsWith) as (
  value: string,
  search: string,
) => boolean;
const STRING_STARTS_WITH = Function.prototype.call.bind(String.prototype.startsWith) as (
  value: string,
  search: string,
) => boolean;
const STRING_TRIM = Function.prototype.call.bind(String.prototype.trim) as (value: string) => string;

const TOP_LEVEL = [
  'schema', 'kind', 'name', 'version', 'description', 'source', 'compat', 'entry',
  'extends', 'triggers', 'gates', 'verbs', 'permissions', 'preflight', 'config',
] as const;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WRITE_CLASS = /^[a-z0-9-]+(?::[a-z0-9_-]+)+$/;
const WALLCLOCK = /^\d+(?:ms|s|m|h|d)$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const VERSION_RANGE = /^(?:\*|(?:[\^~]|>=)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?: <\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)?)$/;
const MAX_DESCRIPTION = 500;
const MAX_LIST = 64;

/**
 * Hosted manifests are parsed after authored code may have executed. Keep this
 * projection deliberately narrower than the authoring validator and use only
 * module-captured intrinsics. The only manifest that can launch is separately
 * pinned by exact ref, payload digest, and manifest digest.
 */
export function validateHostedFlowExtensionManifest(input: unknown): FlowExtensionManifest {
  let value: unknown;
  try {
    value = snapshotJsonValue(input, 'hosted plugin manifest');
  } catch {
    return invalid('Hosted plugin manifest must be JSON data.');
  }
  if (!record(value) || !hasOnlyKeys(value, TOP_LEVEL)) return invalid('Expected a hosted flow-extension manifest object.');
  if (value.schema !== 2 || value.kind !== 'flow-extension') return invalid('Hosted flow extensions require schema 2.');
  if (typeof value.name !== 'string' || !matches(NAME, value.name) || STRING_STARTS_WITH(value.name, 'helper-')) {
    return invalid('name must be lowercase kebab-case and must not start with helper-.');
  }
  if (typeof value.version !== 'string' || !matches(VERSION, value.version)) return invalid('version must be semver x.y.z.');
  if (value.description !== undefined
    && (typeof value.description !== 'string' || value.description.length > MAX_DESCRIPTION)) {
    return invalid(`description must be a string of at most ${MAX_DESCRIPTION} characters.`);
  }
  if (value.source !== undefined || value.config !== undefined) {
    throw new PluginError('plugin_unsupported', 'Hosted capability extensions cannot declare source or config metadata.');
  }
  if (typeof value.entry !== 'string' || !STRING_ENDS_WITH(value.entry, '.flow.ts') || !safePath(value.entry)) {
    return invalid('entry must be a plugin-relative .flow.ts path.');
  }
  const extension = extensionShape(value.extends);
  if (!extension.handlers && extension.hooks.length === 0) {
    return invalid('A flow extension must contribute handlers or at least one hook.');
  }
  for (let index = 0; index < 2; index += 1) {
    const field = index === 0 ? 'verbs' : 'gates';
    const at = value[field];
    if (at !== undefined && (!ARRAY_IS_ARRAY(at) || at.length !== 0)) {
      return invalid(`A flow extension declares no ${field}; ship a helper plugin beside it.`);
    }
  }
  const preflight = preflightShape(value.preflight);
  const output = OBJECT_CREATE(null) as Record<string, unknown>;
  output.schema = 2;
  output.kind = 'flow-extension';
  output.name = value.name;
  output.version = value.version;
  if (value.description !== undefined) output.description = value.description;
  output.compat = compatShape(value.compat);
  output.entry = value.entry;
  output.extends = extension;
  output.triggers = triggerShapes(value.triggers ?? []);
  output.permissions = permissionsShape(value.permissions);
  output.preflight = preflight;
  return frozenHostedPromiseValue(output) as unknown as FlowExtensionManifest;
}

function extensionShape(value: unknown): FlowExtensionManifest['extends'] {
  if (!record(value) || !hasOnlyKeys(value, ['handlers', 'hooks', 'verbs', 'gates'])
    || typeof value.handlers !== 'boolean') {
    return invalid('extends expects { handlers: boolean, hooks: [] }.');
  }
  for (let index = 0; index < 2; index += 1) {
    const field = index === 0 ? 'verbs' : 'gates';
    const at = value[field];
    if (at !== undefined && (!ARRAY_IS_ARRAY(at) || at.length !== 0)) {
      return invalid(`A flow extension declares no ${field}; ship a helper plugin beside it.`);
    }
  }
  return OBJECT_FREEZE({ handlers: value.handlers, hooks: stringList(value.hooks ?? [], 'extends.hooks', NAME) });
}

function compatShape(value: unknown): FlowExtensionCompat {
  if (!record(value) || !hasOnlyKeys(value, ['surface', 'sdk', 'base'])
    || typeof value.surface !== 'string' || !matches(VERSION_RANGE, value.surface)
    || typeof value.sdk !== 'string' || !matches(VERSION_RANGE, value.sdk)
    || !ARRAY_IS_ARRAY(value.base) || value.base.length === 0 || value.base.length > MAX_LIST) {
    return invalid('compat expects surface, sdk, and at least one base.');
  }
  const base: Array<{ readonly name: string; readonly version: string }> = [];
  for (let index = 0; index < value.base.length; index += 1) {
    const entry = value.base[index];
    if (!record(entry) || !hasOnlyKeys(entry, ['name', 'version'])
      || typeof entry.name !== 'string' || STRING_TRIM(entry.name).length === 0 || entry.name.length > 100
      || typeof entry.version !== 'string' || !matches(VERSION_RANGE, entry.version)) {
      return invalid('compat.base entries are { name, version range }.');
    }
    for (let prior = 0; prior < base.length; prior += 1) {
      if (base[prior]!.name === entry.name) return invalid('compat.base names a base flow twice.');
    }
    base[base.length] = OBJECT_FREEZE({ name: entry.name, version: entry.version });
  }
  return OBJECT_FREEZE({ surface: value.surface, sdk: value.sdk, base: OBJECT_FREEZE(base) });
}

function triggerShapes(value: unknown): readonly FlowExtensionTrigger[] {
  if (!ARRAY_IS_ARRAY(value) || value.length > MAX_LIST) return invalid('triggers must be a list.');
  const output: FlowExtensionTrigger[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (!record(entry) || !hasOnlyKeys(entry, ['provider', 'event', 'actions'])
      || typeof entry.provider !== 'string' || !matches(PROVIDER, entry.provider)
      || typeof entry.event !== 'string' || !matches(IDENTIFIER, entry.event)) {
      return invalid('triggers entries are { provider, event, actions }.');
    }
    for (let prior = 0; prior < output.length; prior += 1) {
      if (output[prior]!.provider === entry.provider && output[prior]!.event === entry.event) {
        return invalid(`Trigger ${entry.provider}:${entry.event} is declared twice.`);
      }
    }
    output[output.length] = OBJECT_FREEZE({
      provider: entry.provider,
      event: entry.event,
      actions: stringList(entry.actions, `triggers ${entry.provider}.${entry.event} actions`, IDENTIFIER),
    });
  }
  return OBJECT_FREEZE(output);
}

function permissionsShape(value: unknown): FlowExtensionPermissions {
  if (!record(value) || !hasOnlyKeys(value, ['integrations', 'harnesses', 'mcp', 'writes', 'budget'])) {
    return invalid('permissions expects integrations, harnesses, mcp, writes, and optional budget.');
  }
  let budget: FlowExtensionPermissions['budget'];
  if (value.budget !== undefined) {
    if (!record(value.budget) || !hasOnlyKeys(value.budget, ['dollars', 'wallclock'])) {
      return invalid('permissions.budget expects dollars and/or wallclock.');
    }
    if (value.budget.dollars !== undefined
      && (typeof value.budget.dollars !== 'number' || value.budget.dollars <= 0
        || !NUMBER_IS_FINITE(value.budget.dollars))) {
      return invalid('permissions.budget.dollars must be a positive number.');
    }
    if (value.budget.wallclock !== undefined
      && (typeof value.budget.wallclock !== 'string' || !matches(WALLCLOCK, value.budget.wallclock))) {
      return invalid('permissions.budget.wallclock must be a duration such as 45m.');
    }
    const projected = OBJECT_CREATE(null) as { dollars?: number; wallclock?: string };
    if (value.budget.dollars !== undefined) projected.dollars = value.budget.dollars;
    if (value.budget.wallclock !== undefined) projected.wallclock = value.budget.wallclock;
    budget = OBJECT_FREEZE(projected);
  }
  const output = OBJECT_CREATE(null) as Record<string, unknown>;
  output.integrations = stringList(value.integrations, 'permissions.integrations', PROVIDER);
  output.harnesses = stringList(value.harnesses, 'permissions.harnesses', /^[a-z]+$/);
  output.mcp = stringList(value.mcp, 'permissions.mcp', /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
  output.writes = stringList(value.writes, 'permissions.writes', WRITE_CLASS);
  if (budget !== undefined) output.budget = budget;
  return OBJECT_FREEZE(output) as unknown as FlowExtensionPermissions;
}

function preflightShape(value: unknown): FlowExtensionManifest['preflight'] {
  if (!record(value) || !hasOnlyKeys(value, ['credentials', 'servers'])) {
    return invalid('Preflight requires credentials and servers arrays.');
  }
  const servers = stringList(value.servers, 'preflight.servers', /^https?:\/\/\S+$/);
  return OBJECT_FREEZE({
    credentials: stringList(value.credentials, 'preflight.credentials', IDENTIFIER),
    servers,
  });
}

function stringList(value: unknown, what: string, pattern: RegExp): readonly string[] {
  if (!ARRAY_IS_ARRAY(value) || value.length > MAX_LIST) {
    return invalid(`${what} must be a list of at most ${MAX_LIST} strings.`);
  }
  const output: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== 'string' || !matches(pattern, entry)) return invalid(`${what} has an invalid entry.`);
    for (let prior = 0; prior < output.length; prior += 1) {
      if (output[prior] === entry) return invalid(`${what} lists ${entry} twice.`);
    }
    output[output.length] = entry;
  }
  return OBJECT_FREEZE(output);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !ARRAY_IS_ARRAY(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = OBJECT_KEYS(value);
  for (let index = 0; index < keys.length; index += 1) {
    let found = false;
    for (let allowedIndex = 0; allowedIndex < allowed.length; allowedIndex += 1) {
      if (keys[index] === allowed[allowedIndex]) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function matches(pattern: RegExp, value: string): boolean {
  return REGEXP_TEST(pattern, value);
}

function invalid(message: string): never {
  throw new PluginError('plugin_manifest_invalid', message);
}
