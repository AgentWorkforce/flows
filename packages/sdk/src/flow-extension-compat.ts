import type { FlowExtensionManifest } from './flow-extension-manifest.js';
import { PluginError } from './plugin-manifest.js';
import { satisfiesRange } from './semver-range.js';

const OBJECT_FREEZE = Object.freeze;
// These are release pins, not runtime discovery. Reading package.json here
// would both consult mutable filesystem intrinsics after authored code and
// break a compiled Bun executable, where import.meta.url names the virtual
// executable rather than the installed SDK directory. A regression compares
// both literals with the package manifests so a version bump cannot drift.
const RUNTIME_VERSIONS = OBJECT_FREEZE({
  sdk: '2.0.27',
  surface: '2.0.27',
});

export interface RuntimeVersions { readonly sdk: string; readonly surface: string }

/** The versions a plugin's `compat` is checked against: this SDK and the surface it pins. */
export function runtimeVersions(): RuntimeVersions {
  return RUNTIME_VERSIONS;
}

/** `compat.surface` / `compat.sdk` against the runtime: a miss is a refusal, never a warning. */
export function assertCompatible(manifest: FlowExtensionManifest, versions: RuntimeVersions): void {
  for (const [what, range, actual] of [['surface', manifest.compat.surface, versions.surface], ['sdk', manifest.compat.sdk, versions.sdk]] as const) {
    if (!satisfiesRange(actual, range)) throw new PluginError('plugin_incompatible', `${manifest.name} requires ${what} ${range}; this runtime has ${actual}.`);
  }
}

/**
 * `compat.base` against the flow being extended. `FlowHeader.version` is
 * optional: a base without it matches only `"*"`.
 */
export function assertBaseCompatible(manifest: FlowExtensionManifest, base: { readonly name: string; readonly version?: string }): void {
  const entry = manifest.compat.base.find(b => b.name === base.name);
  if (entry === undefined) {
    throw new PluginError('plugin_incompatible', `${manifest.name} extends ${manifest.compat.base.map(b => b.name).join(', ')}, not "${base.name}".`);
  }
  if (base.version === undefined) {
    if (entry.version !== '*') throw new PluginError('plugin_incompatible', `${manifest.name} requires ${base.name} ${entry.version}, but the base flow declares no version; only "*" can be satisfied.`);
    return;
  }
  if (!satisfiesRange(base.version, entry.version)) throw new PluginError('plugin_incompatible', `${manifest.name} requires ${base.name} ${entry.version}; the base flow is ${base.version}.`);
}
